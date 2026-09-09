import { Logger } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { ConfigService } from '@nestjs/config';

import { RewardsService } from 'contract/rewards.service';
import { JsonService } from 'json/json.service';
import { CompoundVersion } from 'common/types/compound-version';
import { fmtPct } from 'common/utils/fmt-pct';
import { NetworkConfig } from 'network/network.types';
import { RuntimeDbService } from 'indexer/runtime-db.service';
import { OwesExportService } from './owes-export.service';
import { RangesService } from './ranges.service';

@Command({ name: 'owes:generate-v3', description: 'Generate V3 owes' })
export class GenerateOwesV3Command extends CommandRunner {
  private readonly logger = new Logger(GenerateOwesV3Command.name);

  // Paging over users table
  private readonly pageSize = 1000;

  // Multicall chunk size for V3 getRewardOwed (usually heavier than V2)
  private readonly multicallChunkSize = 1000;

  // Parallel networks (keep low; sqlite is one file)
  private readonly maxParallelNetworks = 2;

  constructor(
    private readonly json: JsonService,
    private readonly db: RuntimeDbService,
    private readonly rewards: RewardsService,
    private readonly exp: OwesExportService,
    private readonly config: ConfigService,
    private readonly ranges: RangesService,
  ) {
    super();
  }

  private get networksList(): NetworkConfig[] {
    return this.config
      .getOrThrow<NetworkConfig[]>('networks')
      .filter((n) => n.rewardsCalcEnabled);
  }

  private async runWithConcurrency<T>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<void>,
  ): Promise<void> {
    if (items.length === 0) return;

    const limit = Math.max(1, Math.min(concurrency, items.length));
    let idx = 0;

    const workers = Array.from({ length: limit }, async () => {
      while (true) {
        const current = idx++;
        if (current >= items.length) return;
        await fn(items[current]!);
      }
    });

    await Promise.all(workers);
  }

  private async calcOwesV3(): Promise<{
    owes: Record<string, bigint>;
    incompleteNetworks: string[];
  }> {
    const owes = this.rewards.zeroOwes(CompoundVersion.V3);
    const networks = this.networksList.map((n) => n.network);
    const incompleteNetworks: string[] = [];

    // Snapshot each network at its fixed reward-range endBlock (from
    // ranges.json) instead of the live chain head. getRewardOwed is a live
    // on-chain balance that shrinks whenever a user claims (even dust), so a
    // fixed block is required for reproducible owes. endBlock is inclusive.
    // Resolved before any RPC work, so a gap in ranges.json fails immediately.
    const endBlockByNetwork = await this.ranges.snapshotBlocks(
      CompoundVersion.V3,
      networks,
    );

    const PAGE = this.pageSize;

    await this.runWithConcurrency(
      networks,
      this.maxParallelNetworks,
      async (network) => {
        // Non-null: snapshotBlocks throws unless every network resolved.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const blockTag = endBlockByNetwork.get(network)!;
        const totalUsers = this.db.countUsersForNetwork(
          CompoundVersion.V3,
          network,
        );
        let failedPages = 0;
        this.logger.log(
          `[V3][${network}] owed at block=${blockTag} (ranges.json) users=${totalUsers}`,
        );

        let offset = 0;
        let page = 0;

        while (true) {
          page += 1;

          const pct = fmtPct(
            Math.min(offset, totalUsers),
            Math.max(1, totalUsers),
            2,
          );
          this.logger.verbose(
            `[V3][${network}] page=${page} (${pct}) offset=${offset}/${totalUsers}`,
          );

          const batch = await this.db.fetchUsersForNetwork(
            CompoundVersion.V3,
            network,
            PAGE,
            offset,
          );

          if (batch.length === 0) break;

          try {
            // batch already matches RewardsService UserRewardCall shape:
            // { rewardsAddress, cometAddress, userAddress }
            const owedRows = await this.rewards.owedForUsers({
              version: CompoundVersion.V3,
              network,
              users: batch,
              chunkSize: this.multicallChunkSize,
              blockTag,
            });

            this.db.upsertOwesBatch({
              network,
              version: CompoundVersion.V3,
              rows: owedRows,
            });
          } catch (err) {
            // A skipped page silently lowers the network total, and the number
            // is indistinguishable from a genuine drop in debt. Count it and
            // let the caller refuse to publish, as V2 already does.
            failedPages += 1;
            this.logger.error(
              `[V3][owes][${network}][page=${page}] owedForUsers failed`,
              err as any,
            );
          }

          offset += batch.length;
          if (batch.length < PAGE) break;
        }

        if (failedPages > 0) {
          incompleteNetworks.push(network);
          this.logger.error(
            `[V3][owes][${network}] result is incomplete: ${failedPages} page(s) failed`,
          );
        }
      },
    );

    // Totals are read from DB (no in-loop accumulation).
    const totals = this.db.getOwesTotalsByNetwork(CompoundVersion.V3);
    for (const n of Object.keys(owes)) owes[n] = totals[n] ?? 0n;

    return { owes, incompleteNetworks };
  }

  async run(): Promise<void> {
    try {
      this.logger.log('Generating total owes V3...');

      await this.db.assemble();
      this.db.resetOwes(CompoundVersion.V3);

      const { owes, incompleteNetworks } = await this.calcOwesV3();

      // A degraded RPC yields a snapshot that is silently too low, and CI
      // commits whatever is on disk. Leave the previous artifact in place
      // rather than publishing a number nobody can tell is wrong.
      if (incompleteNetworks.length > 0) {
        throw new Error(
          `refusing to publish incomplete V3 owes for: ${incompleteNetworks.join(
            ', ',
          )}`,
        );
      }

      const owesV3 = this.rewards.formatOwes(owes);
      this.json.writeOwes(owesV3, CompoundVersion.V3);

      this.exp.exportDetailedOwes(CompoundVersion.V3);

      this.logger.log('Generating of totalOwesV3 completed.');
    } catch (error) {
      this.logger.error(
        'An error occurred while generating owes V3:',
        error as any,
      );
      // Fail the CI step instead of leaving a green run behind a stale file.
      process.exitCode = 1;
    } finally {
      try {
        this.db.closeRuntime();
      } catch (error) {
        // The artifact is already on disk by now, so a failed close is not
        // worth failing the run over -- but it should not vanish either.
        this.logger.warn(
          `failed to close the runtime DB: ${(error as Error).message}`,
        );
      }
    }
  }
}

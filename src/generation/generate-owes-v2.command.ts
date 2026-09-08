import { Logger } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { ConfigService } from '@nestjs/config';
import { formatUnits } from 'ethers';

import { RewardsService } from 'contract/rewards.service';
import { JsonService } from 'json/json.service';
import { CompoundVersion } from 'common/types/compound-version';
import { fmtPct } from 'common/utils/fmt-pct';
import { RuntimeDbService } from 'indexer/runtime-db.service';
import { NetworkConfig } from 'network/network.types';
import { OwesExportService } from './owes-export.service';
import {
  V2CompStateService,
  V2MarketRewardBoundary,
  emptyPendingStats,
  isPendingComplete,
} from './v2-comp-state.service';
import { addUserAmount, remainingV2OwedRows } from './v2-owes.math';

@Command({ name: 'owes:generate-v2', description: 'Generate V2 owes' })
export class GenerateOwesV2Command extends CommandRunner {
  private readonly logger = new Logger(GenerateOwesV2Command.name);

  // Paging over users table
  private readonly pageSize = 1000;

  // Parallel networks (keep low; sqlite is one file)
  private readonly maxParallelNetworks = 2;

  private readonly comptrollers: Map<string, string>;

  constructor(
    private readonly json: JsonService,
    private readonly db: RuntimeDbService,
    private readonly rewards: RewardsService,
    private readonly exp: OwesExportService,
    private readonly v2State: V2CompStateService,
    private readonly config: ConfigService,
  ) {
    super();

    this.comptrollers = new Map<string, string>(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.networksList.map((n) => [n.network, n.comptrollerV2!]),
    );
  }

  private get networksList(): NetworkConfig[] {
    return this.config
      .getOrThrow<NetworkConfig[]>('networks')
      .filter((n) => n.comptrollerV2 && n.rewardsCalcEnabled);
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

  private async calcOwesV2(): Promise<{
    owes: Record<string, bigint>;
    incompleteNetworks: string[];
  }> {
    const owes = this.rewards.zeroOwes(CompoundVersion.V2);
    const networks = this.networksList.map((n) => n.network);
    const incompleteNetworks: string[] = [];

    const PAGE = this.pageSize;

    await this.runWithConcurrency(
      networks,
      this.maxParallelNetworks,
      async (network) => {
        const comptroller = this.comptrollers.get(network);

        if (!comptroller) {
          this.logger.warn(`[V2][${network}] No comptroller found in config`);
          return;
        }

        const totalUsers = this.db.countUsersForNetwork(
          CompoundVersion.V2,
          network,
        );
        const blockTag = await this.v2State.latestBlock(network);
        const pendingByUser = new Map<string, bigint>();
        const boundaryCache = new Map<string, V2MarketRewardBoundary>();
        const stats = emptyPendingStats();

        this.logger.log(
          `[V2][${network}] remaining = compAccrued + pending at block=${blockTag} users=${totalUsers}`,
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
            `[V2][${network}][pending] page=${page} (${pct}) offset=${offset}/${totalUsers}`,
          );

          const batch = await this.db.fetchUsersForNetwork(
            CompoundVersion.V2,
            network,
            PAGE,
            offset,
          );

          if (batch.length === 0) break;

          const usersByMarket = new Map<string, string[]>();
          for (const row of batch) {
            const market = row.cometAddress.toLowerCase();
            const users = usersByMarket.get(market);
            if (users) users.push(row.userAddress);
            else usersByMarket.set(market, [row.userAddress]);
          }

          for (const [market, users] of usersByMarket) {
            let boundary: V2MarketRewardBoundary | null =
              boundaryCache.get(market) ?? null;
            if (!boundary) {
              try {
                boundary = await this.v2State.readMarketBoundary({
                  network,
                  comptroller,
                  market,
                  blockTag,
                });
              } catch (err) {
                this.logger.error(
                  `[V2][owes][${network}] market boundary failed market=${market}`,
                  err as any,
                );
                boundary = null;
              }
              // Only successes are cached: caching a transient RPC failure
              // would disable the market for the rest of a multi-hour run.
              if (boundary) boundaryCache.set(market, boundary);
            }
            if (!boundary) {
              stats.skippedUsers += users.length;
              if (!stats.skippedMarkets.includes(market)) {
                stats.skippedMarkets.push(market);
              }
              continue;
            }

            try {
              const pending = await this.v2State.readPendingByUser({
                network,
                comptroller,
                market,
                users,
                stats,
                blockTag,
                boundary,
              });
              for (const [user, amount] of pending) {
                addUserAmount(pendingByUser, user, amount);
              }
            } catch (err) {
              stats.failures += users.length;
              this.logger.error(
                `[V2][owes][${network}][page=${page}] pending failed market=${market}`,
                err as any,
              );
            }
          }

          offset += batch.length;
          if (batch.length < PAGE) break;
        }

        const written = new Set<string>();
        offset = 0;
        page = 0;

        while (true) {
          page += 1;

          const pct = fmtPct(
            Math.min(offset, totalUsers),
            Math.max(1, totalUsers),
            2,
          );
          this.logger.verbose(
            `[V2][${network}][accrued] page=${page} (${pct}) offset=${offset}/${totalUsers}`,
          );

          const batch = await this.db.fetchUsersForNetwork(
            CompoundVersion.V2,
            network,
            PAGE,
            offset,
          );

          if (batch.length === 0) break;

          const users = [
            ...new Set(batch.map((u) => u.userAddress.toLowerCase())),
          ].filter((user) => !written.has(user));

          if (users.length === 0) {
            offset += batch.length;
            if (batch.length < PAGE) break;
            continue;
          }

          try {
            const accruedRows = await this.rewards.owedForUsers({
              version: CompoundVersion.V2,
              network,
              market: comptroller,
              users,
              chunkSize: PAGE,
              includeZero: true,
              blockTag,
            });
            const accruedByUser = new Map(
              accruedRows.map((row) => [
                row.userAddress.toLowerCase(),
                row.owed,
              ]),
            );

            this.db.upsertOwesBatch({
              network,
              version: CompoundVersion.V2,
              rows: remainingV2OwedRows({
                marketAddress: comptroller,
                users,
                accruedByUser,
                pendingByUser,
              }),
            });
            for (const user of users) written.add(user);
          } catch (err) {
            stats.failures += users.length;
            this.logger.error(
              `[V2][owes][${network}][page=${page}] owedForUsers failed`,
              err as any,
            );
          }

          offset += batch.length;
          if (batch.length < PAGE) break;
        }

        let pendingTotal = 0n;
        for (const amount of pendingByUser.values()) pendingTotal += amount;
        this.logger.log(
          `[V2][${network}] pending users=${
            pendingByUser.size
          } pending=${formatUnits(
            pendingTotal,
            18,
          )} COMP pendingRaw=${pendingTotal.toString()} failures=${
            stats.failures
          } anomalies=${stats.anomalies} skippedMarkets=${
            stats.skippedMarkets.length
          } skippedUsers=${stats.skippedUsers}`,
        );

        if (!isPendingComplete(stats)) {
          incompleteNetworks.push(network);
          this.logger.error(
            `[V2][owes][${network}] result is incomplete: ${
              stats.failures
            } failed reads, ${stats.anomalies} anomalies, ${
              stats.skippedUsers
            } users dropped with markets [${stats.skippedMarkets.join(', ')}]`,
          );
        }
      },
    );

    // Totals are read from DB (no in-loop accumulation).
    const totals = this.db.getOwesTotalsByNetwork(CompoundVersion.V2);
    for (const n of Object.keys(owes)) owes[n] = totals[n] ?? 0n;

    return { owes, incompleteNetworks };
  }

  private saveDetailedOwesV2() {
    const writer = this.json.startDetailedOwes(CompoundVersion.V2); // или V3

    const LIMIT = 5000;
    let offset = 0;

    while (true) {
      const page = this.db.fetchOwesPageByVersion({
        version: CompoundVersion.V2, // или V3
        limit: LIMIT,
        offset,
      });

      if (page.length === 0) break;

      // page уже отсортирован по owed DESC (из SQL)
      this.json.appendDetailedOwesBatch(
        writer,
        page.map((r) => ({
          network: r.network,
          market: r.market,
          user: r.user,
          owedDec: r.owed_dec,
        })),
      );

      offset += page.length;
      if (page.length < LIMIT) break;
    }

    const detailedPath = this.json.finishDetailedOwes(writer);
    this.logger.log(`Detailed owes written: ${detailedPath}`);
  }

  async run(): Promise<void> {
    try {
      this.logger.log('Generating total owes V2...');

      await this.db.assemble();
      this.db.resetOwes(CompoundVersion.V2);

      const { owes, incompleteNetworks } = await this.calcOwesV2();

      // A degraded RPC yields a snapshot that is silently too low, and CI
      // commits whatever is on disk. Leave the previous artifact in place
      // rather than publishing a number nobody can tell is wrong.
      if (incompleteNetworks.length > 0) {
        throw new Error(
          `refusing to publish incomplete V2 owes for: ${incompleteNetworks.join(
            ', ',
          )}`,
        );
      }

      const owesV2 = this.rewards.formatOwes(owes);
      this.json.writeOwes(owesV2, CompoundVersion.V2);

      this.exp.exportDetailedOwes(CompoundVersion.V2);

      this.db.closeRuntime();

      this.logger.log('Generating of totalOwesV2 completed.');
    } catch (error) {
      this.logger.error(
        'An error occurred while generating owes V2:',
        error as any,
      );
      // Fail the CI step instead of leaving a green run behind a stale file.
      process.exitCode = 1;
      try {
        this.db.closeRuntime();
      } catch {}
    }
  }
}

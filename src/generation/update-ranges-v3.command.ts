import { Logger } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { NetworkService } from 'network/network.service';
import { ProviderFactory } from 'network/provider.factory';
import { RangeFile } from './period-rewards.types';

/**
 * Fetches the latest block on every V3 chain present in ranges.json and writes
 * the value back into each network's `endBlock`.
 *
 * By default the finalized head (`latest - reorgWindow`) is written so the file
 * stays valid for the downstream reward pipeline, which rejects any endBlock
 * that is not yet finalized. Pass `--head` to write the raw chain head instead.
 */
@Command({
  name: 'ranges:update-v3',
  description:
    'Fetch latest blocks on all V3 chains and update endBlock in ranges.json',
})
export class UpdateRangesV3Command extends CommandRunner {
  private readonly logger = new Logger(UpdateRangesV3Command.name);

  constructor(
    private readonly networks: NetworkService,
    private readonly providers: ProviderFactory,
  ) {
    super();
  }

  public async run(
    _passedParams: string[],
    options?: Record<string, unknown>,
  ): Promise<void> {
    const useRawHead = options?.head === true;
    const fileName = 'ranges.json';
    const rangesPath = join(process.cwd(), fileName);

    const parsed = this.readRanges(rangesPath, fileName);

    if (!Array.isArray(parsed.v3) || parsed.v3.length === 0) {
      this.logger.warn(`${fileName} has no v3 entries; nothing to update.`);
      return;
    }

    this.logger.log(
      `Updating endBlock for ${parsed.v3.length} V3 network(s) using ${
        useRawHead ? 'raw chain head' : 'finalized head (latest - reorgWindow)'
      }...`,
    );

    const results = await Promise.allSettled(
      parsed.v3.map(async (entry) => {
        const config = this.networks.byName(entry.network);
        if (!config) {
          throw new Error(
            `Unknown network in ${fileName}: ${entry.network} (not in networks config)`,
          );
        }
        if (config.chainId !== entry.chainId) {
          throw new Error(
            `chainId mismatch for ${entry.network}: config=${config.chainId} ranges=${entry.chainId}`,
          );
        }

        const provider = this.providers.get(entry.network);
        const head = await provider.getBlockNumber();
        const endBlock = useRawHead
          ? head
          : Math.max(0, head - config.reorgWindow);

        if (endBlock < entry.startBlock) {
          throw new Error(
            `${entry.network}: computed endBlock=${endBlock} < startBlock=${entry.startBlock}`,
          );
        }

        const previous = entry.endBlock;
        entry.endBlock = endBlock;
        return { network: entry.network, head, endBlock, previous };
      }),
    );

    let failures = 0;
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const network = parsed.v3[i]!.network;
      if (result.status === 'fulfilled') {
        const { head, endBlock, previous } = result.value;
        this.logger.log(
          `[${network}] head=${head} endBlock ${previous} -> ${endBlock} (+${
            endBlock - previous
          })`,
        );
      } else {
        failures += 1;
        this.logger.error(
          `[${network}] failed to update: ${
            (result.reason as Error).message
          }`,
        );
      }
    }

    if (failures > 0) {
      throw new Error(
        `Failed to fetch latest block for ${failures} network(s); ranges.json not written.`,
      );
    }

    writeFileSync(rangesPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    this.logger.log(`Wrote updated endBlocks to ${fileName}.`);
  }

  @Option({
    flags: '--head',
    description:
      'Write the raw chain head instead of the finalized head (latest - reorgWindow)',
  })
  public parseHeadOption(): boolean {
    return true;
  }

  private readRanges(rangesPath: string, fileName: string): RangeFile {
    let raw: string;
    try {
      raw = readFileSync(rangesPath, 'utf8');
    } catch (error) {
      throw new Error(
        `Failed to read ${rangesPath}: ${(error as Error).message}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Invalid JSON in ${rangesPath}: ${(error as Error).message}`,
      );
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`${fileName} must contain an object`);
    }
    const value = parsed as Partial<RangeFile>;
    if (!Array.isArray(value.v2) || !Array.isArray(value.v3)) {
      throw new Error(`${fileName} v2 and v3 must be arrays`);
    }

    return value as RangeFile;
  }
}

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CompoundVersion } from 'common/types/compound-version';
import { NetworkConfig } from 'network/network.types';
import { ProviderFactory } from 'network/provider.factory';
import {
  RangeFile,
  RangeFileEntry,
  RangeFileMarketEntry,
  ResolvedBlock,
  ResolvedMarketRewardRange,
  ResolvedRewardRange,
} from './period-rewards.types';

@Injectable()
export class RangesService {
  private readonly rangesPath = join(process.cwd(), 'ranges.json');

  constructor(
    private readonly config: ConfigService,
    private readonly providers: ProviderFactory,
  ) {}

  public async load(version: CompoundVersion): Promise<ResolvedRewardRange[]> {
    const parsed = this.parseFile();
    const versionRanges = parsed[version];
    const networks = this.config.getOrThrow<NetworkConfig[]>('networks');
    const byName = new Map(
      networks.map((network) => [network.network, network]),
    );
    const seen = new Set<string>();
    const selected: Array<{ entry: RangeFileEntry; config: NetworkConfig }> =
      [];

    for (const entry of versionRanges) {
      this.validateEntry(entry, version);
      if (seen.has(entry.network)) {
        throw new Error(`Duplicate network in ranges.json: ${entry.network}`);
      }
      seen.add(entry.network);

      const network = byName.get(entry.network);
      if (!network) {
        throw new Error(`Unknown network in ranges.json: ${entry.network}`);
      }
      if (network.chainId !== entry.chainId) {
        throw new Error(
          `chainId mismatch for ${entry.network}: expected=${network.chainId} actual=${entry.chainId}`,
        );
      }

      const supportsVersion =
        version === CompoundVersion.V2
          ? Boolean(network.comptrollerV2 && network.comp)
          : Boolean(network.configuratorV3 && network.rewardsV3);

      if (network.rewardsCalcEnabled && supportsVersion) {
        selected.push({ entry, config: network });
      }
    }

    if (selected.length === 0) {
      throw new Error(
        `ranges.json has no enabled ${version.toUpperCase()} reward ranges`,
      );
    }

    return Promise.all(
      selected.map(({ entry, config }) => this.resolve(entry, config, version)),
    );
  }

  private parseFile(): RangeFile {
    let raw: string;
    try {
      raw = readFileSync(this.rangesPath, 'utf8');
    } catch (error) {
      throw new Error(
        `Failed to read ${this.rangesPath}: ${(error as Error).message}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Invalid JSON in ${this.rangesPath}: ${(error as Error).message}`,
      );
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('ranges.json must contain an object');
    }
    const value = parsed as Partial<RangeFile>;
    if (!Array.isArray(value.v2) || !Array.isArray(value.v3)) {
      throw new Error('ranges.json v2 and v3 must be arrays');
    }

    return value as RangeFile;
  }

  private validateEntry(entry: RangeFileEntry, version: CompoundVersion): void {
    if (!entry || typeof entry !== 'object') {
      throw new Error('Every ranges.json entry must be an object');
    }
    if (!entry.network || typeof entry.network !== 'string') {
      throw new Error('Every ranges.json entry must have a network');
    }
    for (const [field, value] of [
      ['chainId', entry.chainId],
      ['startBlock', entry.startBlock],
      ['endBlock', entry.endBlock],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(
          `${entry.network}.${field} must be a safe integer >= 0`,
        );
      }
    }
    if (entry.startBlock < 1) {
      throw new Error(
        `${entry.network}.startBlock must be >= 1 because startBlock - 1 is the initial snapshot`,
      );
    }
    if (entry.endBlock < entry.startBlock) {
      throw new Error(`${entry.network}.endBlock must be >= startBlock`);
    }

    if (entry.markets == null) return;
    if (!Array.isArray(entry.markets)) {
      throw new Error(`${entry.network}.markets must be an array`);
    }

    const addresses = new Set<string>();
    const symbols = new Set<string>();
    for (const market of entry.markets) {
      this.validateMarketEntry(entry, market);
      const address = ethers.getAddress(market.address).toLowerCase();
      const symbol = market.symbol.toLowerCase();
      if (addresses.has(address)) {
        throw new Error(
          `Duplicate market address in ranges.json for ${entry.network}: ${market.address}`,
        );
      }
      if (symbols.has(symbol)) {
        throw new Error(
          `Duplicate market symbol in ranges.json for ${entry.network}: ${market.symbol}`,
        );
      }
      addresses.add(address);
      symbols.add(symbol);
    }

    if (entry.markets.length > 0) {
      const earliestMarketStart = Math.min(
        ...entry.markets.map((market) => market.startBlock),
      );
      if (entry.startBlock !== earliestMarketStart) {
        throw new Error(
          `${entry.network}.startBlock must equal the earliest market startBlock (${earliestMarketStart})`,
        );
      }
      if (
        version === CompoundVersion.V2 &&
        entry.markets.some((market) => market.startBlock !== entry.startBlock)
      ) {
        throw new Error(
          `${entry.network}.v2 market startBlock values must equal the network startBlock (${entry.startBlock})`,
        );
      }
    }
  }

  private validateMarketEntry(
    range: RangeFileEntry,
    market: RangeFileMarketEntry,
  ): void {
    if (!market || typeof market !== 'object') {
      throw new Error(`${range.network}.markets entries must be objects`);
    }
    if (!market.symbol || typeof market.symbol !== 'string') {
      throw new Error(`${range.network}.markets entry must have a symbol`);
    }
    if (!market.address || !ethers.isAddress(market.address)) {
      throw new Error(
        `${range.network}.${market.symbol}.address must be a valid address`,
      );
    }
    if (!Number.isSafeInteger(market.startBlock) || market.startBlock < 1) {
      throw new Error(
        `${range.network}.${market.symbol}.startBlock must be a safe integer >= 1`,
      );
    }
    if (
      market.startBlock < range.startBlock ||
      market.startBlock > range.endBlock
    ) {
      throw new Error(
        `${range.network}.${market.symbol}.startBlock must be inside the network range`,
      );
    }
  }

  private async resolve(
    entry: RangeFileEntry,
    config: NetworkConfig,
    version: CompoundVersion,
  ): Promise<ResolvedRewardRange> {
    const provider = this.providers.get(entry.network);
    const head = await provider.getBlockNumber();
    const finalizedHead = Math.max(0, head - config.reorgWindow);
    if (entry.endBlock > finalizedHead) {
      throw new Error(
        `${entry.network}.endBlock=${entry.endBlock} is not finalized; finalizedHead=${finalizedHead}`,
      );
    }

    const blockRequests = new Map<
      number,
      ReturnType<typeof provider.getBlock>
    >();
    const getBlock = (blockNumber: number) => {
      let request = blockRequests.get(blockNumber);
      if (!request) {
        request = provider.getBlock(blockNumber);
        blockRequests.set(blockNumber, request);
      }
      return request;
    };

    const [startBoundary, start, end] = await Promise.all([
      getBlock(entry.startBlock - 1),
      getBlock(entry.startBlock),
      getBlock(entry.endBlock),
    ]);
    if (!startBoundary || !start || !end) {
      throw new Error(`Failed to resolve blocks for ${entry.network}`);
    }

    const toResolved = (block: typeof start): ResolvedBlock => {
      if (!block.hash) throw new Error(`Block ${block.number} has no hash`);
      return {
        number: block.number,
        hash: block.hash,
        timestamp: Number(block.timestamp),
      };
    };

    const markets: ResolvedMarketRewardRange[] = await Promise.all(
      (entry.markets ?? []).map(async (market) => {
        const [marketStartBoundary, marketStart] = await Promise.all([
          getBlock(market.startBlock - 1),
          getBlock(market.startBlock),
        ]);
        if (!marketStartBoundary || !marketStart) {
          throw new Error(
            `Failed to resolve ${entry.network}.${market.symbol} start blocks`,
          );
        }
        return {
          symbol: market.symbol,
          address: ethers.getAddress(market.address),
          startBoundary: toResolved(marketStartBoundary),
          start: toResolved(marketStart),
          end: toResolved(end),
        };
      }),
    );

    return {
      network: entry.network,
      chainId: entry.chainId,
      config,
      startBoundary: toResolved(startBoundary),
      start: toResolved(start),
      end: toResolved(end),
      markets,
    };
  }
}

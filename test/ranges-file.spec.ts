import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ethers } from 'ethers';

import { CompoundVersion } from '../src/common/types/compound-version';
import {
  RangeFile,
  RangeFileMarketEntry,
} from '../src/generation/period-rewards.types';
import { RangesService } from '../src/generation/ranges.service';

describe('ranges.json', () => {
  it('contains checksummed canonical market addresses and network envelopes', () => {
    const ranges = JSON.parse(
      readFileSync(join(process.cwd(), 'ranges.json'), 'utf8'),
    ) as RangeFile;
    const output = JSON.parse(
      readFileSync(join(process.cwd(), 'output.json'), 'utf8'),
    ) as {
      markets: Record<string, Record<string, { contracts: { comet: string } }>>;
    };

    expect(ranges.v2).toHaveLength(1);
    expect(ranges.v2[0]).toEqual(
      expect.objectContaining({ network: 'mainnet', chainId: 1 }),
    );
    expect(ranges.v2[0]!.startBlock).toBeLessThanOrEqual(
      ranges.v2[0]!.endBlock,
    );
    expect(ranges.v2[0]!.markets).toBeUndefined();
    for (const market of ranges.v2[0]!.markets ?? []) {
      expect(ethers.getAddress(market.address)).toBe(market.address);
      expect(market.startBlock).toBe(ranges.v2[0]!.startBlock);
    }
    expect(ranges.v3.length).toBeGreaterThan(0);
    for (const range of ranges.v3) {
      const markets = range.markets as RangeFileMarketEntry[];
      expect(markets.length).toBeGreaterThan(0);
      expect(range.startBlock).toBe(
        Math.min(...markets.map((market) => market.startBlock)),
      );
      for (const market of markets) {
        expect(ethers.getAddress(market.address)).toBe(market.address);
        expect(
          output.markets[range.network]?.[market.symbol]?.contracts.comet,
        ).toBe(market.address);
      }
    }
  });

  it('loads the V2 section independently from V3', async () => {
    const rangesFile = JSON.parse(
      readFileSync(join(process.cwd(), 'ranges.json'), 'utf8'),
    ) as RangeFile;
    const configuredV2Range = rangesFile.v2[0]!;
    const provider = {
      getBlockNumber: jest
        .fn()
        .mockResolvedValue(configuredV2Range.endBlock + 1000),
      getBlock: jest.fn().mockImplementation(async (number: number) => ({
        number,
        hash: `0x${number.toString(16).padStart(64, '0')}`,
        timestamp: number,
      })),
    };
    const config = {
      getOrThrow: jest.fn().mockReturnValue([
        {
          network: 'mainnet',
          chainId: 1,
          reorgWindow: 64,
          comptrollerV2: '0x0000000000000000000000000000000000000001',
          comp: '0x0000000000000000000000000000000000000002',
          rewardsCalcEnabled: true,
        },
      ]),
    };
    const providers = { get: jest.fn().mockReturnValue(provider) };
    const service = new RangesService(config as never, providers as never);

    const [range] = await service.load(CompoundVersion.V2);

    expect(range!.start.number).toBe(configuredV2Range.startBlock);
    expect(range!.end.number).toBe(configuredV2Range.endBlock);
    expect(range!.markets.map((market) => market.address)).toEqual(
      configuredV2Range.markets?.map((market) => market.address) ?? [],
    );
  });

  it('loads ranges-test.json only when test mode is enabled', async () => {
    const defaultFile = JSON.parse(
      readFileSync(join(process.cwd(), 'ranges.json'), 'utf8'),
    ) as RangeFile;
    const testFile = JSON.parse(
      readFileSync(join(process.cwd(), 'ranges-test.json'), 'utf8'),
    ) as RangeFile;
    const provider = {
      getBlockNumber: jest.fn().mockResolvedValue(100_000_000),
      getBlock: jest.fn().mockImplementation(async (number: number) => ({
        number,
        hash: `0x${number.toString(16).padStart(64, '0')}`,
        timestamp: number,
      })),
    };
    const config = {
      getOrThrow: jest.fn().mockReturnValue([
        {
          network: 'mainnet',
          chainId: 1,
          reorgWindow: 64,
          comptrollerV2: '0x0000000000000000000000000000000000000001',
          comp: '0x0000000000000000000000000000000000000002',
          rewardsCalcEnabled: true,
        },
      ]),
    };
    const providers = { get: jest.fn().mockReturnValue(provider) };
    const service = new RangesService(config as never, providers as never);

    const [defaultRange] = await service.load(CompoundVersion.V2);
    const [testRange] = await service.load(CompoundVersion.V2, true);

    expect(defaultRange!.start.number).toBe(defaultFile.v2[0]!.startBlock);
    expect(testRange!.start.number).toBe(testFile.v2[0]!.startBlock);
    expect(testRange!.end.number).toBe(testFile.v2[0]!.endBlock);
    expect(testRange!.markets).toHaveLength(3);
  });
});

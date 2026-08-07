import { ethers } from 'ethers';

import { CompoundVersion } from '../src/common/types/compound-version';
import { ResolvedRewardRange } from '../src/generation/period-rewards.types';
import { V2PeriodRewardsService } from '../src/generation/v2-period-rewards.service';
import { V3PeriodRewardsService } from '../src/generation/v3-period-rewards.service';

const market = ethers.getAddress('0x00000000000000000000000000000000000000a1');
const ignoredMarket = ethers.getAddress(
  '0x00000000000000000000000000000000000000a2',
);
const rewardToken = ethers.getAddress(
  '0x00000000000000000000000000000000000000b2',
);
const oldUser = ethers.getAddress('0x00000000000000000000000000000000000000c3');
const newUser = ethers.getAddress('0x00000000000000000000000000000000000000d4');

const block = (number: number, timestamp: number) => ({
  number,
  hash: `0x${number.toString(16).padStart(64, '0')}`,
  timestamp,
});

describe('period reward start-snapshot pruning', () => {
  it('V3 merges a large network result without overflowing the call stack', async () => {
    const service = new V3PeriodRewardsService({} as never, {} as never);
    const range = {} as ResolvedRewardRange;
    const row = {} as any;
    const networkRows = Array.from({ length: 150_000 }, () => row);
    jest.spyOn(service as any, 'calculateNetwork').mockResolvedValue({
      rows: networkRows,
      userTotals: [],
    });

    const result = await service.calculate([range]);

    expect(result.rows).toHaveLength(networkRows.length);
    expect(result.rows.at(-1)).toBe(row);
  });

  it('V2 rejects an end block before the COMP token deployment', async () => {
    const providers = {
      get: jest.fn().mockReturnValue({
        getCode: jest.fn().mockResolvedValue('0x'),
      }),
    };
    const service = new V2PeriodRewardsService(
      {} as never,
      providers as never,
      {} as never,
    );
    const range = {
      network: 'mainnet',
      chainId: 1,
      config: {} as any,
      startBoundary: block(80, 800),
      start: block(81, 801),
      end: block(90, 900),
      markets: [],
    } satisfies ResolvedRewardRange;

    await expect(
      (service as any).assertRewardTokenDeployed(range, rewardToken),
    ).rejects.toThrow('was not deployed at endBlock=90');
  });

  it('V3 only reads the start snapshot for users seen before the market start', async () => {
    const marketRange = {
      symbol: 'cTESTv3',
      address: market,
      startBoundary: block(99, 1000),
      start: block(100, 1001),
      end: block(200, 2000),
    };
    const range = {
      network: 'base',
      chainId: 8453,
      config: { rewardsV3: rewardToken } as any,
      startBoundary: marketRange.startBoundary,
      start: marketRange.start,
      end: marketRange.end,
      markets: [marketRange],
    } satisfies ResolvedRewardRange;
    const db = {
      getIndexedCursor: jest.fn().mockReturnValue(200),
      listIndexedMarketsForNetwork: jest
        .fn()
        .mockReturnValue([{ marketAddress: market, firstSeenBlock: 50 }]),
      fetchIndexedUsersForNetwork: jest.fn().mockReturnValue([
        { marketAddress: market, userAddress: oldUser, createdAt: 900 },
        { marketAddress: market, userAddress: newUser, createdAt: 1500 },
      ]),
    };
    const service = new V3PeriodRewardsService(db as never, {} as never);
    jest
      .spyOn(service as any, 'readRewardToken')
      .mockResolvedValue(rewardToken);
    jest
      .spyOn(service as any, 'readString')
      .mockImplementation(
        async (_range: unknown, _block: number, target: string) =>
          target.toLowerCase() === market.toLowerCase() ? 'cTESTv3' : 'COMP',
      );
    jest.spyOn(service as any, 'readUint').mockResolvedValue(18n);
    const readSnapshots = jest
      .spyOn(service as any, 'readSnapshots')
      .mockImplementation(
        async (params: { users: string[]; blockTag: number }) =>
          new Map(
            params.users.map((user) => [
              user.toLowerCase(),
              {
                claimed: params.blockTag === 200 ? 20n : 5n,
                owed: params.blockTag === 200 ? 100n : 10n,
              },
            ]),
          ),
      );

    const result = await service.calculate([range]);

    expect(readSnapshots.mock.calls[0]![0].users).toHaveLength(2);
    expect(readSnapshots.mock.calls[1]![0].users).toEqual([oldUser]);
    expect(result.rows.map((row) => row.totalRewardRaw)).toEqual([105n, 120n]);
    expect(result.rows[0]!.marketRange?.start.number).toBe(100);
    expect(result.userTotals).toEqual([
      expect.objectContaining({
        user: oldUser,
        earnedRaw: 105n,
        claimedRaw: 15n,
        remainingRaw: 100n,
        remainingForPeriodRaw: 100n,
      }),
      expect.objectContaining({
        user: newUser,
        earnedRaw: 120n,
        claimedRaw: 20n,
        remainingRaw: 100n,
        remainingForPeriodRaw: 100n,
      }),
    ]);
  });

  it('V2 only reads the start snapshot for users seen before the network start', async () => {
    const marketRange = {
      symbol: 'cTEST',
      address: market,
      startBoundary: block(99, 1000),
      start: block(100, 1001),
      end: block(200, 2000),
    };
    const range = {
      network: 'mainnet',
      chainId: 1,
      config: {
        comptrollerV2: '0x0000000000000000000000000000000000000011',
        comp: rewardToken,
      } as any,
      startBoundary: marketRange.startBoundary,
      start: marketRange.start,
      end: marketRange.end,
      markets: [],
    } satisfies ResolvedRewardRange;
    const db = {
      getIndexedCursor: jest.fn().mockReturnValue(200),
      listIndexedMarketsForNetwork: jest
        .fn()
        .mockReturnValue([{ marketAddress: market, firstSeenBlock: 50 }]),
      fetchIndexedUsersForNetwork: jest.fn().mockReturnValue([
        { marketAddress: market, userAddress: oldUser, createdAt: 900 },
        { marketAddress: market, userAddress: newUser, createdAt: 1500 },
      ]),
    };
    const service = new V2PeriodRewardsService(
      db as never,
      {} as never,
      {} as never,
    );
    jest
      .spyOn(service as any, 'assertRewardTokenDeployed')
      .mockResolvedValue(undefined);
    jest.spyOn(service as any, 'readMetadataString').mockResolvedValue('COMP');
    jest.spyOn(service as any, 'readMetadataUint').mockResolvedValue(18n);
    jest
      .spyOn(service as any, 'readDistributedRewards')
      .mockResolvedValue(new Map());
    jest.spyOn(service as any, 'readMarketSymbol').mockResolvedValue('cTEST');
    jest
      .spyOn(service as any, 'readMarketBoundary')
      .mockImplementation(
        async (
          _range: unknown,
          _comptroller: string,
          _market: string,
          blockTag: number,
        ) => ({
          projectedSupplyIndex: blockTag === 200 ? 2n : 1n,
          projectedBorrowIndex: blockTag === 200 ? 2n : 1n,
          marketBorrowIndex: 1n,
        }),
      );
    const readUserPending = jest
      .spyOn(service as any, 'readUserPending')
      .mockImplementation(
        async (params: { users: string[]; blockTag: number }) =>
          new Map(
            params.users.map((user) => [
              user.toLowerCase(),
              {
                supply: params.blockTag === 200 ? 100n : 10n,
                borrow: 0n,
              },
            ]),
          ),
      );
    jest
      .spyOn(service as any, 'readCompAccrued')
      .mockImplementation(
        async (
          _range: unknown,
          _comptroller: string,
          users: string[],
          blockTag: number,
        ) =>
          new Map(
            users.map((user) => [
              user.toLowerCase(),
              blockTag === 99 ? 10n : 0n,
            ]),
          ),
      );

    const result = await service.calculate([range]);

    expect(readUserPending.mock.calls[0]![0].users).toHaveLength(2);
    expect(readUserPending.mock.calls[1]![0].users).toEqual([oldUser]);
    expect(result.version).toBe(CompoundVersion.V2);
    expect(result.rows.map((row) => row.totalRewardRaw)).toEqual([90n, 100n]);
    expect(result.rows.every((row) => row.market === market)).toBe(true);
    expect(result.userTotals).toEqual([
      expect.objectContaining({
        user: oldUser,
        earnedRaw: 90n,
        claimedRaw: 10n,
        remainingRaw: 100n,
        remainingForPeriodRaw: 90n,
      }),
      expect.objectContaining({
        user: newUser,
        earnedRaw: 100n,
        claimedRaw: 0n,
        remainingRaw: 100n,
        remainingForPeriodRaw: 100n,
      }),
    ]);
  });

  it('V2 market filter excludes unselected markets before RPC snapshots', () => {
    const marketRange = {
      symbol: 'cTEST',
      address: market,
      startBoundary: block(99, 1000),
      start: block(100, 1001),
      end: block(200, 2000),
    };
    const range = {
      network: 'mainnet',
      chainId: 1,
      config: {} as any,
      startBoundary: marketRange.startBoundary,
      start: marketRange.start,
      end: marketRange.end,
      markets: [marketRange],
    } satisfies ResolvedRewardRange;
    const db = {
      fetchIndexedUsersForNetwork: jest.fn().mockReturnValue([
        { marketAddress: market, userAddress: oldUser, createdAt: 900 },
        {
          marketAddress: ignoredMarket,
          userAddress: oldUser,
          createdAt: 900,
        },
      ]),
    };
    const service = new V2PeriodRewardsService(
      db as never,
      {} as never,
      {} as never,
    );

    const filter = (service as any).marketFilter(range);
    const usersByMarket = (service as any).loadUsersByMarket(range, filter);

    expect(Array.from(usersByMarket.keys())).toEqual([market.toLowerCase()]);
  });
});

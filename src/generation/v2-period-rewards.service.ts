import { Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';

import { withRetries } from 'common/helpers/with-retries';
import { CompoundVersion } from 'common/types/compound-version';
import { RuntimeDbService } from 'indexer/runtime-db.service';
import { ProviderFactory } from 'network/provider.factory';
import { HistoricalCallService } from './historical-call.service';
import {
  fifoRemainingForPeriod,
  pendingBorrow,
  pendingSupply,
  periodReward,
  projectBorrowIndex,
  projectSupplyIndex,
} from './period-rewards.math';
import {
  PeriodRewardRow,
  PeriodRewardUserTotal,
  PeriodRewardsResult,
  ResolvedRewardRange,
} from './period-rewards.types';

const COMPTROLLER_ABI = [
  'event DistributedSupplierComp(address indexed cToken, address indexed supplier, uint256 compDelta, uint256 compSupplyIndex)',
  'event DistributedBorrowerComp(address indexed cToken, address indexed borrower, uint256 compDelta, uint256 compBorrowIndex)',
  'function compSupplyState(address) view returns (uint224 index, uint32 blockNumber)',
  'function compBorrowState(address) view returns (uint224 index, uint32 blockNumber)',
  'function compSupplySpeeds(address) view returns (uint256)',
  'function compBorrowSpeeds(address) view returns (uint256)',
  'function compSpeeds(address) view returns (uint256)',
  'function compAccrued(address) view returns (uint256)',
  'function compSupplierIndex(address,address) view returns (uint256)',
  'function compBorrowerIndex(address,address) view returns (uint256)',
];
const CTOKEN_ABI = [
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function totalBorrows() view returns (uint256)',
  'function borrowIndex() view returns (uint256)',
  'function borrowBalanceStored(address) view returns (uint256)',
  'function symbol() view returns (string)',
];
const ERC20_META_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

interface DistributedReward {
  supply: bigint;
  borrow: bigint;
}

interface MarketBoundary {
  projectedSupplyIndex: bigint;
  projectedBorrowIndex: bigint;
  marketBorrowIndex: bigint;
}

interface UserPending {
  supply: bigint;
  borrow: bigint;
}

interface UserTotalAccumulator {
  user: string;
  createdAt: number;
  earnedRaw: bigint;
  pendingBeforeStartRaw: bigint;
  pendingAtEndRaw: bigint;
}

@Injectable()
export class V2PeriodRewardsService {
  private readonly logger = new Logger(V2PeriodRewardsService.name);
  private readonly comptrollerInterface = new ethers.Interface(COMPTROLLER_ABI);
  private readonly cTokenInterface = new ethers.Interface(CTOKEN_ABI);
  private readonly metaInterface = new ethers.Interface(ERC20_META_ABI);
  private readonly pageSize = 5000;

  constructor(
    private readonly db: RuntimeDbService,
    private readonly providers: ProviderFactory,
    private readonly historical: HistoricalCallService,
  ) {}

  public async calculate(
    ranges: ResolvedRewardRange[],
  ): Promise<PeriodRewardsResult> {
    const rows: PeriodRewardRow[] = [];
    const userTotals: PeriodRewardUserTotal[] = [];
    for (const range of ranges) {
      const network = await this.calculateNetwork(range);
      rows.push(...network.rows);
      userTotals.push(...network.userTotals);
    }
    return { version: CompoundVersion.V2, ranges, rows, userTotals };
  }

  private async calculateNetwork(range: ResolvedRewardRange): Promise<{
    rows: PeriodRewardRow[];
    userTotals: PeriodRewardUserTotal[];
  }> {
    const comptroller = range.config.comptrollerV2;
    const rewardToken = range.config.comp;
    if (!comptroller || !rewardToken) {
      throw new Error(`V2 config is incomplete for ${range.network}`);
    }
    this.assertIndexedThrough(range);
    await this.assertRewardTokenDeployed(range, rewardToken);

    const [rewardTokenSymbol, rewardTokenDecimals] = await Promise.all([
      this.readMetadataString(range, rewardToken, 'symbol'),
      this.readMetadataUint(range, rewardToken, 'decimals'),
    ]);
    const marketFilter = this.marketFilter(range);
    const usersByMarket = this.loadUsersByMarket(range, marketFilter);
    const distributed = await this.readDistributedRewards(
      range,
      comptroller,
      usersByMarket,
      marketFilter,
    );
    const firstSeenByMarket = new Map(
      this.db
        .listIndexedMarketsForNetwork(CompoundVersion.V2, range.network)
        .map((market) => [
          market.marketAddress.toLowerCase(),
          market.firstSeenBlock,
        ]),
    );
    if (marketFilter) {
      const missingMarkets = Array.from(marketFilter.keys()).filter(
        (market) => !firstSeenByMarket.has(market),
      );
      if (missingMarkets.length > 0) {
        throw new Error(
          `[V2][${
            range.network
          }] selected markets are not indexed: ${missingMarkets.join(', ')}`,
        );
      }
    }
    const out: PeriodRewardRow[] = [];
    const totalsByUser = new Map<string, UserTotalAccumulator>();
    let hasStartRewardBoundary = false;

    this.logger.log(
      `[V2][${range.network}] period=${range.start.number}-${
        range.end.number
      } markets=${usersByMarket.size} partial=${Boolean(marketFilter)}`,
    );

    for (const [marketLower, indexedUsers] of usersByMarket) {
      const market = ethers.getAddress(marketLower);
      const firstSeen = firstSeenByMarket.get(marketLower) ?? 0;
      if (firstSeen > range.end.number) continue;

      const marketSymbol = await this.readMarketSymbol(range, market);
      const selectedMarket = marketFilter?.get(marketLower);
      if (selectedMarket && selectedMarket.symbol !== marketSymbol) {
        throw new Error(
          `[V2][${range.network}] selected market symbol mismatch address=${market} expected=${selectedMarket.symbol} actual=${marketSymbol}`,
        );
      }
      const endBoundary = await this.readMarketBoundary(
        range,
        comptroller,
        market,
        range.end.number,
      );
      if (!endBoundary) {
        throw new Error(
          `[V2][${range.network}][${range.end.number}] reward boundary is missing market=${market}`,
        );
      }
      const startBoundary =
        firstSeen > range.startBoundary.number
          ? null
          : await this.readMarketBoundary(
              range,
              comptroller,
              market,
              range.startBoundary.number,
            );
      hasStartRewardBoundary ||= startBoundary !== null;
      const userEntries = Array.from(indexedUsers.entries()).map(
        ([user, createdAt]) => ({ user: ethers.getAddress(user), createdAt }),
      );
      const users = userEntries.map(({ user }) => user);
      const startUsers = userEntries
        .filter(({ createdAt }) => createdAt <= range.startBoundary.timestamp)
        .map(({ user }) => user);
      this.logger.log(
        `[V2][${range.network}][${marketSymbol}] users=${
          users.length
        } startSnapshots=${startUsers.length} savedStartSnapshots=${
          users.length - startUsers.length
        }`,
      );
      const [pendingAtEnd, pendingBeforeStart] = await Promise.all([
        this.readUserPending({
          range,
          comptroller,
          market,
          users,
          blockTag: range.end.number,
          boundary: endBoundary,
        }),
        startBoundary
          ? this.readUserPending({
              range,
              comptroller,
              market,
              users: startUsers,
              blockTag: range.startBoundary.number,
              boundary: startBoundary,
            })
          : Promise.resolve(new Map<string, UserPending>()),
      ]);

      for (const { user, createdAt } of userEntries) {
        const key = this.rewardKey(market, user);
        const events = distributed.get(key) ?? { supply: 0n, borrow: 0n };
        const end = pendingAtEnd.get(user.toLowerCase()) ?? {
          supply: 0n,
          borrow: 0n,
        };
        const start = pendingBeforeStart.get(user.toLowerCase()) ?? {
          supply: 0n,
          borrow: 0n,
        };

        let supplyRewardRaw: bigint;
        let borrowRewardRaw: bigint;
        try {
          supplyRewardRaw = periodReward({
            distributedInRange: events.supply,
            pendingAtEnd: end.supply,
            pendingBeforeStart: start.supply,
            marketIndexAtEnd: endBoundary.projectedSupplyIndex,
            marketIndexBeforeStart: startBoundary?.projectedSupplyIndex,
          });
          borrowRewardRaw = periodReward({
            distributedInRange: events.borrow,
            pendingAtEnd: end.borrow,
            pendingBeforeStart: start.borrow,
            marketIndexAtEnd: endBoundary.projectedBorrowIndex,
            marketIndexBeforeStart: startBoundary?.projectedBorrowIndex,
          });
        } catch (error) {
          throw new Error(
            `[V2][${range.network}] ${market}/${user}: ${
              (error as Error).message
            }`,
          );
        }
        const totalRewardRaw = supplyRewardRaw + borrowRewardRaw;
        const userLower = user.toLowerCase();
        const total = totalsByUser.get(userLower) ?? {
          user,
          createdAt,
          earnedRaw: 0n,
          pendingBeforeStartRaw: 0n,
          pendingAtEndRaw: 0n,
        };
        total.createdAt = Math.min(total.createdAt, createdAt);
        total.earnedRaw += totalRewardRaw;
        total.pendingBeforeStartRaw += start.supply + start.borrow;
        total.pendingAtEndRaw += end.supply + end.borrow;
        totalsByUser.set(userLower, total);
        if (totalRewardRaw === 0n) continue;

        out.push({
          version: CompoundVersion.V2,
          network: range.network,
          chainId: range.chainId,
          range,
          marketRange: selectedMarket,
          market,
          marketSymbol,
          rewardToken: ethers.getAddress(rewardToken),
          rewardTokenSymbol,
          rewardTokenDecimals: Number(rewardTokenDecimals),
          user,
          supplyRewardRaw,
          borrowRewardRaw,
          totalRewardRaw,
        });
      }
    }

    const partial = marketFilter !== null;
    const users = Array.from(totalsByUser.values()).map((total) => total.user);
    const startUsers =
      partial || !hasStartRewardBoundary
        ? []
        : Array.from(totalsByUser.values())
            .filter((total) => total.createdAt <= range.startBoundary.timestamp)
            .map((total) => total.user);
    const [compAccruedAtEnd, compAccruedBeforeStart] = await Promise.all([
      this.readCompAccrued(range, comptroller, users, range.end.number),
      startUsers.length > 0
        ? this.readCompAccrued(
            range,
            comptroller,
            startUsers,
            range.startBoundary.number,
          )
        : Promise.resolve(new Map<string, bigint>()),
    ]);
    const userTotals = Array.from(totalsByUser.values())
      .map((total) => {
        const userLower = total.user.toLowerCase();
        const debtBeforeStart =
          (compAccruedBeforeStart.get(userLower) ?? 0n) +
          total.pendingBeforeStartRaw;
        const remainingRaw =
          (compAccruedAtEnd.get(userLower) ?? 0n) + total.pendingAtEndRaw;
        const claimedRaw = partial
          ? null
          : debtBeforeStart + total.earnedRaw - remainingRaw;
        if (claimedRaw !== null && claimedRaw < 0n) {
          throw new Error(
            `[V2][${range.network}] negative claimed invariant user=${total.user} startDebt=${debtBeforeStart} earned=${total.earnedRaw} remaining=${remainingRaw}`,
          );
        }
        const remainingForPeriodRaw = fifoRemainingForPeriod({
          earned: total.earnedRaw,
          remaining: remainingRaw,
        });
        return {
          version: CompoundVersion.V2,
          network: range.network,
          chainId: range.chainId,
          range,
          rewardToken: ethers.getAddress(rewardToken),
          rewardTokenSymbol,
          rewardTokenDecimals: Number(rewardTokenDecimals),
          user: total.user,
          earnedRaw: total.earnedRaw,
          claimedRaw,
          remainingRaw,
          remainingForPeriodRaw,
        };
      })
      .filter(
        (total) =>
          total.earnedRaw > 0n ||
          (total.claimedRaw ?? 0n) > 0n ||
          total.remainingRaw > 0n,
      );

    return { rows: out, userTotals };
  }

  private loadUsersByMarket(
    range: ResolvedRewardRange,
    marketFilter: Map<string, ResolvedRewardRange['markets'][number]> | null,
  ): Map<string, Map<string, number>> {
    const result = new Map<string, Map<string, number>>();
    let offset = 0;
    while (true) {
      const page = this.db.fetchIndexedUsersForNetwork(
        CompoundVersion.V2,
        range.network,
        this.pageSize,
        offset,
      );
      for (const row of page) {
        if (row.createdAt > range.end.timestamp) continue;
        const market = row.marketAddress.toLowerCase();
        if (marketFilter && !marketFilter.has(market)) continue;
        let usersByCreatedAt = result.get(market);
        if (!usersByCreatedAt) {
          usersByCreatedAt = new Map<string, number>();
          result.set(market, usersByCreatedAt);
        }
        const user = row.userAddress.toLowerCase();
        const current = usersByCreatedAt.get(user);
        if (current == null || row.createdAt < current) {
          usersByCreatedAt.set(user, row.createdAt);
        }
      }
      offset += page.length;
      if (page.length < this.pageSize) break;
    }
    return result;
  }

  private async readDistributedRewards(
    range: ResolvedRewardRange,
    comptroller: string,
    usersByMarket: Map<string, Map<string, number>>,
    marketFilter: Map<string, ResolvedRewardRange['markets'][number]> | null,
  ): Promise<Map<string, DistributedReward>> {
    const supplierTopic = this.comptrollerInterface.getEvent(
      'DistributedSupplierComp',
    )!.topicHash;
    const borrowerTopic = this.comptrollerInterface.getEvent(
      'DistributedBorrowerComp',
    )!.topicHash;
    const logs = await this.getLogsAdaptive(range, {
      address: comptroller,
      fromBlock: range.start.number,
      toBlock: range.end.number,
      topics: [[supplierTopic, borrowerTopic]],
    });
    const rewards = new Map<string, DistributedReward>();

    for (const log of logs) {
      const parsed = this.comptrollerInterface.parseLog({
        data: log.data,
        topics: [...log.topics],
      });
      if (!parsed) continue;
      const isSupply = parsed.name === 'DistributedSupplierComp';
      const market = ethers.getAddress(String(parsed.args[0]));
      const user = ethers.getAddress(String(parsed.args[1]));
      if (marketFilter && !marketFilter.has(market.toLowerCase())) continue;
      const delta = BigInt(parsed.args[2]);
      const key = this.rewardKey(market, user);
      const current = rewards.get(key) ?? { supply: 0n, borrow: 0n };
      if (isSupply) current.supply += delta;
      else current.borrow += delta;
      rewards.set(key, current);

      const marketLower = market.toLowerCase();
      let usersByCreatedAt = usersByMarket.get(marketLower);
      if (!usersByCreatedAt) {
        usersByCreatedAt = new Map<string, number>();
        usersByMarket.set(marketLower, usersByCreatedAt);
      }
      const userLower = user.toLowerCase();
      if (!usersByCreatedAt.has(userLower)) {
        // Conservatively include the start snapshot if an event user was not
        // present in the indexed users table.
        usersByCreatedAt.set(userLower, range.startBoundary.timestamp);
      }
    }

    return rewards;
  }

  private marketFilter(
    range: ResolvedRewardRange,
  ): Map<string, ResolvedRewardRange['markets'][number]> | null {
    if (range.markets.length === 0) return null;
    return new Map(
      range.markets.map((market) => [market.address.toLowerCase(), market]),
    );
  }

  private async readMarketBoundary(
    range: ResolvedRewardRange,
    comptroller: string,
    market: string,
    blockTag: number,
  ): Promise<MarketBoundary | null> {
    const calls = [
      {
        target: comptroller,
        callData: this.comptrollerInterface.encodeFunctionData(
          'compSupplyState',
          [market],
        ),
      },
      {
        target: comptroller,
        callData: this.comptrollerInterface.encodeFunctionData(
          'compBorrowState',
          [market],
        ),
      },
      {
        target: comptroller,
        callData: this.comptrollerInterface.encodeFunctionData(
          'compSupplySpeeds',
          [market],
        ),
      },
      {
        target: comptroller,
        callData: this.comptrollerInterface.encodeFunctionData(
          'compBorrowSpeeds',
          [market],
        ),
      },
      {
        target: comptroller,
        callData: this.comptrollerInterface.encodeFunctionData('compSpeeds', [
          market,
        ]),
      },
      {
        target: market,
        callData: this.cTokenInterface.encodeFunctionData('totalSupply'),
      },
      {
        target: market,
        callData: this.cTokenInterface.encodeFunctionData('totalBorrows'),
      },
      {
        target: market,
        callData: this.cTokenInterface.encodeFunctionData('borrowIndex'),
      },
    ];
    const results = await this.historical.callMany({
      network: range.network,
      blockTag,
      calls,
    });
    if (!results[0]?.success || !results[1]?.success) return null;
    if (!results[5]?.success || !results[6]?.success || !results[7]?.success) {
      throw new Error(
        `[V2][${range.network}][${blockTag}] cToken state failed market=${market}`,
      );
    }
    if (
      (!results[2]?.success && !results[4]?.success) ||
      (!results[3]?.success && !results[4]?.success)
    ) {
      throw new Error(
        `[V2][${range.network}][${blockTag}] reward speed state failed market=${market}`,
      );
    }

    const supplyState = this.comptrollerInterface.decodeFunctionResult(
      'compSupplyState',
      results[0].returnData,
    );
    const borrowState = this.comptrollerInterface.decodeFunctionResult(
      'compBorrowState',
      results[1].returnData,
    );
    const legacySpeed = results[4]?.success
      ? this.decodeUint(
          this.comptrollerInterface,
          'compSpeeds',
          results[4].returnData,
        )
      : 0n;
    const supplySpeed = results[2]?.success
      ? this.decodeUint(
          this.comptrollerInterface,
          'compSupplySpeeds',
          results[2].returnData,
        )
      : legacySpeed;
    const borrowSpeed = results[3]?.success
      ? this.decodeUint(
          this.comptrollerInterface,
          'compBorrowSpeeds',
          results[3].returnData,
        )
      : legacySpeed;
    const totalSupply = this.decodeUint(
      this.cTokenInterface,
      'totalSupply',
      results[5].returnData,
    );
    const totalBorrows = this.decodeUint(
      this.cTokenInterface,
      'totalBorrows',
      results[6].returnData,
    );
    const marketBorrowIndex = this.decodeUint(
      this.cTokenInterface,
      'borrowIndex',
      results[7].returnData,
    );

    return {
      projectedSupplyIndex: projectSupplyIndex({
        storedIndex: BigInt(supplyState[0]),
        stateBlock: BigInt(supplyState[1]),
        boundaryBlock: BigInt(blockTag),
        speed: supplySpeed,
        totalSupply,
      }),
      projectedBorrowIndex: projectBorrowIndex({
        storedIndex: BigInt(borrowState[0]),
        stateBlock: BigInt(borrowState[1]),
        boundaryBlock: BigInt(blockTag),
        speed: borrowSpeed,
        totalBorrows,
        marketBorrowIndex,
      }),
      marketBorrowIndex,
    };
  }

  private async readUserPending(params: {
    range: ResolvedRewardRange;
    comptroller: string;
    market: string;
    users: string[];
    blockTag: number;
    boundary: MarketBoundary | null;
  }): Promise<Map<string, UserPending>> {
    if (!params.boundary) return new Map<string, UserPending>();
    const calls = params.users.flatMap((user) => [
      {
        target: params.comptroller,
        callData: this.comptrollerInterface.encodeFunctionData(
          'compSupplierIndex',
          [params.market, user],
        ),
      },
      {
        target: params.market,
        callData: this.cTokenInterface.encodeFunctionData('balanceOf', [user]),
      },
      {
        target: params.comptroller,
        callData: this.comptrollerInterface.encodeFunctionData(
          'compBorrowerIndex',
          [params.market, user],
        ),
      },
      {
        target: params.market,
        callData: this.cTokenInterface.encodeFunctionData(
          'borrowBalanceStored',
          [user],
        ),
      },
    ]);
    const results = await this.historical.callMany({
      network: params.range.network,
      blockTag: params.blockTag,
      calls,
    });
    const out = new Map<string, UserPending>();

    for (let i = 0; i < params.users.length; i++) {
      const user = params.users[i]!;
      const chunk = results.slice(i * 4, i * 4 + 4);
      const callNames = [
        'compSupplierIndex',
        'balanceOf',
        'compBorrowerIndex',
        'borrowBalanceStored',
      ];
      const failures = chunk.flatMap((result, index) =>
        result?.success
          ? []
          : [
              `${callNames[index] ?? `call#${index}`}${
                result?.error ? ` (${result.error})` : ''
              }`,
            ],
      );
      if (failures.length > 0) {
        throw new Error(
          `[V2][${params.range.network}][${
            params.blockTag
          }] user state failed market=${
            params.market
          } user=${user} calls=${failures.join(', ')}`,
        );
      }
      const supplierIndex = this.decodeUint(
        this.comptrollerInterface,
        'compSupplierIndex',
        chunk[0]!.returnData,
      );
      const balance = this.decodeUint(
        this.cTokenInterface,
        'balanceOf',
        chunk[1]!.returnData,
      );
      const borrowerIndex = this.decodeUint(
        this.comptrollerInterface,
        'compBorrowerIndex',
        chunk[2]!.returnData,
      );
      const borrowBalance = this.decodeUint(
        this.cTokenInterface,
        'borrowBalanceStored',
        chunk[3]!.returnData,
      );
      out.set(user.toLowerCase(), {
        supply: pendingSupply({
          projectedIndex: params.boundary.projectedSupplyIndex,
          userIndex: supplierIndex,
          userBalance: balance,
        }),
        borrow: pendingBorrow({
          projectedIndex: params.boundary.projectedBorrowIndex,
          userIndex: borrowerIndex,
          borrowBalanceStored: borrowBalance,
          marketBorrowIndex: params.boundary.marketBorrowIndex,
        }),
      });
    }

    return out;
  }

  private async readCompAccrued(
    range: ResolvedRewardRange,
    comptroller: string,
    users: string[],
    blockTag: number,
  ): Promise<Map<string, bigint>> {
    if (users.length === 0) return new Map<string, bigint>();
    const results = await this.historical.callMany({
      network: range.network,
      blockTag,
      calls: users.map((user) => ({
        target: comptroller,
        callData: this.comptrollerInterface.encodeFunctionData('compAccrued', [
          user,
        ]),
      })),
    });
    const out = new Map<string, bigint>();
    for (let i = 0; i < users.length; i++) {
      const result = results[i];
      if (!result?.success) {
        throw new Error(
          `[V2][${range.network}][${blockTag}] compAccrued failed user=${
            users[i]
          }${result?.error ? ` (${result.error})` : ''}`,
        );
      }
      out.set(
        users[i]!.toLowerCase(),
        this.decodeUint(
          this.comptrollerInterface,
          'compAccrued',
          result.returnData,
        ),
      );
    }
    return out;
  }

  private async getLogsAdaptive(
    range: ResolvedRewardRange,
    filter: {
      address: string;
      fromBlock: number;
      toBlock: number;
      topics: Array<string | string[] | null>;
    },
  ): Promise<ethers.Log[]> {
    const provider = this.providers.get(range.network);
    const out: ethers.Log[] = [];
    const stack: Array<[number, number]> = [[filter.fromBlock, filter.toBlock]];

    while (stack.length) {
      const [fromBlock, toBlock] = stack.pop()!;
      try {
        const logs = await withRetries(
          () =>
            provider.getLogs({
              address: filter.address,
              fromBlock,
              toBlock,
              topics: filter.topics,
            }),
          { attempts: 3, baseDelayMs: 250 },
        );
        out.push(...logs);
      } catch (error) {
        if (fromBlock >= toBlock) throw error;
        const middle = Math.floor((fromBlock + toBlock) / 2);
        stack.push([fromBlock, middle], [middle + 1, toBlock]);
      }
    }

    return out;
  }

  private async readMarketSymbol(
    range: ResolvedRewardRange,
    market: string,
  ): Promise<string> {
    const [result] = await this.historical.callMany({
      network: range.network,
      blockTag: range.end.number,
      calls: [
        {
          target: market,
          callData: this.cTokenInterface.encodeFunctionData('symbol'),
        },
      ],
    });
    if (!result?.success) return market;
    return String(
      this.cTokenInterface.decodeFunctionResult('symbol', result.returnData)[0],
    );
  }

  private async assertRewardTokenDeployed(
    range: ResolvedRewardRange,
    rewardToken: string,
  ): Promise<void> {
    const code = await withRetries(
      () =>
        this.providers
          .get(range.network)
          .getCode(rewardToken, range.end.number),
      { attempts: 3, baseDelayMs: 250 },
    );
    if (code === '0x') {
      throw new Error(
        `[V2][${range.network}] reward token ${ethers.getAddress(
          rewardToken,
        )} was not deployed at endBlock=${
          range.end.number
        }; choose a range after the COMP deployment`,
      );
    }
  }

  private async readMetadataString(
    range: ResolvedRewardRange,
    token: string,
    functionName: 'symbol',
  ): Promise<string> {
    const [result] = await this.historical.callMany({
      network: range.network,
      blockTag: range.end.number,
      calls: [
        {
          target: token,
          callData: this.metaInterface.encodeFunctionData(functionName),
        },
      ],
    });
    if (!result?.success)
      throw new Error(`${functionName} failed for ${token}`);
    return String(
      this.metaInterface.decodeFunctionResult(
        functionName,
        result.returnData,
      )[0],
    );
  }

  private async readMetadataUint(
    range: ResolvedRewardRange,
    token: string,
    functionName: 'decimals',
  ): Promise<bigint> {
    const [result] = await this.historical.callMany({
      network: range.network,
      blockTag: range.end.number,
      calls: [
        {
          target: token,
          callData: this.metaInterface.encodeFunctionData(functionName),
        },
      ],
    });
    if (!result?.success)
      throw new Error(`${functionName} failed for ${token}`);
    return BigInt(
      this.metaInterface.decodeFunctionResult(
        functionName,
        result.returnData,
      )[0],
    );
  }

  private decodeUint(
    iface: ethers.Interface,
    functionName: string,
    data: string,
  ): bigint {
    return BigInt(iface.decodeFunctionResult(functionName, data)[0]);
  }

  private rewardKey(market: string, user: string): string {
    return `${market.toLowerCase()}:${user.toLowerCase()}`;
  }

  private assertIndexedThrough(range: ResolvedRewardRange): void {
    const cursor = this.db.getIndexedCursor(range.network);
    if (cursor == null || cursor < range.end.number) {
      throw new Error(
        `[V2][${range.network}] user index is stale: cursor=${cursor} endBlock=${range.end.number}`,
      );
    }
  }
}

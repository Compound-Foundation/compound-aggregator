import { Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';

import { CompoundVersion } from 'common/types/compound-version';
import { RuntimeDbService } from 'indexer/runtime-db.service';
import { HistoricalCallService } from './historical-call.service';
import {
  PeriodRewardRow,
  PeriodRewardUserTotal,
  PeriodRewardsResult,
  ResolvedMarketRewardRange,
  ResolvedRewardRange,
} from './period-rewards.types';

const REWARDS_ABI = [
  'function rewardConfig(address comet) view returns (address token)',
  'function rewardsClaimed(address comet, address account) view returns (uint256)',
  'function getRewardOwed(address comet, address account) returns (tuple(address token, uint256 owed))',
];
const ERC20_META_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

interface V3Snapshot {
  claimed: bigint;
  owed: bigint;
}

@Injectable()
export class V3PeriodRewardsService {
  private readonly logger = new Logger(V3PeriodRewardsService.name);
  private readonly rewardsInterface = new ethers.Interface(REWARDS_ABI);
  private readonly metaInterface = new ethers.Interface(ERC20_META_ABI);
  private readonly pageSize = 5000;

  constructor(
    private readonly db: RuntimeDbService,
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
    return { version: CompoundVersion.V3, ranges, rows, userTotals };
  }

  private async calculateNetwork(range: ResolvedRewardRange): Promise<{
    rows: PeriodRewardRow[];
    userTotals: PeriodRewardUserTotal[];
  }> {
    const rewardsAddress = range.config.rewardsV3;
    if (!rewardsAddress) {
      throw new Error(`V3 rewards address is missing for ${range.network}`);
    }
    this.assertIndexedThrough(range);

    const usersByMarket = this.loadUsersByMarket(range);
    const firstSeenByMarket = new Map(
      this.db
        .listIndexedMarketsForNetwork(CompoundVersion.V3, range.network)
        .map((market) => [
          market.marketAddress.toLowerCase(),
          market.firstSeenBlock,
        ]),
    );
    const out: PeriodRewardRow[] = [];
    const userTotals = new Map<string, PeriodRewardUserTotal>();
    const configuredMarketRanges = new Map(
      range.markets.map((market) => [market.address.toLowerCase(), market]),
    );

    for (const marketRange of range.markets) {
      if (!firstSeenByMarket.has(marketRange.address.toLowerCase())) {
        throw new Error(
          `[V3][${range.network}] configured market is missing from the index: ${marketRange.symbol}/${marketRange.address}`,
        );
      }
    }

    this.logger.log(
      `[V3][${range.network}] period=${range.start.number}-${range.end.number} markets=${usersByMarket.size}`,
    );

    for (const [marketLower, indexedUsers] of usersByMarket) {
      const configuredRange = configuredMarketRanges.get(marketLower);
      if (range.markets.length > 0 && !configuredRange) continue;

      const market = ethers.getAddress(marketLower);
      const firstSeen = firstSeenByMarket.get(marketLower) ?? 0;
      if (firstSeen > range.end.number) continue;

      const startBoundary =
        configuredRange?.startBoundary ?? range.startBoundary;

      const rewardToken = await this.readRewardToken(
        range,
        rewardsAddress,
        market,
        range.end.number,
        true,
      );
      if (!rewardToken || rewardToken === ethers.ZeroAddress) {
        this.logger.warn(
          `[V3][${range.network}] skipping unsupported market=${market}`,
        );
        continue;
      }

      const [marketSymbol, rewardTokenSymbol, rewardTokenDecimals] =
        await Promise.all([
          this.readString(range, range.end.number, market, 'symbol'),
          this.readString(range, range.end.number, rewardToken, 'symbol'),
          this.readUint(range, range.end.number, rewardToken, 'decimals'),
        ]);

      if (configuredRange && marketSymbol !== configuredRange.symbol) {
        throw new Error(
          `[V3][${range.network}] market symbol mismatch address=${market} expected=${configuredRange.symbol} actual=${marketSymbol}`,
        );
      }

      const userEntries = Array.from(indexedUsers.entries()).map(
        ([user, createdAt]) => ({ user: ethers.getAddress(user), createdAt }),
      );
      const users = userEntries.map(({ user }) => user);
      const startUsers = userEntries
        .filter(({ createdAt }) => createdAt <= startBoundary.timestamp)
        .map(({ user }) => user);
      this.logger.log(
        `[V3][${range.network}][${marketSymbol}] users=${
          users.length
        } startSnapshots=${startUsers.length} savedStartSnapshots=${
          users.length - startUsers.length
        }`,
      );
      const endSnapshots = await this.readSnapshots({
        range,
        rewardsAddress,
        market,
        rewardToken,
        users,
        blockTag: range.end.number,
        required: true,
      });

      const startRewardToken =
        firstSeen > startBoundary.number
          ? null
          : await this.readRewardToken(
              range,
              rewardsAddress,
              market,
              startBoundary.number,
              false,
            );
      const startSnapshots = startRewardToken
        ? await this.readSnapshots({
            range,
            rewardsAddress,
            market,
            rewardToken: startRewardToken,
            users: startUsers,
            blockTag: startBoundary.number,
            required: true,
          })
        : new Map<string, V3Snapshot>();

      if (
        startRewardToken &&
        ethers.getAddress(startRewardToken) !== ethers.getAddress(rewardToken)
      ) {
        throw new Error(
          `[V3][${range.network}] reward token changed for market=${market}`,
        );
      }

      for (const user of users) {
        const end = endSnapshots.get(user.toLowerCase());
        if (!end) {
          throw new Error(
            `[V3][${range.network}] missing end snapshot market=${market} user=${user}`,
          );
        }
        const start = startSnapshots.get(user.toLowerCase()) ?? {
          claimed: 0n,
          owed: 0n,
        };
        const lifetimeEnd = end.claimed + end.owed;
        const lifetimeStart = start.claimed + start.owed;
        if (lifetimeEnd < lifetimeStart) {
          throw new Error(
            `[V3][${range.network}] negative reward invariant market=${market} user=${user}`,
          );
        }
        if (end.claimed < start.claimed) {
          throw new Error(
            `[V3][${range.network}] negative claimed invariant market=${market} user=${user}`,
          );
        }
        const earnedRaw = lifetimeEnd - lifetimeStart;
        const claimedRaw = end.claimed - start.claimed;
        const remainingRaw = end.owed;
        if (earnedRaw === 0n && claimedRaw === 0n && remainingRaw === 0n) {
          continue;
        }

        out.push({
          version: CompoundVersion.V3,
          network: range.network,
          chainId: range.chainId,
          range,
          marketRange: this.effectiveMarketRange(
            range,
            configuredRange,
            market,
            marketSymbol,
          ),
          market,
          marketSymbol,
          rewardToken: ethers.getAddress(rewardToken),
          rewardTokenSymbol,
          rewardTokenDecimals: Number(rewardTokenDecimals),
          user,
          totalRewardRaw: earnedRaw,
          claimedRaw,
          remainingRaw,
        });

        const totalKey = `${rewardToken.toLowerCase()}:${user.toLowerCase()}`;
        const total = userTotals.get(totalKey);
        if (total) {
          total.earnedRaw += earnedRaw;
          total.claimedRaw = (total.claimedRaw ?? 0n) + claimedRaw;
          total.remainingRaw += remainingRaw;
        } else {
          userTotals.set(totalKey, {
            version: CompoundVersion.V3,
            network: range.network,
            chainId: range.chainId,
            range,
            rewardToken: ethers.getAddress(rewardToken),
            rewardTokenSymbol,
            rewardTokenDecimals: Number(rewardTokenDecimals),
            user,
            earnedRaw,
            claimedRaw,
            remainingRaw,
          });
        }
      }
    }

    return {
      rows: out,
      userTotals: Array.from(userTotals.values()),
    };
  }

  private loadUsersByMarket(
    range: ResolvedRewardRange,
  ): Map<string, Map<string, number>> {
    const result = new Map<string, Map<string, number>>();
    let offset = 0;
    while (true) {
      const page = this.db.fetchIndexedUsersForNetwork(
        CompoundVersion.V3,
        range.network,
        this.pageSize,
        offset,
      );
      for (const row of page) {
        if (row.createdAt > range.end.timestamp) continue;
        const market = row.marketAddress.toLowerCase();
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

  private effectiveMarketRange(
    range: ResolvedRewardRange,
    configured: ResolvedMarketRewardRange | undefined,
    market: string,
    marketSymbol: string,
  ): ResolvedMarketRewardRange {
    return (
      configured ?? {
        symbol: marketSymbol,
        address: ethers.getAddress(market),
        startBoundary: range.startBoundary,
        start: range.start,
        end: range.end,
      }
    );
  }

  private async readSnapshots(params: {
    range: ResolvedRewardRange;
    rewardsAddress: string;
    market: string;
    rewardToken: string;
    users: string[];
    blockTag: number;
    required: boolean;
  }): Promise<Map<string, V3Snapshot>> {
    const calls = params.users.flatMap((user) => [
      {
        target: params.rewardsAddress,
        callData: this.rewardsInterface.encodeFunctionData('getRewardOwed', [
          params.market,
          user,
        ]),
      },
      {
        target: params.rewardsAddress,
        callData: this.rewardsInterface.encodeFunctionData('rewardsClaimed', [
          params.market,
          user,
        ]),
      },
    ]);
    const results = await this.historical.callMany({
      network: params.range.network,
      blockTag: params.blockTag,
      calls,
    });
    const out = new Map<string, V3Snapshot>();

    for (let i = 0; i < params.users.length; i++) {
      const user = params.users[i]!;
      const owedResult = results[i * 2];
      const claimedResult = results[i * 2 + 1];
      if (!owedResult?.success || !claimedResult?.success) {
        if (params.required) {
          throw new Error(
            `[V3][${params.range.network}][${params.blockTag}] historical call failed market=${params.market} user=${user}`,
          );
        }
        continue;
      }

      const owedTuple = this.rewardsInterface.decodeFunctionResult(
        'getRewardOwed',
        owedResult.returnData,
      )[0] as { token?: string; owed?: bigint } & [string, bigint];
      const token = String(owedTuple.token ?? owedTuple[0]);
      if (ethers.getAddress(token) !== ethers.getAddress(params.rewardToken)) {
        throw new Error(
          `[V3][${params.range.network}] getRewardOwed token mismatch market=${params.market} user=${user}`,
        );
      }
      const owed = BigInt(owedTuple.owed ?? owedTuple[1]);
      const claimed = BigInt(
        this.rewardsInterface.decodeFunctionResult(
          'rewardsClaimed',
          claimedResult.returnData,
        )[0],
      );
      out.set(user.toLowerCase(), { owed, claimed });
    }

    return out;
  }

  private async readRewardToken(
    range: ResolvedRewardRange,
    rewardsAddress: string,
    market: string,
    blockTag: number,
    required: boolean,
  ): Promise<string | null> {
    const [result] = await this.historical.callMany({
      network: range.network,
      blockTag,
      calls: [
        {
          target: rewardsAddress,
          callData: this.rewardsInterface.encodeFunctionData('rewardConfig', [
            market,
          ]),
        },
      ],
    });
    if (!result?.success) {
      if (required) {
        throw new Error(
          `[V3][${range.network}][${blockTag}] rewardConfig failed market=${market}`,
        );
      }
      return null;
    }
    const token = String(
      this.rewardsInterface.decodeFunctionResult(
        'rewardConfig',
        result.returnData,
      )[0],
    );
    return token === ethers.ZeroAddress ? null : ethers.getAddress(token);
  }

  private async readString(
    range: ResolvedRewardRange,
    blockTag: number,
    target: string,
    functionName: 'symbol',
  ): Promise<string> {
    const [result] = await this.historical.callMany({
      network: range.network,
      blockTag,
      calls: [
        {
          target,
          callData: this.metaInterface.encodeFunctionData(functionName),
        },
      ],
    });
    if (!result?.success) return ethers.getAddress(target);
    return String(
      this.metaInterface.decodeFunctionResult(
        functionName,
        result.returnData,
      )[0],
    );
  }

  private async readUint(
    range: ResolvedRewardRange,
    blockTag: number,
    target: string,
    functionName: 'decimals',
  ): Promise<bigint> {
    const [result] = await this.historical.callMany({
      network: range.network,
      blockTag,
      calls: [
        {
          target,
          callData: this.metaInterface.encodeFunctionData(functionName),
        },
      ],
    });
    if (!result?.success) {
      throw new Error(
        `[V3][${range.network}] ${functionName} failed target=${target}`,
      );
    }
    return BigInt(
      this.metaInterface.decodeFunctionResult(
        functionName,
        result.returnData,
      )[0],
    );
  }

  private assertIndexedThrough(range: ResolvedRewardRange): void {
    const cursor = this.db.getIndexedCursor(range.network);
    if (cursor == null || cursor < range.end.number) {
      throw new Error(
        `[V3][${range.network}] user index is stale: cursor=${cursor} endBlock=${range.end.number}`,
      );
    }
  }
}

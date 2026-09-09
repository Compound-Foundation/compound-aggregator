import { Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';

import { ProviderFactory } from 'network/provider.factory';
import { HistoricalCallService } from './historical-call.service';
import {
  pendingBorrow,
  pendingSupply,
  projectBorrowIndex,
  projectSupplyIndex,
} from './period-rewards.math';

/**
 * Non-fatal problems collected over a run. The daily job must still produce a
 * number, so a failed read degrades that user's contribution to 0 instead of
 * aborting; these counters are what lets the caller tell a partial result from
 * a complete one afterwards, and refuse to publish the former.
 */
export interface V2PendingStats {
  /** Users whose pending could not be read, and are therefore counted as 0. */
  failures: number;
  /** Users whose stored index was above the market index — should be zero. */
  anomalies: number;
  /** Markets whose reward state could not be read at all. */
  skippedMarkets: string[];
  /** Users dropped because their market was skipped. */
  skippedUsers: number;
  /** Warnings already emitted, so a bad run cannot flood the CI log. */
  logged: number;
}

export const emptyPendingStats = (): V2PendingStats => ({
  failures: 0,
  anomalies: 0,
  skippedMarkets: [],
  skippedUsers: 0,
  logged: 0,
});

export const isPendingComplete = (stats: V2PendingStats): boolean =>
  stats.failures === 0 &&
  stats.anomalies === 0 &&
  stats.skippedMarkets.length === 0;

const COMPTROLLER_ABI = [
  'function compSupplyState(address) view returns (uint224 index, uint32 blockNumber)',
  'function compBorrowState(address) view returns (uint224 index, uint32 blockNumber)',
  'function compSupplySpeeds(address) view returns (uint256)',
  'function compBorrowSpeeds(address) view returns (uint256)',
  'function compSpeeds(address) view returns (uint256)',
  'function compSupplierIndex(address,address) view returns (uint256)',
  'function compBorrowerIndex(address,address) view returns (uint256)',
];
const CTOKEN_ABI = [
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function totalBorrows() view returns (uint256)',
  'function borrowIndex() view returns (uint256)',
  'function borrowBalanceStored(address) view returns (uint256)',
];

export interface V2MarketRewardBoundary {
  projectedSupplyIndex: bigint;
  projectedBorrowIndex: bigint;
  marketBorrowIndex: bigint;
}

interface UserPosition {
  supplyBalance: bigint;
  borrowBalance: bigint;
}

interface UserCompIndexes {
  supplierIndex: bigint;
  borrowerIndex: bigint;
}

@Injectable()
export class V2CompStateService {
  private readonly logger = new Logger(V2CompStateService.name);
  private readonly comptrollerInterface = new ethers.Interface(COMPTROLLER_ABI);
  private readonly cTokenInterface = new ethers.Interface(CTOKEN_ABI);

  // The node meters these head-block reads per sub-call rather than per
  // request, so a wider multicall than the archive default is a straight win.
  // Concurrency is deliberately left at the service default: measured against
  // the production RPC, raising it changed nothing while chunk width halved
  // the time per sub-call.
  private readonly callChunkSize = 500;

  // Cap on warnings per run, so a degraded RPC cannot bury the Actions log.
  private readonly maxLoggedWarnings = 20;

  constructor(
    private readonly providers: ProviderFactory,
    private readonly historical: HistoricalCallService,
  ) {}

  public async readMarketBoundary(params: {
    network: string;
    comptroller: string;
    market: string;
    blockTag: number;
  }): Promise<V2MarketRewardBoundary | null> {
    const { network, comptroller, market, blockTag } = params;
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
      network,
      blockTag,
      calls,
    });
    if (!results[0]?.success || !results[1]?.success) return null;
    if (!results[5]?.success || !results[6]?.success || !results[7]?.success) {
      this.logger.warn(
        `[V2][${network}][${blockTag}] cToken state failed market=${market}`,
      );
      return null;
    }
    if (
      (!results[2]?.success && !results[4]?.success) ||
      (!results[3]?.success && !results[4]?.success)
    ) {
      this.logger.warn(
        `[V2][${network}][${blockTag}] reward speed state failed market=${market}`,
      );
      return null;
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

  /**
   * Reads in two passes: balances first, then the checkpointed index only for
   * users who actually hold a position on that side. A zero balance yields zero
   * pending whatever the index is (`pendingSupply` multiplies by the balance,
   * `pendingBorrow` by the normalized debt), so skipping is exact, not a
   * heuristic — and roughly half of the indexed (market, user) pairs are
   * long-closed positions.
   */
  public async readPendingByUser(params: {
    network: string;
    comptroller: string;
    market: string;
    users: string[];
    blockTag: number;
    boundary: V2MarketRewardBoundary;
    stats: V2PendingStats;
  }): Promise<Map<string, bigint>> {
    const { network, comptroller, market, users, blockTag, boundary, stats } =
      params;
    const out = new Map<string, bigint>();
    if (users.length === 0) return out;

    const positions = await this.readPositions({
      network,
      market,
      users,
      blockTag,
      stats,
    });
    const indexes = await this.readUserIndexes({
      network,
      comptroller,
      market,
      positions,
      blockTag,
      stats,
    });

    for (const [user, position] of positions) {
      const userIndexes = indexes.get(user);
      if (!userIndexes) continue;

      // Each side is guarded separately: an anomaly on one must not discard the
      // other side's valid amount. A user index above the market index should
      // be impossible, so treat it as a signal, not a reason to abort the run.
      const side = (label: string, compute: () => bigint): bigint => {
        try {
          return compute();
        } catch (error) {
          stats.anomalies += 1;
          this.warnWithinBudget(
            stats,
            `[V2][${network}][${blockTag}] ${label} math rejected market=${market} user=${user}: ${
              (error as Error).message
            }`,
          );
          return 0n;
        }
      };

      const pending =
        side('supply', () =>
          pendingSupply({
            projectedIndex: boundary.projectedSupplyIndex,
            userIndex: userIndexes.supplierIndex,
            userBalance: position.supplyBalance,
          }),
        ) +
        side('borrow', () =>
          pendingBorrow({
            projectedIndex: boundary.projectedBorrowIndex,
            userIndex: userIndexes.borrowerIndex,
            borrowBalanceStored: position.borrowBalance,
            marketBorrowIndex: boundary.marketBorrowIndex,
          }),
        );

      if (pending !== 0n) out.set(user, pending);
    }

    return out;
  }

  /** Pass 1: balances. This is what lets pass 2 skip closed positions. */
  private async readPositions(params: {
    network: string;
    market: string;
    users: string[];
    blockTag: number;
    stats: V2PendingStats;
  }): Promise<Map<string, UserPosition>> {
    const { network, market, users, blockTag, stats } = params;

    const results = await this.historical.callMany({
      network,
      blockTag,
      chunkSize: this.callChunkSize,
      calls: users.flatMap((user) => [
        {
          target: market,
          callData: this.cTokenInterface.encodeFunctionData('balanceOf', [
            user,
          ]),
        },
        {
          target: market,
          callData: this.cTokenInterface.encodeFunctionData(
            'borrowBalanceStored',
            [user],
          ),
        },
      ]),
    });

    const out = new Map<string, UserPosition>();

    for (let i = 0; i < users.length; i++) {
      const user = users[i]!.toLowerCase();
      const balanceResult = results[i * 2];
      const borrowResult = results[i * 2 + 1];

      if (!balanceResult?.success || !borrowResult?.success) {
        stats.failures += 1;
        this.warnWithinBudget(
          stats,
          `[V2][${network}][${blockTag}] position read failed market=${market} user=${user}`,
        );
        continue;
      }

      // Decoding is guarded per user: a single malformed response must cost one
      // user, not throw out of here and zero the whole market page.
      let supplyBalance: bigint;
      let borrowBalance: bigint;
      try {
        supplyBalance = this.decodeUint(
          this.cTokenInterface,
          'balanceOf',
          balanceResult.returnData,
        );
        borrowBalance = this.decodeUint(
          this.cTokenInterface,
          'borrowBalanceStored',
          borrowResult.returnData,
        );
      } catch (error) {
        stats.failures += 1;
        this.warnWithinBudget(
          stats,
          `[V2][${network}][${blockTag}] position decode failed market=${market} user=${user}: ${
            (error as Error).message
          }`,
        );
        continue;
      }

      if (supplyBalance === 0n && borrowBalance === 0n) continue;
      out.set(user, { supplyBalance, borrowBalance });
    }

    return out;
  }

  /**
   * Pass 2: the checkpointed index, read only on the side where the user holds
   * a position — so 0, 1 or 2 calls per user rather than a flat 2.
   */
  private async readUserIndexes(params: {
    network: string;
    comptroller: string;
    market: string;
    positions: Map<string, UserPosition>;
    blockTag: number;
    stats: V2PendingStats;
  }): Promise<Map<string, UserCompIndexes>> {
    const { network, comptroller, market, positions, blockTag, stats } = params;
    const out = new Map<string, UserCompIndexes>();
    if (positions.size === 0) return out;

    const wanted: Array<{ user: string; supply: boolean; borrow: boolean }> =
      [];
    const calls: Array<{ target: string; callData: string }> = [];

    for (const [user, position] of positions) {
      const supply = position.supplyBalance > 0n;
      const borrow = position.borrowBalance > 0n;
      wanted.push({ user, supply, borrow });

      if (supply) {
        calls.push({
          target: comptroller,
          callData: this.comptrollerInterface.encodeFunctionData(
            'compSupplierIndex',
            [market, user],
          ),
        });
      }
      if (borrow) {
        calls.push({
          target: comptroller,
          callData: this.comptrollerInterface.encodeFunctionData(
            'compBorrowerIndex',
            [market, user],
          ),
        });
      }
    }

    const results = await this.historical.callMany({
      network,
      blockTag,
      chunkSize: this.callChunkSize,
      calls,
    });

    // Results are flat, so walk them with a cursor that advances by exactly the
    // number of calls each user asked for.
    let cursor = 0;
    for (const entry of wanted) {
      const supplyResult = entry.supply ? results[cursor++] : undefined;
      const borrowResult = entry.borrow ? results[cursor++] : undefined;

      if (
        (entry.supply && !supplyResult?.success) ||
        (entry.borrow && !borrowResult?.success)
      ) {
        stats.failures += 1;
        this.warnWithinBudget(
          stats,
          `[V2][${network}][${blockTag}] user index read failed market=${market} user=${entry.user}`,
        );
        continue;
      }

      // Guarded per user for the same reason as the balance decode above. Note
      // the cursor has already advanced, so a throw here cannot desynchronise
      // the remaining entries.
      try {
        out.set(entry.user, {
          supplierIndex: supplyResult
            ? this.decodeUint(
                this.comptrollerInterface,
                'compSupplierIndex',
                supplyResult.returnData,
              )
            : 0n,
          borrowerIndex: borrowResult
            ? this.decodeUint(
                this.comptrollerInterface,
                'compBorrowerIndex',
                borrowResult.returnData,
              )
            : 0n,
        });
      } catch (error) {
        stats.failures += 1;
        this.warnWithinBudget(
          stats,
          `[V2][${network}][${blockTag}] user index decode failed market=${market} user=${
            entry.user
          }: ${(error as Error).message}`,
        );
      }
    }

    return out;
  }

  private decodeUint(
    iface: ethers.Interface,
    functionName: string,
    data: string,
  ): bigint {
    return BigInt(iface.decodeFunctionResult(functionName, data)[0]);
  }

  /**
   * Per-user failures can run into the hundreds of thousands if the RPC
   * degrades, so warnings get their own budget. It has to be a separate counter
   * rather than a threshold on `failures`: the caller bumps that one by a whole
   * page at a time, which would silence every later diagnostic after one bad
   * market.
   */
  private warnWithinBudget(stats: V2PendingStats, message: string): void {
    if (stats.logged >= this.maxLoggedWarnings) return;
    stats.logged += 1;
    this.logger.warn(
      stats.logged === this.maxLoggedWarnings
        ? `${message} (further warnings suppressed)`
        : message,
    );
  }
}

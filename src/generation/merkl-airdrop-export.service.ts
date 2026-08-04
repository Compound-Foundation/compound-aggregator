import { Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CompoundVersion } from 'common/types/compound-version';
import {
  PeriodRewardRow,
  PeriodRewardUserTotal,
  PeriodRewardsResult,
  ResolvedMarketRewardRange,
  ResolvedRewardRange,
} from './period-rewards.types';

interface ReasonAmounts {
  [reason: string]: bigint;
}

interface MarketAuditAccumulator {
  market: string;
  symbol: string;
  range: ResolvedMarketRewardRange;
  supplyRewardRaw: bigint;
  borrowRewardRaw: bigint;
  totalRewardRaw: bigint;
  claimedRaw: bigint;
  remainingRaw: bigint;
  remainingForPeriodRaw: bigint;
}

interface RecipientAuditAccumulator {
  user: string;
  markets: Map<string, MarketAuditAccumulator>;
  totalRewardRaw: bigint;
  userTotal?: PeriodRewardUserTotal;
}

interface ExportGroup {
  version: CompoundVersion;
  network: string;
  chainId: number;
  rewardToken: string;
  rewardTokenSymbol: string;
  rewardTokenDecimals: number;
  range: ResolvedRewardRange;
  rows: PeriodRewardRow[];
  userTotals: PeriodRewardUserTotal[];
}

export interface MerklExportedFile {
  network: string;
  rewardToken: string;
  merklPath: string;
  auditPath: string;
  allocationTotalRaw: string;
  recipientCount: number;
}

export interface MerklExportOptions {
  period?: boolean;
}

@Injectable()
export class MerklAirdropExportService {
  private readonly logger = new Logger(MerklAirdropExportService.name);

  public export(
    result: PeriodRewardsResult,
    options: MerklExportOptions = {},
  ): MerklExportedFile[] {
    const groups = this.groupRows(result);
    if (groups.length === 0) {
      this.logger.warn(`[${result.version}] no positive rewards to export`);
      return [];
    }
    const periodOnly = options.period === true;
    return groups.map((group) => this.exportGroup(group, periodOnly));
  }

  private groupRows(result: PeriodRewardsResult): ExportGroup[] {
    const groups = new Map<string, ExportGroup>();
    for (const total of result.userTotals ?? []) {
      const token = ethers.getAddress(total.rewardToken);
      const key = `${total.network}:${token.toLowerCase()}`;
      const existing = groups.get(key);
      if (existing) {
        existing.userTotals.push(total);
      } else {
        groups.set(key, {
          version: total.version,
          network: total.network,
          chainId: total.chainId,
          rewardToken: token,
          rewardTokenSymbol: total.rewardTokenSymbol,
          rewardTokenDecimals: total.rewardTokenDecimals,
          range: total.range,
          rows: [],
          userTotals: [total],
        });
      }
    }
    for (const row of result.rows) {
      const token = ethers.getAddress(row.rewardToken);
      const key = `${row.network}:${token.toLowerCase()}`;
      const existing = groups.get(key);
      if (existing) {
        if (
          existing.rewardTokenDecimals !== row.rewardTokenDecimals ||
          existing.chainId !== row.chainId ||
          existing.range.start.number !== row.range.start.number ||
          existing.range.end.number !== row.range.end.number
        ) {
          throw new Error(`Inconsistent Merkl export group: ${key}`);
        }
        existing.rows.push(row);
      } else {
        groups.set(key, {
          version: row.version,
          network: row.network,
          chainId: row.chainId,
          rewardToken: token,
          rewardTokenSymbol: row.rewardTokenSymbol,
          rewardTokenDecimals: row.rewardTokenDecimals,
          range: row.range,
          rows: [row],
          userTotals: [],
        });
      }
    }
    return Array.from(groups.values()).sort(
      (a, b) =>
        a.chainId - b.chainId ||
        a.rewardToken.toLowerCase().localeCompare(b.rewardToken.toLowerCase()),
    );
  }

  private exportGroup(
    group: ExportGroup,
    periodOnly: boolean,
  ): MerklExportedFile {
    const partial = this.isPartial(group);
    const rewards = new Map<string, ReasonAmounts>();
    const marketTotals = new Map<string, MarketAuditAccumulator>();
    const recipients = new Map<string, RecipientAuditAccumulator>();

    for (const row of group.rows) {
      const user = ethers.getAddress(row.user);
      const market = ethers.getAddress(row.market);
      if (row.totalRewardRaw < 0n) {
        throw new Error(`Non-positive reward row: ${market}/${user}`);
      }

      if (group.version === CompoundVersion.V3) {
        if (
          row.claimedRaw == null ||
          row.remainingRaw == null ||
          row.remainingForPeriodRaw == null
        ) {
          throw new Error(`V3 debt fields are missing: ${market}/${user}`);
        }
        if (
          row.claimedRaw < 0n ||
          row.remainingRaw < 0n ||
          row.remainingForPeriodRaw < 0n
        ) {
          throw new Error(`Negative V3 debt field: ${market}/${user}`);
        }
        if (
          row.totalRewardRaw === 0n &&
          row.claimedRaw === 0n &&
          row.remainingRaw === 0n
        ) {
          throw new Error(`Empty V3 reward row: ${market}/${user}`);
        }
        const reasonAmounts = rewards.get(user) ?? {};
        this.addReason(
          reasonAmounts,
          this.reason(group.version, market),
          periodOnly ? row.remainingForPeriodRaw : row.remainingRaw,
        );
        rewards.set(user, reasonAmounts);
      } else if (row.totalRewardRaw === 0n) {
        throw new Error(`Non-positive reward row: ${market}/${user}`);
      }

      const marketAudit = marketTotals.get(market) ?? this.zeroMarket(row);
      this.addRowToMarket(marketAudit, row);
      marketTotals.set(market, marketAudit);

      const recipient = recipients.get(user) ?? {
        user,
        markets: new Map<string, MarketAuditAccumulator>(),
        totalRewardRaw: 0n,
      };
      const recipientMarket =
        recipient.markets.get(market) ?? this.zeroMarket(row);
      this.addRowToMarket(recipientMarket, row);
      recipient.markets.set(market, recipientMarket);
      recipient.totalRewardRaw += row.totalRewardRaw;
      recipients.set(user, recipient);
    }

    if (group.userTotals.length === 0) {
      throw new Error(
        `${group.version.toUpperCase()} user totals are missing for ${
          group.network
        }`,
      );
    }
    for (const total of group.userTotals) {
      const user = ethers.getAddress(total.user);
      const recipient = recipients.get(user) ?? {
        user,
        markets: new Map<string, MarketAuditAccumulator>(),
        totalRewardRaw: 0n,
      };
      if (recipient.userTotal) {
        throw new Error(
          `Duplicate ${group.version.toUpperCase()} user total for ${user}`,
        );
      }
      if (recipient.totalRewardRaw !== total.earnedRaw) {
        throw new Error(
          `${group.version.toUpperCase()} user earned mismatch for ${user}: markets=${
            recipient.totalRewardRaw
          } total=${total.earnedRaw}`,
        );
      }
      if (group.version === CompoundVersion.V3) {
        const marketClaimed = Array.from(recipient.markets.values()).reduce(
          (sum, market) => sum + market.claimedRaw,
          0n,
        );
        const marketRemaining = Array.from(recipient.markets.values()).reduce(
          (sum, market) => sum + market.remainingRaw,
          0n,
        );
        const marketRemainingForPeriod = Array.from(
          recipient.markets.values(),
        ).reduce((sum, market) => sum + market.remainingForPeriodRaw, 0n);
        if (
          total.claimedRaw !== marketClaimed ||
          total.remainingRaw !== marketRemaining ||
          total.remainingForPeriodRaw !== marketRemainingForPeriod
        ) {
          throw new Error(
            `V3 user debt mismatch for ${user}: claimed=${marketClaimed}/${total.claimedRaw} remaining=${marketRemaining}/${total.remainingRaw} remainingForPeriod=${marketRemainingForPeriod}/${total.remainingForPeriodRaw}`,
          );
        }
      }
      recipient.userTotal = total;
      recipients.set(user, recipient);

      if (group.version === CompoundVersion.V2) {
        const reasonAmounts = rewards.get(user) ?? {};
        this.addReason(
          reasonAmounts,
          'compound-v2',
          periodOnly ? total.remainingForPeriodRaw : total.remainingRaw,
        );
        rewards.set(user, reasonAmounts);
      }
    }

    const sortedUsers = Array.from(rewards.keys()).sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    );
    const merklRewards: Record<string, Record<string, string>> = {};
    let allocationTotalRaw = 0n;

    for (const user of sortedUsers) {
      const reasons = rewards.get(user)!;
      const sortedReasons = Object.keys(reasons).sort();
      const outputReasons: Record<string, string> = {};
      let recipientTotal = 0n;
      for (const reason of sortedReasons) {
        const amount = reasons[reason]!;
        if (amount <= 0n) continue;
        outputReasons[reason] = amount.toString(10);
        recipientTotal += amount;
      }
      if (recipientTotal === 0n) continue;
      const recipient = recipients.get(user);
      const expectedTotal = periodOnly
        ? recipient?.userTotal?.remainingForPeriodRaw
        : recipient?.userTotal?.remainingRaw;
      if (recipientTotal !== expectedTotal) {
        throw new Error(`Merkl reason total mismatch for ${user}`);
      }
      merklRewards[user] = outputReasons;
      allocationTotalRaw += recipientTotal;
    }

    const marketTotalRaw = Array.from(marketTotals.values()).reduce(
      (sum, market) => sum + market.totalRewardRaw,
      0n,
    );
    const earnedTotalRaw = group.userTotals.reduce(
      (sum, total) => sum + total.earnedRaw,
      0n,
    );
    const remainingTotalRaw = group.userTotals.reduce(
      (sum, total) => sum + total.remainingRaw,
      0n,
    );
    const remainingForPeriodTotalRaw = group.userTotals.reduce(
      (sum, total) => sum + total.remainingForPeriodRaw,
      0n,
    );
    const claimedTotalRaw = group.userTotals.every(
      (total) => total.claimedRaw !== null,
    )
      ? group.userTotals.reduce(
          (sum, total) => sum + (total.claimedRaw ?? 0n),
          0n,
        )
      : null;
    if (marketTotalRaw !== earnedTotalRaw) {
      throw new Error(
        `Market/network earned mismatch for ${group.network}: market=${marketTotalRaw} users=${earnedTotalRaw}`,
      );
    }
    const expectedAllocationTotalRaw = periodOnly
      ? remainingForPeriodTotalRaw
      : remainingTotalRaw;
    if (allocationTotalRaw !== expectedAllocationTotalRaw) {
      throw new Error(
        `Merkl/network allocation mismatch for ${
          group.network
        }: allocation=${allocationTotalRaw} expected=${expectedAllocationTotalRaw} mode=${
          periodOnly ? 'period' : 'remaining'
        }`,
      );
    }

    const merkl = {
      rewardToken: ethers.getAddress(group.rewardToken),
      rewards: merklRewards,
    };
    const fundingRequiredRaw = this.ceilDiv(allocationTotalRaw * 200n, 199n);
    const audit = {
      protocol: `compound-${group.version}`,
      network: group.network,
      chainId: group.chainId,
      rewardToken: ethers.getAddress(group.rewardToken),
      rewardTokenSymbol: group.rewardTokenSymbol,
      rewardTokenDecimals: group.rewardTokenDecimals,
      allocationMode: periodOnly ? 'period' : 'remaining',
      partial,
      selectedMarkets: partial
        ? group.range.markets.map((market) => ({
            symbol: market.symbol,
            address: ethers.getAddress(market.address),
          }))
        : undefined,
      range: this.auditRange(group.range),
      total: this.serializeUserTotal(
        earnedTotalRaw,
        claimedTotalRaw,
        remainingTotalRaw,
        remainingForPeriodTotalRaw,
        group.rewardTokenDecimals,
      ),
      recipientCount: Object.keys(merklRewards).length,
      marketCount: marketTotals.size,
      allocationTotalRaw: allocationTotalRaw.toString(10),
      allocationTotal: ethers.formatUnits(
        allocationTotalRaw,
        group.rewardTokenDecimals,
      ),
      fundingRequiredRaw: fundingRequiredRaw.toString(10),
      marketTotals: Array.from(marketTotals.values())
        .sort((a, b) =>
          a.market.toLowerCase().localeCompare(b.market.toLowerCase()),
        )
        .map((market) => this.serializeMarket(market, group)),
      recipients: Array.from(recipients.values())
        .sort((a, b) =>
          a.user.toLowerCase().localeCompare(b.user.toLowerCase()),
        )
        .map((recipient) => this.serializeRecipient(recipient, group)),
    };

    const tokenTag = group.rewardToken.toLowerCase().slice(0, 10);
    const prefixParts = [
      `rewards-${group.version}`,
      group.network,
      tokenTag,
      group.range.start.number,
      group.range.end.number,
    ];
    const prefix = prefixParts.join('-');
    const partialSuffix = partial ? '.partial' : '';
    const resultDir = join(process.cwd(), 'result');
    mkdirSync(resultDir, { recursive: true });
    const merklPath = join(resultDir, `${prefix}${partialSuffix}.merkl.json`);
    const auditPath = join(resultDir, `${prefix}${partialSuffix}.audit.json`);
    writeFileSync(merklPath, JSON.stringify(merkl, null, 2) + '\n', 'utf8');
    writeFileSync(auditPath, JSON.stringify(audit, null, 2) + '\n', 'utf8');

    if (partial) {
      this.logger.warn(
        `[${group.version}][${group.network}] PARTIAL export: selectedMarkets=${group.range.markets.length}`,
      );
    }
    this.logger.log(
      `[${group.version}][${group.network}] mode=${
        periodOnly ? 'period' : 'remaining'
      } Merkl=${merklPath} audit=${auditPath} recipients=${
        Object.keys(merklRewards).length
      }`,
    );
    return {
      network: group.network,
      rewardToken: group.rewardToken,
      merklPath,
      auditPath,
      allocationTotalRaw: allocationTotalRaw.toString(10),
      recipientCount: Object.keys(merklRewards).length,
    };
  }

  private isPartial(group: ExportGroup): boolean {
    return (
      group.version === CompoundVersion.V2 && group.range.markets.length > 0
    );
  }

  private reason(
    version: CompoundVersion,
    market: string,
    side?: 'supply' | 'borrow',
  ): string {
    return [`compound-${version}`, ethers.getAddress(market), side]
      .filter(Boolean)
      .join(':');
  }

  private addReason(
    reasons: ReasonAmounts,
    reason: string,
    amount: bigint,
  ): void {
    if (amount < 0n) throw new Error(`Negative Merkl reason: ${reason}`);
    if (amount === 0n) return;
    reasons[reason] = (reasons[reason] ?? 0n) + amount;
  }

  private zeroMarket(row: PeriodRewardRow): MarketAuditAccumulator {
    return {
      market: ethers.getAddress(row.market),
      symbol: row.marketSymbol,
      range: this.effectiveMarketRange(row),
      supplyRewardRaw: 0n,
      borrowRewardRaw: 0n,
      totalRewardRaw: 0n,
      claimedRaw: 0n,
      remainingRaw: 0n,
      remainingForPeriodRaw: 0n,
    };
  }

  private addRowToMarket(
    target: MarketAuditAccumulator,
    row: PeriodRewardRow,
  ): void {
    const rowRange = this.effectiveMarketRange(row);
    if (
      target.range.start.number !== rowRange.start.number ||
      target.range.end.number !== rowRange.end.number
    ) {
      throw new Error(`Inconsistent market range for ${target.market}`);
    }
    target.supplyRewardRaw += row.supplyRewardRaw ?? 0n;
    target.borrowRewardRaw += row.borrowRewardRaw ?? 0n;
    target.totalRewardRaw += row.totalRewardRaw;
    target.claimedRaw += row.claimedRaw ?? 0n;
    target.remainingRaw += row.remainingRaw ?? 0n;
    target.remainingForPeriodRaw += row.remainingForPeriodRaw ?? 0n;
  }

  private serializeMarket(
    market: MarketAuditAccumulator,
    group: ExportGroup,
  ): Record<string, unknown> {
    const common: Record<string, unknown> = {
      market: market.market,
      symbol: market.symbol,
      range: this.auditRange(market.range),
    };
    if (group.version === CompoundVersion.V2) {
      common.supplyRewardRaw = market.supplyRewardRaw.toString(10);
      common.borrowRewardRaw = market.borrowRewardRaw.toString(10);
    }
    common.earnedRaw = market.totalRewardRaw.toString(10);
    common.earned = ethers.formatUnits(
      market.totalRewardRaw,
      group.rewardTokenDecimals,
    );
    if (group.version === CompoundVersion.V3) {
      common.remainingForPeriodRaw = market.remainingForPeriodRaw.toString(10);
      common.remainingForPeriod = ethers.formatUnits(
        market.remainingForPeriodRaw,
        group.rewardTokenDecimals,
      );
    }
    return common;
  }

  private serializeRecipient(
    recipient: RecipientAuditAccumulator,
    group: ExportGroup,
  ): Record<string, unknown> {
    const markets = Array.from(recipient.markets.values())
      .sort((a, b) =>
        a.market.toLowerCase().localeCompare(b.market.toLowerCase()),
      )
      .map((market) => this.serializeMarket(market, group));
    const total = recipient.userTotal;
    if (!total) {
      throw new Error(
        `${group.version.toUpperCase()} user total is missing for ${
          recipient.user
        }`,
      );
    }
    return {
      user: recipient.user,
      markets,
      ...this.serializeUserTotal(
        total.earnedRaw,
        total.claimedRaw,
        total.remainingRaw,
        total.remainingForPeriodRaw,
        group.rewardTokenDecimals,
      ),
    };
  }

  private serializeUserTotal(
    earnedRaw: bigint,
    claimedRaw: bigint | null,
    remainingRaw: bigint,
    remainingForPeriodRaw: bigint,
    decimals: number,
  ): Record<string, string | null> {
    return {
      earnedRaw: earnedRaw.toString(10),
      earned: ethers.formatUnits(earnedRaw, decimals),
      claimedRaw: claimedRaw?.toString(10) ?? null,
      claimed:
        claimedRaw === null ? null : ethers.formatUnits(claimedRaw, decimals),
      remainingRaw: remainingRaw.toString(10),
      remaining: ethers.formatUnits(remainingRaw, decimals),
      remainingForPeriodRaw: remainingForPeriodRaw.toString(10),
      remainingForPeriod: ethers.formatUnits(remainingForPeriodRaw, decimals),
    };
  }

  private effectiveMarketRange(
    row: PeriodRewardRow,
  ): ResolvedMarketRewardRange {
    return (
      row.marketRange ?? {
        symbol: row.marketSymbol,
        address: ethers.getAddress(row.market),
        startBoundary: row.range.startBoundary,
        start: row.range.start,
        end: row.range.end,
      }
    );
  }

  private auditRange(
    range: Pick<ResolvedRewardRange, 'startBoundary' | 'start' | 'end'>,
  ): Record<string, unknown> {
    return {
      startBoundary: {
        blockNumber: range.startBoundary.number,
        blockHash: range.startBoundary.hash,
        timestamp: range.startBoundary.timestamp,
      },
      start: {
        blockNumber: range.start.number,
        blockHash: range.start.hash,
        timestamp: range.start.timestamp,
      },
      end: {
        blockNumber: range.end.number,
        blockHash: range.end.hash,
        timestamp: range.end.timestamp,
      },
    };
  }

  private ceilDiv(numerator: bigint, denominator: bigint): bigint {
    if (denominator <= 0n) throw new Error('ceilDiv denominator must be > 0');
    return (numerator + denominator - 1n) / denominator;
  }
}

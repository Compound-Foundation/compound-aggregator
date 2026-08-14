import { CompoundVersion } from 'common/types/compound-version';
import { NetworkConfig } from 'network/network.types';

export interface RangeFileEntry {
  network: string;
  chainId: number;
  startBlock: number;
  endBlock: number;
  markets?: RangeFileMarketEntry[];
}

export interface RangeFileMarketEntry {
  symbol: string;
  address: string;
  startBlock: number;
}

export interface RangeFile {
  v2: RangeFileEntry[];
  v3: RangeFileEntry[];
}

export interface ResolvedBlock {
  number: number;
  hash: string;
  timestamp: number;
}

export interface ResolvedRewardRange {
  network: string;
  chainId: number;
  config: NetworkConfig;
  startBoundary: ResolvedBlock;
  start: ResolvedBlock;
  end: ResolvedBlock;
  markets: ResolvedMarketRewardRange[];
  omittedMarkets?: string[];
}

export interface ResolvedMarketRewardRange {
  symbol: string;
  address: string;
  startBoundary: ResolvedBlock;
  start: ResolvedBlock;
  end: ResolvedBlock;
}

export type RewardSide = 'supply' | 'borrow';

interface PeriodRewardRowBase {
  network: string;
  chainId: number;
  range: ResolvedRewardRange;
  market: string;
  marketSymbol: string;
  rewardToken: string;
  rewardTokenSymbol: string;
  rewardTokenDecimals: number;
  user: string;
  totalRewardRaw: bigint;
}

export interface V2PeriodRewardRow extends PeriodRewardRowBase {
  version: CompoundVersion.V2;
  marketRange?: ResolvedMarketRewardRange;
  supplyRewardRaw: bigint;
  borrowRewardRaw: bigint;
}

export interface V3PeriodRewardRow extends PeriodRewardRowBase {
  version: CompoundVersion.V3;
  marketRange: ResolvedMarketRewardRange;
  claimedRaw: bigint;
  remainingRaw: bigint;
  remainingForPeriodRaw: bigint;
}

export type PeriodRewardRow = V2PeriodRewardRow | V3PeriodRewardRow;

interface PeriodRewardUserTotalBase {
  network: string;
  chainId: number;
  range: ResolvedRewardRange;
  rewardToken: string;
  rewardTokenSymbol: string;
  rewardTokenDecimals: number;
  user: string;
  earnedRaw: bigint;
  remainingRaw: bigint;
  remainingForPeriodRaw: bigint;
}

export interface V2PeriodRewardUserTotal extends PeriodRewardUserTotalBase {
  version: CompoundVersion.V2;
  claimedRaw: bigint | null;
}

export interface V3PeriodRewardUserTotal extends PeriodRewardUserTotalBase {
  version: CompoundVersion.V3;
  claimedRaw: bigint;
}

export type PeriodRewardUserTotal =
  | V2PeriodRewardUserTotal
  | V3PeriodRewardUserTotal;

interface PeriodRewardsResultBase {
  ranges: ResolvedRewardRange[];
}

export interface V2PeriodRewardsResult extends PeriodRewardsResultBase {
  version: CompoundVersion.V2;
  rows: V2PeriodRewardRow[];
  userTotals: V2PeriodRewardUserTotal[];
}

export interface V3PeriodRewardsResult extends PeriodRewardsResultBase {
  version: CompoundVersion.V3;
  rows: V3PeriodRewardRow[];
  userTotals: V3PeriodRewardUserTotal[];
}

export type PeriodRewardsResult = V2PeriodRewardsResult | V3PeriodRewardsResult;

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
}

export interface ResolvedMarketRewardRange {
  symbol: string;
  address: string;
  startBoundary: ResolvedBlock;
  start: ResolvedBlock;
  end: ResolvedBlock;
}

export type RewardSide = 'supply' | 'borrow';

export interface PeriodRewardRow {
  version: CompoundVersion;
  network: string;
  chainId: number;
  range: ResolvedRewardRange;
  marketRange?: ResolvedMarketRewardRange;
  market: string;
  marketSymbol: string;
  rewardToken: string;
  rewardTokenSymbol: string;
  rewardTokenDecimals: number;
  user: string;
  supplyRewardRaw?: bigint;
  borrowRewardRaw?: bigint;
  totalRewardRaw: bigint;
  claimedRaw?: bigint;
  remainingRaw?: bigint;
  remainingForPeriodRaw?: bigint;
}

export interface PeriodRewardUserTotal {
  version: CompoundVersion;
  network: string;
  chainId: number;
  range: ResolvedRewardRange;
  rewardToken: string;
  rewardTokenSymbol: string;
  rewardTokenDecimals: number;
  user: string;
  earnedRaw: bigint;
  claimedRaw: bigint | null;
  remainingRaw: bigint;
  remainingForPeriodRaw: bigint;
}

export interface PeriodRewardsResult {
  version: CompoundVersion;
  ranges: ResolvedRewardRange[];
  rows: PeriodRewardRow[];
  userTotals?: PeriodRewardUserTotal[];
}

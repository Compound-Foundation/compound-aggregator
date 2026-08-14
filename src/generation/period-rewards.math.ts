export const DOUBLE_SCALE = 10n ** 36n;
export const EXP_SCALE = 10n ** 18n;
export const COMP_INITIAL_INDEX = DOUBLE_SCALE;

export interface V2MarketBoundaryState {
  supplyIndex: bigint;
  borrowIndex: bigint;
  marketBorrowIndex: bigint;
}

export function projectSupplyIndex(params: {
  storedIndex: bigint;
  stateBlock: bigint;
  boundaryBlock: bigint;
  speed: bigint;
  totalSupply: bigint;
}): bigint {
  const { storedIndex, stateBlock, boundaryBlock, speed, totalSupply } = params;
  if (boundaryBlock < stateBlock) {
    throw new Error('Supply state block is after boundary block');
  }
  const deltaBlocks = boundaryBlock - stateBlock;
  if (deltaBlocks === 0n || speed === 0n || totalSupply === 0n) {
    return storedIndex;
  }
  return storedIndex + (deltaBlocks * speed * DOUBLE_SCALE) / totalSupply;
}

export function projectBorrowIndex(params: {
  storedIndex: bigint;
  stateBlock: bigint;
  boundaryBlock: bigint;
  speed: bigint;
  totalBorrows: bigint;
  marketBorrowIndex: bigint;
}): bigint {
  const {
    storedIndex,
    stateBlock,
    boundaryBlock,
    speed,
    totalBorrows,
    marketBorrowIndex,
  } = params;
  if (boundaryBlock < stateBlock) {
    throw new Error('Borrow state block is after boundary block');
  }
  if (marketBorrowIndex === 0n) return storedIndex;
  const deltaBlocks = boundaryBlock - stateBlock;
  const normalizedBorrows = (totalBorrows * EXP_SCALE) / marketBorrowIndex;
  if (deltaBlocks === 0n || speed === 0n || normalizedBorrows === 0n) {
    return storedIndex;
  }
  return storedIndex + (deltaBlocks * speed * DOUBLE_SCALE) / normalizedBorrows;
}

export function pendingSupply(params: {
  projectedIndex: bigint;
  userIndex: bigint;
  userBalance: bigint;
}): bigint {
  const { projectedIndex, userBalance } = params;
  let { userIndex } = params;
  if (userIndex === 0n && projectedIndex >= COMP_INITIAL_INDEX) {
    userIndex = COMP_INITIAL_INDEX;
  }
  if (projectedIndex < userIndex) {
    throw new Error('Projected supply index is below user index');
  }
  return (userBalance * (projectedIndex - userIndex)) / DOUBLE_SCALE;
}

export function pendingBorrow(params: {
  projectedIndex: bigint;
  userIndex: bigint;
  borrowBalanceStored: bigint;
  marketBorrowIndex: bigint;
}): bigint {
  const { projectedIndex, borrowBalanceStored, marketBorrowIndex } = params;
  let { userIndex } = params;
  if (userIndex === 0n && projectedIndex >= COMP_INITIAL_INDEX) {
    userIndex = COMP_INITIAL_INDEX;
  }
  if (projectedIndex < userIndex) {
    throw new Error('Projected borrow index is below user index');
  }
  if (marketBorrowIndex === 0n) return 0n;
  const normalizedBorrow =
    (borrowBalanceStored * EXP_SCALE) / marketBorrowIndex;
  return (normalizedBorrow * (projectedIndex - userIndex)) / DOUBLE_SCALE;
}

export function periodReward(params: {
  distributedInRange: bigint;
  pendingAtEnd: bigint;
  pendingBeforeStart: bigint;
  marketIndexAtEnd?: bigint;
  marketIndexBeforeStart?: bigint;
}): bigint {
  if (
    params.marketIndexAtEnd !== undefined &&
    params.marketIndexBeforeStart !== undefined &&
    params.marketIndexAtEnd === params.marketIndexBeforeStart
  ) {
    return 0n;
  }
  const reward =
    params.distributedInRange + params.pendingAtEnd - params.pendingBeforeStart;
  if (reward < 0n) {
    throw new Error(`Negative period reward invariant: ${reward}`);
  }
  return reward;
}

export function fifoRemainingForPeriod(params: {
  earned: bigint;
  remaining: bigint;
}): bigint {
  if (params.earned < 0n || params.remaining < 0n) {
    throw new Error('FIFO reward amounts must be non-negative');
  }
  return params.earned < params.remaining ? params.earned : params.remaining;
}

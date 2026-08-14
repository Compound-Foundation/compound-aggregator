import {
  COMP_INITIAL_INDEX,
  DOUBLE_SCALE,
  EXP_SCALE,
  fifoRemainingForPeriod,
  pendingBorrow,
  pendingSupply,
  periodReward,
  projectBorrowIndex,
  projectSupplyIndex,
} from '../src/generation/period-rewards.math';

describe('Compound V2 period reward math', () => {
  it('projects the supply index with Solidity integer truncation', () => {
    const projected = projectSupplyIndex({
      storedIndex: COMP_INITIAL_INDEX,
      stateBlock: 100n,
      boundaryBlock: 110n,
      speed: 20n,
      totalSupply: 80n,
    });

    expect(projected).toBe(
      COMP_INITIAL_INDEX + (10n * 20n * DOUBLE_SCALE) / 80n,
    );
  });

  it('projects the borrow index using normalized borrows', () => {
    const projected = projectBorrowIndex({
      storedIndex: COMP_INITIAL_INDEX,
      stateBlock: 200n,
      boundaryBlock: 205n,
      speed: 30n,
      totalBorrows: 1_000n,
      marketBorrowIndex: 2n * EXP_SCALE,
    });
    const normalizedBorrows = 500n;

    expect(projected).toBe(
      COMP_INITIAL_INDEX + (5n * 30n * DOUBLE_SCALE) / normalizedBorrows,
    );
  });

  it('uses the initial index for untouched suppliers and borrowers', () => {
    const projected = COMP_INITIAL_INDEX + DOUBLE_SCALE / 10n;
    expect(
      pendingSupply({
        projectedIndex: projected,
        userIndex: 0n,
        userBalance: 100n,
      }),
    ).toBe(10n);
    expect(
      pendingBorrow({
        projectedIndex: projected,
        userIndex: 0n,
        borrowBalanceStored: 200n,
        marketBorrowIndex: 2n * EXP_SCALE,
      }),
    ).toBe(10n);
  });

  it('combines distributed deltas and boundary pending amounts', () => {
    expect(
      periodReward({
        distributedInRange: 100n,
        pendingAtEnd: 30n,
        pendingBeforeStart: 10n,
      }),
    ).toBe(120n);
  });

  it('rejects a negative period invariant instead of clamping it', () => {
    expect(() =>
      periodReward({
        distributedInRange: 0n,
        pendingAtEnd: 1n,
        pendingBeforeStart: 2n,
      }),
    ).toThrow('Negative period reward invariant');
  });

  it('returns zero when only pending rounding changes under an unchanged market index', () => {
    expect(
      periodReward({
        distributedInRange: 0n,
        pendingAtEnd: 15_443_377_821_831_897n,
        pendingBeforeStart: 15_443_394_130_774_214n,
        marketIndexAtEnd: 4_876_532_975n,
        marketIndexBeforeStart: 4_876_532_975n,
      }),
    ).toBe(0n);
  });

  it('attributes end debt to period earnings using FIFO', () => {
    expect(fifoRemainingForPeriod({ earned: 20n, remaining: 70n })).toBe(20n);
    expect(fifoRemainingForPeriod({ earned: 20n, remaining: 10n })).toBe(10n);
    expect(fifoRemainingForPeriod({ earned: 20n, remaining: 0n })).toBe(0n);
  });
});

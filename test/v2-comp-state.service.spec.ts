import { ethers } from 'ethers';

import {
  COMP_INITIAL_INDEX,
  DOUBLE_SCALE,
  EXP_SCALE,
} from '../src/generation/period-rewards.math';
import {
  V2CompStateService,
  V2MarketRewardBoundary,
  emptyPendingStats,
} from '../src/generation/v2-comp-state.service';

const comptroller = '0x00000000000000000000000000000000000000c0';
const market = '0x00000000000000000000000000000000000000a1';
const supplier = '0x00000000000000000000000000000000000000d1';
const idle = '0x00000000000000000000000000000000000000d2';
const borrower = '0x00000000000000000000000000000000000000d3';
const both = '0x00000000000000000000000000000000000000d4';

const comptrollerIface = new ethers.Interface([
  'function compSupplyState(address) view returns (uint224 index, uint32 blockNumber)',
  'function compBorrowState(address) view returns (uint224 index, uint32 blockNumber)',
  'function compSupplySpeeds(address) view returns (uint256)',
  'function compBorrowSpeeds(address) view returns (uint256)',
  'function compSpeeds(address) view returns (uint256)',
  'function compSupplierIndex(address,address) view returns (uint256)',
  'function compBorrowerIndex(address,address) view returns (uint256)',
]);
const cTokenIface = new ethers.Interface([
  'function totalSupply() view returns (uint256)',
  'function totalBorrows() view returns (uint256)',
  'function borrowIndex() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function borrowBalanceStored(address) view returns (uint256)',
]);

interface ChainState {
  supplyIndex: bigint;
  borrowIndex: bigint;
  marketBorrowIndex: bigint;
  balances: Record<string, bigint>;
  borrows: Record<string, bigint>;
  supplierIndexes: Record<string, bigint>;
  borrowerIndexes: Record<string, bigint>;
  deadMarket: boolean;
  /** Users whose comp*Index reads come back as reverted. */
  failIndexFor: Set<string>;
}

const emptyState = (): ChainState => ({
  supplyIndex: COMP_INITIAL_INDEX,
  borrowIndex: COMP_INITIAL_INDEX,
  marketBorrowIndex: EXP_SCALE,
  balances: {},
  borrows: {},
  supplierIndexes: {},
  borrowerIndexes: {},
  deadMarket: false,
  failIndexFor: new Set<string>(),
});

/**
 * Answers the encoded calls the service actually makes, so the test covers call
 * construction and decoding rather than a stubbed-out result shape.
 */
const makeHistorical = (state: ChainState) => {
  const seen: string[] = [];
  const fail = { success: false, returnData: '0x', error: 'reverted' };

  const respond = (call: { target: string; callData: string }) => {
    if (state.deadMarket) return fail;
    const isComptroller = call.target.toLowerCase() === comptroller;
    const iface = isComptroller ? comptrollerIface : cTokenIface;
    const parsed = iface.parseTransaction({ data: call.callData });
    if (!parsed) return fail;
    seen.push(parsed.name);

    const encode = (value: unknown[]) => ({
      success: true,
      returnData: iface.encodeFunctionResult(parsed.name, value),
    });
    const arg = (i: number) => String(parsed.args[i]).toLowerCase();

    switch (parsed.name) {
      case 'compSupplyState':
        return encode([state.supplyIndex, 1]);
      case 'compBorrowState':
        return encode([state.borrowIndex, 1]);
      case 'compSupplySpeeds':
      case 'compBorrowSpeeds':
      case 'compSpeeds':
        return encode([0n]);
      case 'compSupplierIndex':
        return state.failIndexFor.has(arg(1))
          ? fail
          : encode([state.supplierIndexes[arg(1)] ?? 0n]);
      case 'compBorrowerIndex':
        return state.failIndexFor.has(arg(1))
          ? fail
          : encode([state.borrowerIndexes[arg(1)] ?? 0n]);
      case 'totalSupply':
      case 'totalBorrows':
        return encode([1_000n]);
      case 'borrowIndex':
        return encode([state.marketBorrowIndex]);
      case 'balanceOf':
        return encode([state.balances[arg(0)] ?? 0n]);
      case 'borrowBalanceStored':
        return encode([state.borrows[arg(0)] ?? 0n]);
      default:
        return fail;
    }
  };

  return {
    seen,
    service: {
      callMany: jest.fn(
        async (params: {
          calls: Array<{ target: string; callData: string }>;
        }) => params.calls.map(respond),
      ),
    },
  };
};

const boundaryOf = (state: ChainState): V2MarketRewardBoundary => ({
  projectedSupplyIndex: state.supplyIndex,
  projectedBorrowIndex: state.borrowIndex,
  marketBorrowIndex: state.marketBorrowIndex,
});

describe('V2 comp state', () => {
  it('computes unrealized supply and borrow COMP and ignores empty positions', async () => {
    const state = emptyState();
    state.supplyIndex = COMP_INITIAL_INDEX + 2n * DOUBLE_SCALE;
    state.borrowIndex = COMP_INITIAL_INDEX + 4n * DOUBLE_SCALE;
    state.marketBorrowIndex = 2n * EXP_SCALE;
    state.balances[supplier] = 3n;
    state.supplierIndexes[supplier] = COMP_INITIAL_INDEX;
    state.borrows[borrower] = 10n;
    state.borrowerIndexes[borrower] = COMP_INITIAL_INDEX;

    const { service: historical } = makeHistorical(state);
    const service = new V2CompStateService({} as never, historical as never);
    const stats = emptyPendingStats();

    const pending = await service.readPendingByUser({
      network: 'mainnet',
      comptroller,
      market,
      users: [supplier, idle, borrower],
      blockTag: 100,
      boundary: boundaryOf(state),
      stats,
    });

    // 3 tokens * 2 index delta
    expect(pending.get(supplier)).toBe(6n);
    // 10 borrowed / 2e18 borrow index = 5 normalized, * 4 index delta
    expect(pending.get(borrower)).toBe(20n);
    expect(pending.has(idle)).toBe(false);
    expect(stats.failures).toBe(0);
    expect(stats.anomalies).toBe(0);
  });

  it('does not read a user index for a position that is closed', async () => {
    const state = emptyState();
    state.supplyIndex = COMP_INITIAL_INDEX + 2n * DOUBLE_SCALE;

    const { service: historical, seen } = makeHistorical(state);
    const service = new V2CompStateService({} as never, historical as never);

    await service.readPendingByUser({
      network: 'mainnet',
      comptroller,
      market,
      users: [idle],
      blockTag: 100,
      boundary: boundaryOf(state),
      stats: emptyPendingStats(),
    });

    expect(seen).toContain('balanceOf');
    expect(seen).toContain('borrowBalanceStored');
    expect(seen).not.toContain('compSupplierIndex');
    expect(seen).not.toContain('compBorrowerIndex');
  });

  it('reads only the side the user actually holds', async () => {
    const state = emptyState();
    state.supplyIndex = COMP_INITIAL_INDEX + 1n * DOUBLE_SCALE;
    state.balances[supplier] = 5n;
    state.supplierIndexes[supplier] = COMP_INITIAL_INDEX;

    const { service: historical, seen } = makeHistorical(state);
    const service = new V2CompStateService({} as never, historical as never);

    const pending = await service.readPendingByUser({
      network: 'mainnet',
      comptroller,
      market,
      users: [supplier],
      blockTag: 100,
      boundary: boundaryOf(state),
      stats: emptyPendingStats(),
    });

    expect(pending.get(supplier)).toBe(5n);
    expect(seen).toContain('compSupplierIndex');
    expect(seen).not.toContain('compBorrowerIndex');
  });

  // The index reads are a flat array where each user contributes 0, 1 or 2
  // entries, so a dual-sided user sitting between single-sided ones is the case
  // that catches a cursor that advances by the wrong amount.
  it('keeps indexes aligned across mixed single- and dual-sided users', async () => {
    const state = emptyState();
    state.supplyIndex = COMP_INITIAL_INDEX + 2n * DOUBLE_SCALE;
    state.borrowIndex = COMP_INITIAL_INDEX + 4n * DOUBLE_SCALE;
    state.marketBorrowIndex = 2n * EXP_SCALE;

    state.balances[supplier] = 3n;
    state.supplierIndexes[supplier] = COMP_INITIAL_INDEX;

    state.balances[both] = 5n;
    state.supplierIndexes[both] = COMP_INITIAL_INDEX + 1n * DOUBLE_SCALE;
    state.borrows[both] = 10n;
    state.borrowerIndexes[both] = COMP_INITIAL_INDEX;

    state.borrows[borrower] = 4n;
    state.borrowerIndexes[borrower] = COMP_INITIAL_INDEX + 2n * DOUBLE_SCALE;

    const { service: historical } = makeHistorical(state);
    const service = new V2CompStateService({} as never, historical as never);
    const stats = emptyPendingStats();

    const pending = await service.readPendingByUser({
      network: 'mainnet',
      comptroller,
      market,
      users: [supplier, both, borrower],
      blockTag: 100,
      boundary: boundaryOf(state),
      stats,
    });

    expect(pending.get(supplier)).toBe(6n); // 3 * 2
    expect(pending.get(both)).toBe(25n); // 5 * 1 supply + (10/2) * 4 borrow
    expect(pending.get(borrower)).toBe(4n); // (4/2) * 2
    expect(stats.failures).toBe(0);
  });

  it('keeps later users aligned when one user index read fails mid-list', async () => {
    const state = emptyState();
    state.supplyIndex = COMP_INITIAL_INDEX + 2n * DOUBLE_SCALE;
    state.borrowIndex = COMP_INITIAL_INDEX + 4n * DOUBLE_SCALE;
    state.marketBorrowIndex = 2n * EXP_SCALE;

    state.balances[supplier] = 3n;
    state.supplierIndexes[supplier] = COMP_INITIAL_INDEX;
    state.balances[both] = 5n;
    state.supplierIndexes[both] = COMP_INITIAL_INDEX + 1n * DOUBLE_SCALE;
    state.borrows[both] = 10n;
    state.borrowerIndexes[both] = COMP_INITIAL_INDEX;
    state.borrows[borrower] = 4n;
    state.borrowerIndexes[borrower] = COMP_INITIAL_INDEX + 2n * DOUBLE_SCALE;

    state.failIndexFor.add(both);

    const { service: historical } = makeHistorical(state);
    const service = new V2CompStateService({} as never, historical as never);
    const stats = emptyPendingStats();

    const pending = await service.readPendingByUser({
      network: 'mainnet',
      comptroller,
      market,
      users: [supplier, both, borrower],
      blockTag: 100,
      boundary: boundaryOf(state),
      stats,
    });

    expect(pending.has(both)).toBe(false);
    expect(pending.get(supplier)).toBe(6n);
    // The dual-sided user consumed two result slots even though it failed.
    expect(pending.get(borrower)).toBe(4n);
    expect(stats.failures).toBe(1);
  });

  it('keeps one side when the other throws an anomaly', async () => {
    const state = emptyState();
    state.supplyIndex = COMP_INITIAL_INDEX + 2n * DOUBLE_SCALE;
    state.borrowIndex = COMP_INITIAL_INDEX + 4n * DOUBLE_SCALE;
    state.marketBorrowIndex = 2n * EXP_SCALE;

    state.balances[both] = 5n;
    // Above the market index: pendingSupply rejects this.
    state.supplierIndexes[both] = COMP_INITIAL_INDEX + 9n * DOUBLE_SCALE;
    state.borrows[both] = 10n;
    state.borrowerIndexes[both] = COMP_INITIAL_INDEX;

    const { service: historical } = makeHistorical(state);
    const service = new V2CompStateService({} as never, historical as never);
    const stats = emptyPendingStats();

    const pending = await service.readPendingByUser({
      network: 'mainnet',
      comptroller,
      market,
      users: [both],
      blockTag: 100,
      boundary: boundaryOf(state),
      stats,
    });

    // The healthy borrow side survives instead of being discarded with it.
    expect(pending.get(both)).toBe(20n);
    expect(stats.anomalies).toBe(1);
  });

  it('returns no boundary when the market state cannot be read', async () => {
    const state = emptyState();
    state.deadMarket = true;

    const { service: historical } = makeHistorical(state);
    const service = new V2CompStateService({} as never, historical as never);

    const boundary = await service.readMarketBoundary({
      network: 'mainnet',
      comptroller,
      market,
      blockTag: 100,
    });

    expect(boundary).toBeNull();
  });

  it('projects the boundary from stored state when speeds are zero', async () => {
    const state = emptyState();
    state.supplyIndex = COMP_INITIAL_INDEX + 7n * DOUBLE_SCALE;
    state.borrowIndex = COMP_INITIAL_INDEX + 9n * DOUBLE_SCALE;
    state.marketBorrowIndex = 3n * EXP_SCALE;

    const { service: historical } = makeHistorical(state);
    const service = new V2CompStateService({} as never, historical as never);

    const boundary = await service.readMarketBoundary({
      network: 'mainnet',
      comptroller,
      market,
      blockTag: 100,
    });

    expect(boundary).toEqual(boundaryOf(state));
  });
});

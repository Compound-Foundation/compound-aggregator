import {
  addUserAmount,
  remainingV2Owed,
  remainingV2OwedRows,
} from '../src/generation/v2-owes.math';

describe('V2 owed remaining', () => {
  it('adds checkpointed accrued and uncheckpointed pending', () => {
    expect(remainingV2Owed(100n, 25n)).toBe(125n);
  });

  it('accumulates pending from multiple markets onto the same user', () => {
    const pendingByUser = new Map<string, bigint>();
    addUserAmount(pendingByUser, '0xAbc', 10n);
    addUserAmount(pendingByUser, '0xabc', 7n);
    addUserAmount(pendingByUser, '0xdef', 3n);

    expect(pendingByUser.get('0xabc')).toBe(17n);
    expect(pendingByUser.get('0xdef')).toBe(3n);
  });

  it('builds one remaining row per user instead of last-market-wins', () => {
    const rows = remainingV2OwedRows({
      marketAddress: '0xcomptroller',
      users: ['0xAAA', '0xaaa', '0xbbb'],
      accruedByUser: new Map([
        ['0xaaa', 40n],
        ['0xbbb', 0n],
      ]),
      pendingByUser: new Map([
        ['0xaaa', 15n],
        ['0xbbb', 8n],
      ]),
    });

    expect(rows).toEqual([
      { marketAddress: '0xcomptroller', userAddress: '0xaaa', owed: 55n },
      { marketAddress: '0xcomptroller', userAddress: '0xbbb', owed: 8n },
    ]);
  });

  it('omits users with neither accrued nor pending debt', () => {
    expect(
      remainingV2OwedRows({
        marketAddress: '0xcomptroller',
        users: ['0xaaa'],
        accruedByUser: new Map(),
        pendingByUser: new Map(),
      }),
    ).toEqual([]);
  });
});

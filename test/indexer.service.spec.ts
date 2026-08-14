import { IndexerService } from '../src/indexer/indexer.service';
import { createSqliteApi } from '../src/indexer/sqlite-api';

describe('IndexerService adaptive log ordering', () => {
  it('processes the earlier half first after a log range is split', async () => {
    const provider = {
      getLogs: jest
        .fn()
        .mockImplementation(
          async (request: {
            fromBlock: number;
            toBlock: number;
          }): Promise<Array<{ blockNumber: number }>> => {
            if (request.fromBlock === 100_000 && request.toBlock === 100_999) {
              throw new Error('query returned more than 10000 results');
            }
            return [
              {
                blockNumber: request.fromBlock === 100_000 ? 100_400 : 100_800,
              },
            ];
          },
        ),
    };
    const service = new IndexerService({} as never, {} as never, {} as never);

    const logs = (await (service as any).getLogsAdaptive(provider, {
      address: [],
      fromBlock: 100_000,
      toBlock: 100_999,
      topics: [],
    })) as Array<{ blockNumber: number }>;

    expect(
      provider.getLogs.mock.calls.map(([request]) => [
        request.fromBlock,
        request.toBlock,
      ]),
    ).toEqual([
      [100_000, 100_999],
      [100_000, 100_499],
      [100_500, 100_999],
    ]);
    expect(logs.map((log) => log.blockNumber)).toEqual([100_400, 100_800]);
  });

  it('keeps the earliest created_at even when a later event is inserted first', () => {
    const sqlite = createSqliteApi(':memory:');
    try {
      const common = [
        'base',
        3,
        '0x00000000000000000000000000000000000000a1',
        '0x00000000000000000000000000000000000000b2',
      ] as const;
      sqlite.txUpsertUsers([
        [...common, 100_800],
        [...common, 100_400],
      ]);

      const rows = sqlite.fetchUsersPageByNetworkAndVersion.all(
        'base',
        3,
        10,
        0,
      ) as Array<{ created_at: number }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.created_at).toBe(100_400);
    } finally {
      sqlite.db.close();
    }
  });
});

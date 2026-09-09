import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RangeFile } from '../src/generation/period-rewards.types';
import { UpdateRangesV3Command } from '../src/generation/update-ranges-v3.command';

const CURRENT_END_BLOCK = 1000;

const buildRangesFile = (): RangeFile =>
  ({
    v2: [
      {
        network: 'mainnet',
        chainId: 1,
        startBlock: 50,
        endBlock: 900,
      },
    ],
    v3: [
      {
        network: 'mainnet',
        chainId: 1,
        startBlock: 100,
        endBlock: CURRENT_END_BLOCK,
        markets: [
          {
            symbol: 'cUSDCv3',
            address: '0x00000000000000000000000000000000000000a1',
            startBlock: 100,
          },
        ],
      },
    ],
  } as unknown as RangeFile);

/**
 * Runs the command against a throwaway ranges.json and hands back whatever the
 * command left on disk, so a test can assert on the file rather than on logs.
 */
const runInTempDir = async (
  head: number,
): Promise<{ error: Error | null; written: RangeFile }> => {
  const temp = mkdtempSync(join(tmpdir(), 'compound-ranges-'));
  const originalCwd = process.cwd();
  process.chdir(temp);

  try {
    writeFileSync(
      join(temp, 'ranges.json'),
      `${JSON.stringify(buildRangesFile(), null, 2)}\n`,
      'utf8',
    );

    const networks = {
      byName: jest.fn().mockReturnValue({ chainId: 1, reorgWindow: 64 }),
    };
    const providers = {
      get: jest.fn().mockReturnValue({
        getBlockNumber: jest.fn().mockResolvedValue(head),
      }),
    };
    const command = new UpdateRangesV3Command(
      networks as never,
      providers as never,
    );

    let error: Error | null = null;
    try {
      await command.run([], {});
    } catch (caught) {
      error = caught as Error;
    }

    return {
      error,
      written: JSON.parse(
        readFileSync(join(temp, 'ranges.json'), 'utf8'),
      ) as RangeFile,
    };
  } finally {
    process.chdir(originalCwd);
    rmSync(temp, { recursive: true, force: true });
  }
};

describe('UpdateRangesV3Command', () => {
  it('advances endBlock to the finalized head', async () => {
    const { error, written } = await runInTempDir(2000);

    expect(error).toBeNull();
    expect(written.v3[0]!.endBlock).toBe(2000 - 64);
  });

  // A load balancer can answer from a lagging replica. Writing that head back
  // would narrow the range and silently drop rewards already accounted for.
  it('refuses to move endBlock backwards and leaves the file untouched', async () => {
    const { error, written } = await runInTempDir(CURRENT_END_BLOCK);

    expect(error?.message).toContain('ranges.json not written');
    expect(written.v3[0]!.endBlock).toBe(CURRENT_END_BLOCK);
  });

  it('accepts a head that leaves endBlock unchanged', async () => {
    const { error, written } = await runInTempDir(CURRENT_END_BLOCK + 64);

    expect(error).toBeNull();
    expect(written.v3[0]!.endBlock).toBe(CURRENT_END_BLOCK);
  });

  it('leaves the V2 section alone', async () => {
    const { written } = await runInTempDir(2000);

    expect(written.v2[0]!.endBlock).toBe(900);
  });
});

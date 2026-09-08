import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RuntimeDbService } from '../src/indexer/runtime-db.service';
import { IndexerConfig } from '../src/indexer/indexer.types';
import { UsersManifest } from '../src/indexer/manifests.service';

const emptyManifest = (): UsersManifest => ({ chunkRows: 10_000, series: [] });

const manifestWithChunk = (): UsersManifest => ({
  chunkRows: 10_000,
  series: [
    {
      network: 'mainnet',
      version: 2,
      lastCreatedAt: 1,
      chunks: [{ file: 'v2_mainnet_0000.sqlite', rows: 1, endCreatedAt: 1 }],
    },
  ],
});

/**
 * Builds a service wired to a throwaway storage dir, with only the pieces
 * assembleRuntime() actually touches.
 */
const makeService = (params: {
  storageDir: string;
  manifest: UsersManifest;
}) => {
  const cfg: IndexerConfig = {
    repoMetaPath: path.join(params.storageDir, 'meta.sqlite'),
    repoUsersDir: path.join(params.storageDir, 'users'),
    manifestPath: path.join(params.storageDir, 'users', 'manifest.json'),
    runtimeDir: path.join(params.storageDir, 'runtime'),
    runtimePath: path.join(params.storageDir, 'runtime', 'runtime.sqlite'),
  };
  const config = {
    get: () => [],
    getOrThrow: () => cfg,
  };
  const manifestSvc = { value: params.manifest };

  return {
    cfg,
    service: new RuntimeDbService(
      config as never,
      manifestSvc as never,
      {} as never,
    ),
  };
};

describe('runtime DB cold start', () => {
  let storageDir: string;
  const previousEnv = process.env.ALLOW_COLD_START;

  beforeEach(() => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compound-storage-'));
    fs.mkdirSync(path.join(storageDir, 'users'), { recursive: true });
    delete process.env.ALLOW_COLD_START;
  });

  afterEach(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
    if (previousEnv === undefined) delete process.env.ALLOW_COLD_START;
    else process.env.ALLOW_COLD_START = previousEnv;
  });

  it('refuses to index from scratch unless cold start is asked for', () => {
    const { service } = makeService({ storageDir, manifest: emptyManifest() });

    // The usual cause in CI is an artifacts checkout that came back empty, and
    // a silent re-index would push a stub snapshot over the good one.
    expect(() => (service as any).assembleRuntime()).toThrow(
      /meta\.sqlite not found.*ALLOW_COLD_START=1/s,
    );
  });

  it('starts empty when cold start is explicitly enabled', () => {
    process.env.ALLOW_COLD_START = '1';
    const { service } = makeService({ storageDir, manifest: emptyManifest() });

    expect(() => (service as any).assembleRuntime()).not.toThrow();
  });

  it('rejects declared chunks without meta even with cold start enabled', () => {
    process.env.ALLOW_COLD_START = '1';
    const { service } = makeService({
      storageDir,
      manifest: manifestWithChunk(),
    });

    expect(() => (service as any).assembleRuntime()).toThrow(
      /Corrupt snapshot/,
    );
  });

  it('rejects chunk files on disk that the manifest does not declare', () => {
    process.env.ALLOW_COLD_START = '1';
    // A snapshot whose manifest.json failed to arrive still has its chunks;
    // treating that as "empty" would overwrite it on the next sync.
    fs.writeFileSync(
      path.join(storageDir, 'users', 'v2_mainnet_0000.sqlite'),
      '',
    );
    const { service } = makeService({ storageDir, manifest: emptyManifest() });

    expect(() => (service as any).assembleRuntime()).toThrow(
      /Corrupt snapshot/,
    );
  });

  it('ignores non-chunk files in the users dir', () => {
    process.env.ALLOW_COLD_START = '1';
    fs.writeFileSync(
      path.join(storageDir, 'users', 'manifest.json'),
      JSON.stringify(emptyManifest()),
    );
    const { service } = makeService({ storageDir, manifest: emptyManifest() });

    expect(() => (service as any).assembleRuntime()).not.toThrow();
  });
});

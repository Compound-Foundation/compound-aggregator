import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChunksService } from '../src/indexer/chunks.service';
import { ManifestsService } from '../src/indexer/manifests.service';

describe('ChunksService storage validation', () => {
  const createUsersDb = (file: string, withUser: boolean): void => {
    const db = new Database(file);
    db.exec(`
      CREATE TABLE users (
        network TEXT NOT NULL,
        version INTEGER NOT NULL,
        market TEXT NOT NULL,
        user TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (network, version, market, user)
      );
    `);
    if (withUser) {
      db.prepare(
        `INSERT INTO users(network, version, market, user, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).run('base', 3, '0xmarket', '0xuser', 1234);
    }
    db.close();
  };

  it('rejects a chunk declared by the manifest when its file is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'compound-chunks-'));
    try {
      const manifestPath = join(root, 'manifest.json');
      const chunkPath = join(root, 'v3_base_0000.sqlite');
      writeFileSync(
        manifestPath,
        JSON.stringify({
          chunkRows: 10_000,
          series: [
            {
              network: 'base',
              version: 3,
              lastCreatedAt: 1234,
              chunks: [
                {
                  file: 'v3_base_0000.sqlite',
                  rows: 1,
                  endCreatedAt: 1234,
                },
              ],
            },
          ],
        }),
      );
      createUsersDb(chunkPath, true);
      const manifests = new ManifestsService();
      manifests.load(manifestPath);
      const service = new ChunksService(manifests);

      expect(() => service.validateManifestChunks(root)).not.toThrow();
      unlinkSync(chunkPath);
      expect(() => service.validateManifestChunks(root)).toThrow(
        'declared chunk is missing: v3_base_0000.sqlite',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a runtime DB that does not contain a declared user row', () => {
    const root = mkdtempSync(join(tmpdir(), 'compound-chunks-'));
    try {
      const manifestPath = join(root, 'manifest.json');
      const chunkPath = join(root, 'v3_base_0000.sqlite');
      const runtimePath = join(root, 'runtime.sqlite');
      writeFileSync(
        manifestPath,
        JSON.stringify({
          chunkRows: 10_000,
          series: [
            {
              network: 'base',
              version: 3,
              lastCreatedAt: 1234,
              chunks: [
                {
                  file: 'v3_base_0000.sqlite',
                  rows: 1,
                  endCreatedAt: 1234,
                },
              ],
            },
          ],
        }),
      );
      createUsersDb(chunkPath, true);
      createUsersDb(runtimePath, false);
      const manifests = new ManifestsService();
      manifests.load(manifestPath);
      const service = new ChunksService(manifests);
      const runtimeDb = new Database(runtimePath);

      expect(() =>
        service.assertRuntimeContainsManifestUsers({
          runtimeDb,
          repoUsersDir: root,
        }),
      ).toThrow('runtime DB is missing 1 user row(s)');
      runtimeDb.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

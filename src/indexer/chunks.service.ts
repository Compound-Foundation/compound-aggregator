import { Injectable, Logger } from '@nestjs/common';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import {
  ManifestsService,
  UsersChunkInfo,
  UsersSeries,
} from './manifests.service';
import { SqliteDatabase } from './indexer.types';
import { shouldLogPct } from '../common/utils/should-log-pct';

@Injectable()
export class ChunksService {
  private readonly logger = new Logger(ChunksService.name);

  constructor(private readonly manifestSvc: ManifestsService) {}

  public validateManifestChunks(repoUsersDir: string): void {
    const root = path.resolve(repoUsersDir);
    const seenFiles = new Set<string>();
    const seenSeries = new Set<string>();

    for (const series of this.manifestSvc.value.series) {
      const seriesKey = `${series.network}:v${series.version}`;
      if (seenSeries.has(seriesKey)) {
        throw new Error(`[users-storage] duplicate series: ${seriesKey}`);
      }
      seenSeries.add(seriesKey);

      for (const chunk of series.chunks) {
        if (seenFiles.has(chunk.file)) {
          throw new Error(
            `[users-storage] duplicate chunk declaration: ${chunk.file}`,
          );
        }
        seenFiles.add(chunk.file);

        const chunkPath = path.resolve(root, chunk.file);
        if (chunkPath !== root && !chunkPath.startsWith(`${root}${path.sep}`)) {
          throw new Error(
            `[users-storage] chunk escapes users directory: ${chunk.file}`,
          );
        }
        if (!fs.existsSync(chunkPath)) {
          throw new Error(
            `[users-storage] declared chunk is missing: ${chunk.file} (${seriesKey})`,
          );
        }

        const db = new Database(chunkPath, {
          readonly: true,
          fileMustExist: true,
        });
        try {
          const stats = db
            .prepare(
              `
                SELECT
                  COUNT(*) AS rows,
                  SUM(CASE WHEN network != ? OR version != ? THEN 1 ELSE 0 END) AS foreign_rows,
                  MAX(created_at) AS max_created_at
                FROM users
              `,
            )
            .get(series.network, series.version) as {
            rows: number;
            foreign_rows: number | null;
            max_created_at: number | null;
          };
          if (Number(stats.rows) !== chunk.rows) {
            throw new Error(
              `[users-storage] row count mismatch for ${chunk.file}: manifest=${chunk.rows} actual=${stats.rows}`,
            );
          }
          if (Number(stats.foreign_rows ?? 0) !== 0) {
            throw new Error(
              `[users-storage] ${chunk.file} contains rows outside ${seriesKey}`,
            );
          }
          if (
            chunk.rows > 0 &&
            Number(stats.max_created_at) !== chunk.endCreatedAt
          ) {
            throw new Error(
              `[users-storage] endCreatedAt mismatch for ${chunk.file}: manifest=${chunk.endCreatedAt} actual=${stats.max_created_at}`,
            );
          }
        } catch (error) {
          throw new Error(
            `[users-storage] invalid chunk ${chunk.file}: ${
              (error as Error).message
            }`,
          );
        } finally {
          db.close();
        }
      }
    }
  }

  public assertRuntimeContainsManifestUsers(args: {
    runtimeDb: SqliteDatabase;
    repoUsersDir: string;
  }): void {
    const { runtimeDb, repoUsersDir } = args;
    let chunkIndex = 0;
    for (const series of this.manifestSvc.value.series) {
      for (const chunk of series.chunks) {
        const alias = `users_check_${chunkIndex++}`;
        const chunkPath = path.resolve(repoUsersDir, chunk.file);
        runtimeDb.exec(
          `ATTACH '${chunkPath.replaceAll("'", "''")}' AS ${alias}`,
        );
        try {
          const missing = runtimeDb
            .prepare(
              `
                SELECT COUNT(*) AS rows
                FROM ${alias}.users AS source
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM main.users AS runtime
                  WHERE runtime.network = source.network
                    AND runtime.version = source.version
                    AND runtime.market = source.market
                    AND runtime.user = source.user
                )
              `,
            )
            .get() as { rows: number };
          if (Number(missing.rows) > 0) {
            throw new Error(
              `[users-storage] runtime DB is missing ${missing.rows} user row(s) from ${chunk.file}; remove the runtime DB and assemble it again`,
            );
          }
        } finally {
          runtimeDb.exec(`DETACH ${alias}`);
        }
      }
    }
  }

  private ensureUsersChunkSchema(db: SqliteDatabase): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        network TEXT NOT NULL,
        version INTEGER NOT NULL,
        market  TEXT NOT NULL,
        user    TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (network, version, market, user)
      );
      CREATE INDEX IF NOT EXISTS idx_users_net_ver_market ON users(network, version, market);
      CREATE INDEX IF NOT EXISTS idx_users_cursor ON users(network, version, created_at, market, user);
    `);
  }

  private openChunkDb(chunkPath: string): SqliteDatabase {
    fs.mkdirSync(path.dirname(chunkPath), { recursive: true });
    const db = new Database(chunkPath);
    db.pragma('journal_mode = DELETE'); // IMPORTANT: no -wal/-shm in repo
    db.pragma('synchronous = FULL');
    this.ensureUsersChunkSchema(db);
    return db;
  }

  private getActiveChunk(
    series: UsersSeries,
  ): { info: UsersChunkInfo; index: number } | null {
    if (series.chunks.length === 0) return null;
    return {
      info: series.chunks[series.chunks.length - 1]!,
      index: series.chunks.length - 1,
    };
  }

  public flushNewUsersFromRuntime(args: {
    runtimeDb: SqliteDatabase;
    repoUsersDir: string;
  }): void {
    const { runtimeDb, repoUsersDir } = args;

    const combos = runtimeDb
      .prepare(
        `SELECT DISTINCT network, version FROM users ORDER BY network ASC, version ASC`,
      )
      .all() as Array<{ network: string; version: number }>;

    const manifest = this.manifestSvc.value;

    for (const c of combos) {
      const network = c.network;
      const version = c.version as 2 | 3;

      const series = this.manifestSvc.getOrCreateSeries(network, version);
      const watermark = series.lastCreatedAt ?? 0;

      const newRows = runtimeDb
        .prepare(
          `
        SELECT network, version, market, user, created_at
        FROM users
        WHERE network = ? AND version = ? AND created_at > ?
        ORDER BY created_at ASC, market ASC, user ASC
      `,
        )
        .all(network, version, watermark) as Array<any>;

      if (newRows.length === 0) continue;

      const pctTotal = newRows.length;
      let pctProcessed = 0;
      let pctInserted = 0;
      let pctLast = -1;

      this.logger.verbose(
        `[flush][${network}/v${version}] 0% (newRows=${pctTotal} watermark=${watermark} chunkRows=${manifest.chunkRows})`,
      );

      let active = this.getActiveChunk(series);
      if (!active) {
        const file = this.manifestSvc.chunkFileName(network, version, 0);
        series.chunks.push({ file, rows: 0, endCreatedAt: 0 });
        active = this.getActiveChunk(series)!;
      }

      let chunkDb = this.openChunkDb(path.join(repoUsersDir, active.info.file));
      let insert = chunkDb.prepare(`
        INSERT INTO users(network, version, market, user, created_at)
        VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(network, version, market, user) DO NOTHING
      `);

      const openNewChunk = () => {
        chunkDb.close();

        const nextIdx = series.chunks.length;
        const file = this.manifestSvc.chunkFileName(network, version, nextIdx);
        series.chunks.push({
          file,
          rows: 0,
          endCreatedAt: series.lastCreatedAt,
        });

        active = this.getActiveChunk(series)!;
        chunkDb = this.openChunkDb(path.join(repoUsersDir, active!.info.file));
        insert = chunkDb.prepare(`
        INSERT INTO users(network, version, market, user, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(network, version, market, user) DO NOTHING
      `);
      };

      try {
        chunkDb.exec('BEGIN');

        for (const r of newRows) {
          pctProcessed += 1;

          const createdAt = Number(r.created_at);

          if (createdAt < series.lastCreatedAt) {
            throw new Error(
              `[flush] Non-monotonic created_at for ${network}/v${version}: ${createdAt} < watermark ${series.lastCreatedAt}`,
            );
          }

          const res = insert.run(
            r.network,
            r.version,
            r.market,
            r.user,
            createdAt,
          );
          if (res.changes === 1) {
            active!.info.rows += 1;
            pctInserted += 1;
          }

          active!.info.endCreatedAt = createdAt;
          series.lastCreatedAt = createdAt;

          const pct = Math.floor((pctProcessed * 100) / pctTotal);
          if (shouldLogPct(pctLast, pct, 5)) {
            pctLast = pct;
            this.logger.verbose(
              `[flush][${network}/v${version}] ${pct}% processed=${pctProcessed}/${pctTotal} inserted=${pctInserted} activeChunk=${
                active!.info.file
              } activeRows=${active!.info.rows}`,
            );
          }

          if (active!.info.rows >= manifest.chunkRows) {
            chunkDb.exec('COMMIT');
            openNewChunk();
            chunkDb.exec('BEGIN');
          }
        }

        chunkDb.exec('COMMIT');
      } catch (e) {
        try {
          chunkDb.exec('ROLLBACK');
        } catch {}
        throw e;
      } finally {
        chunkDb.close();
      }
    }
  }
}

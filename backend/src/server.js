import mysql from 'mysql2/promise';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { closePool } from './config/database.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function maybeAutoMigrate() {
  if (!env.dbAutoMigrate || env.isProd) return;
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  const sql = await readFile(schemaPath, 'utf8');
  const conn = await mysql.createConnection({
    host: env.mysql.host,
    port: env.mysql.port,
    user: env.mysql.user,
    password: env.mysql.password,
    database: env.mysql.database,
    multipleStatements: true,
  });
  try {
    await conn.query(sql);
  } finally {
    await conn.end();
  }
}

async function maybeEnsureProjectScansUserId() {
  // In this project, scans are written to `project_scans` and we want the Audit log UI
  // to show who ran each scan. Older DBs may not have `project_scans.user_id`.
  if (env.isProd) return;

  const conn = await mysql.createConnection({
    host: env.mysql.host,
    port: env.mysql.port,
    user: env.mysql.user,
    password: env.mysql.password,
    database: env.mysql.database,
    multipleStatements: true,
  });

  try {
    const [rows] = await conn.query(
      `
      SELECT COUNT(*) AS cnt
      FROM information_schema.columns
      WHERE table_schema = ?
        AND table_name = 'project_scans'
        AND column_name = 'user_id'
      `,
      [env.mysql.database],
    );

    const hasColumn = Number(rows?.[0]?.cnt || 0) > 0;
    if (!hasColumn) {
      await conn.query(`ALTER TABLE project_scans ADD COLUMN user_id VARCHAR(191) NULL`);
    }

    // Backfill for older scans so audit rows still have a "runner".
    await conn.query(`
      UPDATE project_scans ps
      JOIN projects p ON p.id = ps.project_id
      SET ps.user_id = p.user_id
      WHERE ps.user_id IS NULL
    `);
  } catch (e) {
    // Never prevent dev server boot due to an audit column mismatch.
    console.warn('[db:migrate] audit migration skipped', e instanceof Error ? e.message : String(e));
  } finally {
    await conn.end();
  }
}

async function main() {
  await maybeAutoMigrate();
  await maybeEnsureProjectScansUserId();

  const app = createApp();
  const server = app.listen(env.port, () => {
    console.log(`Signal API listening on port ${env.port} (${env.nodeEnv})`);
  });

  const shutdown = async (signal) => {
    console.log(`${signal} received, shutting down…`);
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

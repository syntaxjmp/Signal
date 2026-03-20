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

async function maybeEnsureResolutionTables() {
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
    // Add status column to project_findings if missing
    const [statusRows] = await conn.query(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.columns
       WHERE table_schema = ?
         AND table_name = 'project_findings'
         AND column_name = 'status'`,
      [env.mysql.database],
    );
    if (Number(statusRows?.[0]?.cnt || 0) === 0) {
      await conn.query(
        `ALTER TABLE project_findings
         ADD COLUMN status ENUM('open', 'in_progress', 'resolved') NOT NULL DEFAULT 'open'`,
      );
    }

    // Create resolution_jobs table if missing
    await conn.query(`
      CREATE TABLE IF NOT EXISTS resolution_jobs (
        id CHAR(36) NOT NULL,
        project_id CHAR(36) NOT NULL,
        user_id VARCHAR(191) NOT NULL,
        status ENUM('pending', 'running', 'completed', 'failed') NOT NULL DEFAULT 'pending',
        finding_ids JSON NOT NULL,
        pr_url VARCHAR(1024) NULL,
        branch_name VARCHAR(255) NULL,
        error_message TEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_resolution_jobs_project (project_id),
        KEY idx_resolution_jobs_status (status),
        CONSTRAINT fk_resolution_jobs_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  } catch (e) {
    console.warn('[db:migrate] resolution tables migration skipped', e instanceof Error ? e.message : String(e));
  } finally {
    await conn.end();
  }
}

async function maybeEnsureUserWebhookTable() {
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
    await conn.query(`
      CREATE TABLE IF NOT EXISTS user_webhooks (
        id CHAR(36) NOT NULL,
        user_id VARCHAR(191) NOT NULL,
        webhook_url VARCHAR(2048) NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_user_webhooks_user (user_id),
        KEY idx_user_webhooks_active (is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  } catch (e) {
    console.warn('[db:migrate] user_webhooks migration skipped', e instanceof Error ? e.message : String(e));
  } finally {
    await conn.end();
  }
}

async function main() {
  await maybeAutoMigrate();
  await maybeEnsureProjectScansUserId();
  await maybeEnsureResolutionTables();
  await maybeEnsureUserWebhookTable();

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

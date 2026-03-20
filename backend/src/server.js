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

async function main() {
  await maybeAutoMigrate();

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

import { betterAuth } from 'better-auth';
import { createPool } from 'mysql2/promise';
import { env } from './config/env.js';

const pool = createPool({
  host: env.mysql.host,
  port: env.mysql.port,
  user: env.mysql.user,
  password: env.mysql.password,
  database: env.mysql.database,
  waitForConnections: true,
  connectionLimit: env.mysql.connectionLimit,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  timezone: 'Z',
});

export const auth = betterAuth({
  database: pool,
  secret: env.auth.secret,
  baseURL: env.auth.baseURL,
  trustedOrigins: env.auth.trustedOrigins,
  emailAndPassword: {
    enabled: true,
  },
});

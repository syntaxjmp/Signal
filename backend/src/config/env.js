import dotenv from 'dotenv';

dotenv.config();

function required(name, value) {
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const nodeEnv = process.env.NODE_ENV || 'development';

const corsOriginsRaw = process.env.CORS_ORIGINS;
const corsOrigins = corsOriginsRaw
  ? corsOriginsRaw.split(',').map((s) => s.trim()).filter(Boolean)
  : [];

const trustedRaw =
  process.env.BETTER_AUTH_TRUSTED_ORIGINS || process.env.CORS_ORIGINS || '';
let trustedOrigins = trustedRaw
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (trustedOrigins.length === 0 && nodeEnv !== 'production') {
  trustedOrigins = ['http://localhost:3000', 'http://localhost:3001'];
}

const betterAuthSecret = required('BETTER_AUTH_SECRET', process.env.BETTER_AUTH_SECRET);
if (betterAuthSecret.length < 32) {
  throw new Error('BETTER_AUTH_SECRET must be at least 32 characters (use: openssl rand -base64 32)');
}

const betterAuthURL = required('BETTER_AUTH_URL', process.env.BETTER_AUTH_URL).replace(/\/$/, '');

export const env = {
  nodeEnv,
  isProd: nodeEnv === 'production',
  /** Default 4000 so Next.js can own :3000 in local dev (use PORT in .env to override). */
  port: Number(process.env.PORT) || 4000,
  corsOrigins,
  auth: {
    secret: betterAuthSecret,
    baseURL: betterAuthURL,
    trustedOrigins,
  },
  mysql: {
    host: required('MYSQL_HOST', process.env.MYSQL_HOST),
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: required('MYSQL_USER', process.env.MYSQL_USER),
    password: process.env.MYSQL_PASSWORD ?? '',
    database: required('MYSQL_DATABASE', process.env.MYSQL_DATABASE),
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT) || 10,
  },
  dbAutoMigrate: process.env.DB_AUTO_MIGRATE === '1',
  openAi: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  },
  github: {
    token: process.env.GITHUB_TOKEN || '',
  },
};

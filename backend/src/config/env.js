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

export const env = {
  nodeEnv,
  isProd: nodeEnv === 'production',
  port: Number(process.env.PORT) || 3000,
  corsOrigins,
  mysql: {
    host: required('MYSQL_HOST', process.env.MYSQL_HOST),
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: required('MYSQL_USER', process.env.MYSQL_USER),
    password: process.env.MYSQL_PASSWORD ?? '',
    database: required('MYSQL_DATABASE', process.env.MYSQL_DATABASE),
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT) || 10,
  },
  dbAutoMigrate: process.env.DB_AUTO_MIGRATE === '1',
};

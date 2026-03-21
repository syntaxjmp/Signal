import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import { toNodeHandler } from 'better-auth/node';
import { env } from './config/env.js';
import { auth } from './auth.js';
import { apiRouter } from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  const corsOptions =
    env.corsOrigins.length > 0
      ? { origin: env.corsOrigins, credentials: true }
      : env.isProd
        ? { origin: false }
        : { origin: true, credentials: true };
  app.use(cors(corsOptions));
  app.use(compression());
  app.use(morgan(env.isProd ? 'combined' : 'dev'));

  app.all('/api/auth/*', toNodeHandler(auth));

  /** Large limit for VS Code extension workspace-scan payloads (many small files). */
  app.use(express.json({ limit: '25mb' }));

  app.use('/api', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

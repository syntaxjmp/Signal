import { Router } from 'express';
import { healthRouter } from './health.js';
import { sessionRouter } from './session.js';
import { vulnerabilityChecksRouter } from './vulnerabilityChecks.js';

export const apiRouter = Router();

apiRouter.use(healthRouter);
apiRouter.use(sessionRouter);
apiRouter.use(vulnerabilityChecksRouter);

apiRouter.get('/', (_req, res) => {
  res.json({
    name: 'Signal API',
    version: '0.1.0',
  });
});

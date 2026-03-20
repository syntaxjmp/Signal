import { Router } from 'express';
import { pingDatabase } from '../config/database.js';

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

healthRouter.get('/health/ready', async (_req, res) => {
  try {
    await pingDatabase();
    res.json({ status: 'ready', database: 'up' });
  } catch (e) {
    res.status(503).json({ status: 'not_ready', database: 'down' });
  }
});

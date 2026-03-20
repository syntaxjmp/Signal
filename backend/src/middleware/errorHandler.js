import { env } from '../config/env.js';

export function notFoundHandler(_req, res) {
  res.status(404).json({ error: 'Not found' });
}

export function errorHandler(err, _req, res, _next) {
  const status = Number(err.status) || 500;
  const payload = {
    error: status === 500 ? 'Internal server error' : err.message || 'Error',
  };
  if (!env.isProd && err.stack) {
    payload.stack = err.stack;
  }
  res.status(status).json(payload);
}

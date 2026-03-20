import { env } from '../config/env.js';

export function notFoundHandler(_req, res) {
  res.status(404).json({ error: 'Not found' });
}

export function errorHandler(err, req, res, _next) {
  const status = Number(err.status) || 500;
  if (!res.headersSent) {
    console.error(
      `[error] ${req?.method || "?"} ${req?.originalUrl || "?"} status=${status} message=${err?.message || "Unknown error"}`,
    );
    if (!env.isProd && err?.stack) {
      console.error(err.stack);
    }
  }
  const payload = {
    error: status === 500 ? 'Internal server error' : err.message || 'Error',
  };
  if (!env.isProd && err.stack) {
    payload.stack = err.stack;
  }
  res.status(status).json(payload);
}

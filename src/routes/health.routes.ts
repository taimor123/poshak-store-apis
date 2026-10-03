import { Router } from 'express';
import { success } from '../http/errors.js';
import { health } from '../services/health.service.js';

export const healthRouter = Router();

// public: liveness probe for Railway / uptime checks (DB ping included)
healthRouter.get('/', async (_req, res) => {
  const h = await health();
  res.status(h.status === 'ok' ? 200 : 503).json(success(h));
});

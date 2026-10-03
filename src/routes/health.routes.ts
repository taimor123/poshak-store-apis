import { Router } from 'express';
import { success } from '../http/errors.js';

export const healthRouter = Router();

/** Liveness probe for Railway / uptime checks. */
healthRouter.get('/', (_req, res) => {
  res.json(success({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) }));
});

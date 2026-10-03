import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Env } from './config/env.js';
import { logger } from './logger.js';
import { errorHandler, notFound } from './http/middleware/error.js';
import { healthRouter } from './routes/health.routes.js';

/**
 * Builds the Express app without listening, so tests can drive it directly.
 * Layering (docs/BACKEND/BACKEND_ARCHITECTURE.md): routes → thin controllers →
 * src/services (all domain logic) → Prisma. Controllers never touch Prisma.
 */
export function createApp(env: Env) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
    }),
  );
  app.use(helmet());
  // Exact-origin CORS with credentials (JWT cookie). No wildcards.
  app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '100kb' }));

  const v1 = express.Router();
  v1.use('/health', healthRouter);
  // Next: catalog, cart, orders, auth, admin routers (docs/BACKEND/API_ENDPOINTS.md).
  app.use('/api/v1', v1);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

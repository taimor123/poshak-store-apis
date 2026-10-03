import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Env } from './config/env.js';
import { logger } from './logger.js';
import { errorHandler, notFound } from './http/middleware/error.js';
import { clientIpMiddleware } from './http/middleware/clientIp.js';
import { sessionMiddleware } from './http/middleware/session.js';
import { accountRouter } from './routes/account.routes.js';
import { adminRouter } from './routes/admin.routes.js';
import { authRouter } from './routes/auth.routes.js';
import { cartRouter } from './routes/cart.routes.js';
import { catalogRouter } from './routes/catalog.routes.js';
import { healthRouter } from './routes/health.routes.js';
import { ordersRouter } from './routes/orders.routes.js';

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
        const id = (req.headers['x-request-id'] as string | undefined)?.slice(0, 64) ?? randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/health' },
    }),
  );
  app.use(helmet());
  // Exact-origin CORS with credentials (JWT cookie). No wildcards.
  app.use(cors({ origin: env.WEB_ORIGIN, credentials: true, exposedHeaders: ['x-request-id'] }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(clientIpMiddleware);
  app.use(sessionMiddleware);

  app.use('/health', healthRouter);

  const v1 = express.Router();
  v1.use('/health', healthRouter);
  v1.use('/auth', authRouter);
  v1.use('/cart', cartRouter);
  v1.use('/orders', ordersRouter);
  v1.use('/account', accountRouter);
  v1.use('/admin', adminRouter);
  v1.use('/', catalogRouter);
  app.use('/api/v1', v1);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

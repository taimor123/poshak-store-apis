import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { logger } from './logger.js';

const env = loadEnv();
const server = createApp(env).listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'poshak-store-apis listening');
});

// Graceful shutdown so in-flight requests (and, later, transactions) finish.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}

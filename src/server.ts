import { createApp } from './app.js';
import { env } from './config/env.js';
import { disconnect } from './db.js';
import { startScheduler } from './jobs/scheduler.js';
import { logger } from './logger.js';

const config = env();
const server = createApp(config).listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'poshak-store-apis listening');
});
const scheduler = config.DISABLE_CRON ? null : startScheduler();

// Graceful shutdown so in-flight requests and transactions finish.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down');
    void scheduler?.stop();
    server.close(() => void disconnect().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}

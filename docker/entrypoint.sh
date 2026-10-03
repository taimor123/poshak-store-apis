#!/bin/sh
set -e
if [ "$RUN_MIGRATIONS" = "true" ]; then
  echo "Applying database migrations…"
  npx prisma migrate deploy
fi
if [ "$SEED_ON_START" = "true" ]; then
  echo "Seeding (idempotent)…"
  npx tsx prisma/seed.ts
fi
exec node dist/server.js

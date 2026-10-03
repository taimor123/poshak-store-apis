# poshak-store-apis

The Poshak backend: **Node 20 · Express 5 · TypeScript strict**, REST under `/api/v1`. It owns all domain logic, the database (Prisma + PostgreSQL), auth (a JWT in an httpOnly cookie) and scheduled jobs. The storefront ([`poshak-store-app`](https://github.com/taimor123/poshak-store-app)) is a pure client of this API.

The spec lives in the docs repo [`poshak-store`](https://github.com/taimor123/poshak-store), mainly `docs/BACKEND/`. Its `API_ENDPOINTS.md` is the contract registry.

## Run it

```bash
cp .env.example .env
npm install
npm run dev        # http://localhost:4000/api/v1/health
npm test
npm run build && npm start
```

## Status: foundation only

This repo was reset to a clean start. It currently has:

- App factory (`src/app.ts`): helmet, CORS that allows only `WEB_ORIGIN` with credentials, JSON body limit, request IDs, pino logging
- Env validation at boot (`src/config/env.ts`, zod)
- The response envelope `{ ok:true, data } | { ok:false, error:{ code, message, fieldErrors? } }` and the error-code registry (`src/http/errors.ts`)
- Error middleware: `DomainError` maps to its status, `ZodError` to `VALIDATION`, anything else to a generic `INTERNAL` (internals are logged, never returned)
- `GET /api/v1/health`, with tests

Next, per `docs/PROJECT_MANAGEMENT/IMPLEMENTATION_PLAN.md`: Prisma schema and seed, then catalog (read), cart, orders/COD checkout, auth, admin.

## Layout

```
src/
├── app.ts              createApp(env): middleware + routers (no listen; tests use it directly)
├── server.ts           boot: load env, listen, graceful shutdown
├── config/env.ts       validated environment
├── logger.ts           pino
├── http/
│   ├── errors.ts       error codes, envelope, DomainError
│   └── middleware/     error handler, (auth, rate limit…)
├── routes/             one router per resource; controllers stay thin
└── services/           (next) ALL domain logic; the only layer that touches Prisma
test/                   vitest + supertest
```

## Invariants this service will enforce

- Stock decrements use a conditional `UPDATE … WHERE stock >= qty` inside the order transaction. Never read-then-write.
- Order status changes only through `order.service.transition()`. Stock changes only through `inventory.service.adjust()`, which always writes the ledger.
- Money is integer paisa. Orders snapshot prices, names and images when they're placed.
- Every controller re-checks auth and ownership. The frontend's gates are UX only.

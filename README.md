# poshak-store-apis

The Poshak backend: **Node 20+ · Express 5 · TypeScript strict · Prisma 7 · PostgreSQL** (Docker locally, Neon in production). REST under `/api/v1`. It owns all domain logic, the database, auth (JWT in an httpOnly cookie) and scheduled jobs. The storefront ([`poshak-store-app`](https://github.com/taimor123/poshak-store-app)) is a pure client.

The spec is the docs repo [`poshak-store`](https://github.com/taimor123/poshak-store), mainly `docs/BACKEND/`, `docs/DATABASE/` and `docs/ECOMMERCE_CORE/`. `API_ENDPOINTS.md` there is the contract.

## Run it locally (Docker Postgres)

```bash
cp .env.example .env
npm install            # also generates the Prisma client
npm run db:up          # postgres:16 on localhost:5433 (+ a poshak_test database)
npm run db:migrate     # apply migrations
npm run db:seed        # taxonomy, size charts, zones, config, admin user, 16 demo products
npm run dev            # http://localhost:4000/health
```

Seeded admin: `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` from `.env`. Change the password after first login.

### Everything in Docker

```bash
docker compose up -d --build   # db + api on :4000; migrates and seeds on start
```

## Tests

```bash
npm test               # unit tests (pure domain logic)
npm run test:int       # integration tests against the poshak_test database (Docker must be up)
npm run test:all
```

The integration suite drives the real HTTP API against Postgres. It includes the release-gating **concurrency tests**: 8 shoppers racing for 3 units sell exactly 3, and one `Idempotency-Key` submitted 5 times at once creates exactly one order.

## Switching to Neon

1. Create a Neon project and copy the **pooled** connection string. It looks like `postgresql://USER:PASSWORD@ep-…-pooler.REGION.aws.neon.tech/neondb?sslmode=require`.
2. Set it as `DATABASE_URL` (in `.env` locally, or in Railway's variables).
3. Run `npm run db:migrate`, then `npm run db:seed` (the seed is idempotent).

No code changes are needed: the Prisma `pg` adapter works with Neon as-is.

## API surface

| Area | Endpoints |
|---|---|
| Health | `GET /health` (DB ping) |
| Auth | `POST /auth/register` · `/login` · `/logout` · `/logout-all` · `/change-password` · `/forgot-password` · `/reset-password` · `GET /auth/session` |
| Catalog | `GET /categories` · `/categories/{path}/products` · `/collections/{new\|sale\|all}` · `/products/:slug` · `/products?slugs=` · `/search?q=` · `/shipping-zones` · `/shipping-quote` · `/config/public` |
| Cart | `GET /cart` · `POST /cart/lines` · `PATCH/DELETE /cart/lines/:id` (guest anon cookie or signed-in user) |
| Orders | `POST /orders` (+ `Idempotency-Key`) · `POST /orders/track` (order number + mobile) · `GET /orders` · `GET /orders/:orderNo[?t=]` · `POST /orders/:orderNo/cancel` · `/return` |
| Account | `GET/PATCH /account/profile` · `/account/addresses` CRUD + default |
| Admin | dashboard · products (CRUD, variants, size overrides, images, duplicate, archive) · inventory (+ ledger, adjust) · orders (list, transition, refund) · returns (decide, receive) · categories · size charts · attribute sets · collections · config · shipping zones · upload signing |

Listing filters: `?fabric=Lawn,Silk&price=u5|5-10|10-20|o20&size=S,M&sale=1&inStock=1&sort=new|price_asc|price_desc&cursor=&limit=`.

## How the invariants are enforced

| Invariant | Where |
|---|---|
| Never oversell | `inventory.service.adjust()`: `UPDATE … SET stock = stock + Δ WHERE stock + Δ >= 0`, plus a DB `CHECK (stock >= 0)` |
| Every stock change is ledgered | `adjust()` is the only stock writer; the nightly job checks `stock == Σ ledger` |
| Status changes only via the table | `order.service.transition()` with an optimistic `AND status = from` guard + an `OrderEvent` in the same transaction |
| No double orders | `Idempotency-Key` stored as a unique column; concurrent duplicates replay the winner |
| Gap-free order numbers | `OrderSequence` row per month (Pakistan time), `PSK-YYYYMM-NNNN` |
| Server-side money | Totals computed in the transaction; the client total must match (`PRICE_MISMATCH`) |
| API is the security boundary | `requireUser` / `requireAdmin` in every controller + an admin router guard; JWT re-checked against the DB (`role`, `sessionVersion`) on every request |
| Guest order access | HMAC token per order; wrong or missing token → 404 (no existence oracle) |

## Layout

```
src/
├── app.ts / server.ts    express app factory · boot + cron + graceful shutdown
├── config/env.ts         zod-validated environment
├── db.ts                 Prisma client (pg adapter)
├── auth/                 session cookies (JWT), argon2id, guest tokens, require* authz
├── http/                 error codes + envelope, middleware (session, rate limit, errors)
├── routes/               thin controllers: parse → require* → service
├── services/             ALL domain logic (catalog, sizing, cart, order, inventory, shipping,
│   └── admin/            returns, auth, account, notification, config) + admin services
├── validation/           primitives (zPakPhone, zPaisa…) + request schemas
├── jobs/scheduler.ts     daily 02:00 PKT: complete orders, ledger audit, low-stock count
└── generated/prisma/     generated client (git-ignored)
prisma/                   schema, migrations (incl. hand-written CHECKs, search trigger), seed
test/unit · test/integration
```

## Deferred (agreed with the owner)

- **Email OTP verification and Google sign-in.** Email + password works today; OTP is added at the testing stage.
- **Online payments** (card / bank transfer). The schema (`Reservation`, `Payment`) and the transition table already support them.
- **Rate limiting** is in memory, which is fine for one instance. Switch to Upstash Redis before running several instances.
- **Email** is logged instead of sent until `RESEND_API_KEY` is set.
- **Image upload signing** needs the `CLOUDINARY_*` variables.

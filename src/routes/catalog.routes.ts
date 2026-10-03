import { Router } from 'express';
import { z } from 'zod';
import { NotFoundError, success } from '../http/errors.js';
import * as catalog from '../services/catalog.service.js';
import { publicConfig } from '../services/config.service.js';
import { listZones, quote } from '../services/shipping.service.js';
import { parse } from '../validation/parse.js';
import { zPaisa } from '../validation/primitives.js';
import { listingQuery } from '../validation/schemas.js';

// Public catalogue reads. Every handler here is `// public:`.

export const catalogRouter = Router();

const cache = (seconds: number) => `public, max-age=${seconds}, stale-while-revalidate=${seconds * 5}`;

// public: category tree
catalogRouter.get('/categories', async (_req, res) => {
  res.set('Cache-Control', cache(60)).json(success(await catalog.categoryTree()));
});

// public: category page — /categories/ready-to-wear/rtw-kurtis/products
catalogRouter.get('/categories/*path', async (req, res) => {
  const segments = (req.params as { path: string[] }).path;
  if (segments.at(-1) !== 'products' || segments.length < 2) throw new NotFoundError();
  const q = listingQuery.parse(req.query);
  res.json(success(await catalog.categoryListing(segments.slice(0, -1).join('/'), q)));
});

// public: auto collections (new, sale, all) and manual ones
catalogRouter.get('/collections/:slug', async (req, res) => {
  res.json(success(await catalog.collectionListing(req.params.slug, listingQuery.parse(req.query))));
});

// public: product detail page
catalogRouter.get('/products/:slug', async (req, res) => {
  res.json(success(await catalog.productDetail(req.params.slug)));
});

// public: cards for slugs held on the device (recently viewed, wishlist)
catalogRouter.get('/products', async (req, res) => {
  const slugs = z
    .string()
    .max(2000)
    .transform((s) => s.split(',').filter((x) => /^[a-z0-9-]{1,80}$/.test(x)).slice(0, 50))
    .catch([])
    .parse(req.query.slugs);
  res.json(success(await catalog.productsBySlugs(slugs)));
});

// public: search
catalogRouter.get('/search', async (req, res) => {
  const q = z.string().max(100).catch('').parse(req.query.q ?? '');
  res.json(success(await catalog.search(q, listingQuery.parse(req.query))));
});

// public: shipping cities + quote
catalogRouter.get('/shipping-zones', async (_req, res) => {
  res.set('Cache-Control', cache(300)).json(success((await listZones()).map(({ city, feePaisa, estimateText, expressAvailable }) => ({ city, feePaisa, estimateText, expressAvailable }))));
});

catalogRouter.get('/shipping-quote', async (req, res) => {
  const q = parse(
    z.object({ city: z.string().min(1).max(60), subtotalPaisa: z.coerce.number().pipe(zPaisa).default(0), method: z.enum(['STANDARD', 'EXPRESS']).default('STANDARD') }),
    req.query,
  );
  res.json(success(await quote(q.city, q.subtotalPaisa, q.method)));
});

// public: display config (free-shipping threshold etc.)
catalogRouter.get('/config/public', async (_req, res) => {
  res.set('Cache-Control', cache(60)).json(success(await publicConfig()));
});

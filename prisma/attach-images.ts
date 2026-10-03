/**
 * Attaches demo images to the seeded DEMO products.
 *
 *   npm run db:attach-images -- ../poshak-store-app/public/products
 *
 * Scans the folder for `{slug}-{n}.{jpg|png|webp}` and replaces each matching
 * DEMO product's images with `/products/{file}` (served by poshak-store-app's
 * public folder), `-1` as the cover. Real products never go through this —
 * their photos are uploaded via the admin to Cloudinary.
 */
import { readdirSync } from 'node:fs';
import { createPrisma } from '../src/db.js';

try {
  process.loadEnvFile();
} catch {
  /* env from the environment */
}

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: npm run db:attach-images -- <folder with {slug}-{n}.jpg files>');
  process.exit(1);
}

const files = readdirSync(dir)
  .map((f) => /^([a-z0-9-]+?)-(\d+)\.(jpe?g|png|webp)$/i.exec(f))
  .filter((m): m is RegExpExecArray => !!m)
  .map((m) => ({ file: m[0], slug: m[1]!, n: Number(m[2]) }));

const db = createPrisma(process.env.DATABASE_URL!);
try {
  const slugs = Array.from(new Set(files.map((f) => f.slug)));
  const products = await db.product.findMany({ where: { slug: { in: slugs }, code: { startsWith: 'DEMO-' } }, select: { id: true, slug: true, name: true } });
  for (const p of products) {
    const mine = files.filter((f) => f.slug === p.slug).sort((a, b) => a.n - b.n);
    await db.$transaction([
      db.productImage.deleteMany({ where: { productId: p.id } }),
      db.productImage.createMany({
        data: mine.map((f, i) => ({ productId: p.id, url: `/products/${f.file}`, altText: `${p.name} — view ${i + 1}`, sortOrder: i, isCover: i === 0 })),
      }),
    ]);
    console.log(`${p.slug}: ${mine.length} image(s)`);
  }
  const skipped = slugs.filter((s) => !products.some((p) => p.slug === s));
  if (skipped.length) console.log(`ignored (not a DEMO product): ${skipped.join(', ')}`);
  if (!files.length) console.log('No {slug}-{n}.jpg files found.');
} finally {
  await db.$disconnect();
}

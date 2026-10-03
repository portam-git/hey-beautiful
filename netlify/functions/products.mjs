// Live prices and stock for the shop page, read from the Square catalog.
// Response: { products: { [sku]: { price: cents, stock: number | null } } }
// stock is null for pieces that aren't tracked (made to order).
import { configured, loadCatalog } from "../lib/square.mjs";

export default async () => {
  if (!configured()) return Response.json({ error: "Not configured" }, { status: 503 });
  try {
    const catalog = await loadCatalog();
    const products = {};
    for (const [sku, p] of catalog) products[sku] = { price: p.price, stock: p.stock };
    return Response.json({ products }, {
      headers: {
        "Cache-Control": "public, max-age=0, must-revalidate",
        "Netlify-CDN-Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    });
  } catch (e) {
    console.error(e.message);
    return Response.json({ error: "Couldn't load products" }, { status: 502 });
  }
};

export const config = { path: "/api/products" };

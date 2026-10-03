// One-time setup: loads the products from index.html into the Square SANDBOX catalog,
// with each colour as a variation whose SKU is the site's product id (nb1, pp2, …).
// Leather pieces are tracked and get a starting stock count; jewelry is left untracked (made to order).
//
// Usage (PowerShell):
//   $env:SQUARE_ACCESS_TOKEN = "<sandbox access token>"
//   $env:SQUARE_LOCATION_ID  = "<sandbox location id>"
//   node scripts/seed-square-catalog.mjs            # add --dry-run to only print the plan
//
// Optional: $env:SEED_STOCK = "10"  (starting count for each tracked piece, default 10)
// SKUs that already exist in the catalog are skipped, so it is safe to run again.
import fs from "node:fs";
import { square } from "../netlify/lib/square.mjs";

const dryRun = process.argv.includes("--dry-run");
if (process.env.SQUARE_ENVIRONMENT === "production") {
  console.error("This script only seeds the sandbox. In production, add SKUs to your existing Square items instead (see README).");
  process.exit(1);
}
if (!dryRun && !(process.env.SQUARE_ACCESS_TOKEN && process.env.SQUARE_LOCATION_ID)) {
  console.error("Set SQUARE_ACCESS_TOKEN and SQUARE_LOCATION_ID (sandbox values) first.");
  process.exit(1);
}
const stock = String(Number.parseInt(process.env.SEED_STOCK ?? "10", 10) || 10);

// Read the product list and colour names out of index.html.
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const colours = Object.fromEntries([...html.matchAll(/(\w+):\{b:"#\w+",e:"#\w+",n:"([^"]+)"\}/g)].map((m) => [m[1], m[2]]));
const products = [...html.matchAll(/\{id:"(\w+)",s:"(\w+)",c:"(\w+)",n:"((?:[^"\\]|\\.)*)",l:"(\w+)",p:(\d+),m:"((?:[^"\\]|\\.)*)"/g)]
  .map((m) => ({ id: m[1], shape: m[2], cat: m[3], name: m[4].replace(/\\(.)/g, "$1"), colour: m[5], price: Number(m[6]), desc: m[7].replace(/\\(.)/g, "$1") }));
if (products.length === 0) throw new Error("Couldn't find the product list in index.html");

// Jewelry shares one "colour", so name its variations by metal instead.
const variationName = (p) => ({ jp1: "14k gold filled", jp2: "Sterling silver" })[p.id] ?? colours[p.colour] ?? p.colour;

// Group colours of the same piece into one Square item.
const groups = new Map();
for (const p of products) {
  const key = `${p.shape}|${p.name}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(p);
}

// Skip SKUs already in the catalog.
const existing = new Set();
if (!dryRun) {
  let cursor;
  do {
    const page = await square(`catalog/list?types=ITEM_VARIATION${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    for (const v of page.objects ?? []) if (v.item_variation_data?.sku) existing.add(v.item_variation_data.sku);
    cursor = page.cursor;
  } while (cursor);
}

const objects = [];
const tracked = [];
for (const list of groups.values()) {
  const fresh = list.filter((p) => !existing.has(p.id));
  if (fresh.length === 0) continue;
  if (fresh.length !== list.length) {
    console.warn(`Skipping ${list[0].name}: some of its SKUs already exist (${list.filter((p) => existing.has(p.id)).map((p) => p.id).join(", ")}). Add the rest in Square Dashboard.`);
    continue;
  }
  const itemId = `#item-${list[0].id}`;
  const descs = new Set(list.map((p) => p.desc));
  objects.push({
    type: "ITEM",
    id: itemId,
    item_data: {
      name: list[0].name,
      ...(descs.size === 1 ? { description: list[0].desc } : {}),
      variations: list.map((p) => {
        const track = p.cat !== "jewelry";
        if (track) tracked.push(p.id);
        return {
          type: "ITEM_VARIATION",
          id: `#${p.id}`,
          item_variation_data: {
            item_id: itemId,
            name: variationName(p),
            sku: p.id,
            pricing_type: "FIXED_PRICING",
            price_money: { amount: p.price * 100, currency: "USD" },
            track_inventory: track,
          },
        };
      }),
    },
  });
}

for (const o of objects) {
  console.log(`${o.item_data.name}: ${o.item_data.variations.map((v) => `${v.item_variation_data.name} [${v.item_variation_data.sku}] $${v.item_variation_data.price_money.amount / 100}${v.item_variation_data.track_inventory ? ` × ${stock}` : " (made to order)"}`).join(", ")}`);
}
console.log(`\n${objects.length} items, ${objects.reduce((n, o) => n + o.item_data.variations.length, 0)} variations, ${tracked.length} tracked.`);
if (dryRun || objects.length === 0) process.exit(0);

const res = await square("catalog/batch-upsert", { idempotency_key: crypto.randomUUID(), batches: [{ objects }] });
const ids = Object.fromEntries((res.id_mappings ?? []).map((m) => [m.client_object_id, m.object_id]));
console.log(`Created ${objects.length} items in the sandbox catalog.`);

const now = new Date().toISOString();
const changes = tracked.map((sku) => ({
  type: "PHYSICAL_COUNT",
  physical_count: { catalog_object_id: ids[`#${sku}`], state: "IN_STOCK", location_id: process.env.SQUARE_LOCATION_ID, quantity: stock, occurred_at: now },
}));
for (let i = 0; i < changes.length; i += 100) {
  await square("inventory/changes/batch-create", { idempotency_key: crypto.randomUUID(), changes: changes.slice(i, i + 100) });
}
console.log(`Set stock to ${stock} for ${changes.length} tracked variations.`);

// Sets up the Square SANDBOX catalog from the products in index.html, and brings it back in line
// when run again:
//  - each piece is an item in its category (also set as its reporting category), with each colour
//    as a variation whose SKU is the site's product id (nb1, pp2, …);
//  - every variation is tracked. Tracking is the default even for made-to-order pieces (count the
//    blanks or capacity you have), so the site can never oversell.
// Items that already exist keep their names, prices and stock; the script only fills in a missing
// category and turns tracking on, giving newly tracked variations the starting count.
//
// Usage: node scripts/seed-square-catalog.mjs [--dry-run] [--yes]
// It asks for the sandbox access token (hidden) and location id unless SQUARE_ACCESS_TOKEN and
// SQUARE_LOCATION_ID are set, prints the planned changes, and asks before applying them
// (--dry-run only prints; --yes applies without asking).
//
// Optional: $env:SEED_STOCK = "10"  (starting count for new or newly tracked pieces, default 10)
import fs from "node:fs";
import readline from "node:readline";
import { square } from "../netlify/lib/square.mjs";

const dryRun = process.argv.includes("--dry-run");
if (process.env.SQUARE_ENVIRONMENT === "production") {
  console.error("This script only seeds the sandbox. In production, add SKUs to your existing Square items instead (see README).");
  process.exit(1);
}

// Prompts on the terminal; with hidden: true nothing typed or pasted is echoed.
function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.startsWith(question)) rl.output.write(s); };
    rl.question(question, (answer) => {
      // Drop bracketed-paste markers and any other non-printable characters a terminal paste can add.
      const clean = answer.replace(/\x1b\[20[01]~/g, "").replace(/[^\x21-\x7e]/g, "");
      if (hidden) rl.output.write(clean ? `(received ${clean.length} characters)\n` : "\n");
      rl.close(); resolve(clean);
    });
  });
}
if (!process.env.SQUARE_ACCESS_TOKEN) process.env.SQUARE_ACCESS_TOKEN = await ask("Sandbox access token (hidden): ", { hidden: true });
if (!process.env.SQUARE_LOCATION_ID) process.env.SQUARE_LOCATION_ID = await ask("Sandbox location id: ");
if (!(process.env.SQUARE_ACCESS_TOKEN && process.env.SQUARE_LOCATION_ID)) {
  console.error("A sandbox access token and location id are both needed.");
  process.exit(1);
}
const stock = String(Number.parseInt(process.env.SEED_STOCK ?? "10", 10) || 10);
const loc = process.env.SQUARE_LOCATION_ID;

// The site's categories (the c field in index.html) and their names in Square.
const CATEGORIES = {
  stationery: "Notebooks & stationery", travel: "Travel accessories", wallets: "Wallets & card holders",
  bags: "Bags & pouches", keyrings: "Keyrings & charms", jewelry: "Jewelry",
};

// Read the product list and colour names out of index.html.
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const colours = Object.fromEntries([...html.matchAll(/(\w+):\{b:"#\w+",e:"#\w+",n:"([^"]+)"\}/g)].map((m) => [m[1], m[2]]));
const products = [...html.matchAll(/\{id:"(\w+)",s:"(\w+)",c:"(\w+)",n:"((?:[^"\\]|\\.)*)",l:"(\w+)",p:(\d+),m:"((?:[^"\\]|\\.)*)"/g)]
  .map((m) => ({ id: m[1], shape: m[2], cat: m[3], name: m[4].replace(/\\(.)/g, "$1"), colour: m[5], price: Number(m[6]), desc: m[7].replace(/\\(.)/g, "$1") }));
if (products.length === 0) throw new Error("Couldn't find the product list in index.html");
for (const p of products) if (!CATEGORIES[p.cat]) throw new Error(`No Square category for "${p.cat}" (${p.id})`);

// Jewelry shares one "colour", so name its variations by metal instead.
const variationName = (p) => ({ jp1: "14k gold filled", jp2: "Sterling silver" })[p.id] ?? colours[p.colour] ?? p.colour;

// Group colours of the same piece into one Square item.
const groups = new Map();
for (const p of products) {
  const key = `${p.shape}|${p.name}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(p);
}

async function listAll(type) {
  const out = [];
  let cursor;
  do {
    const page = await square(`catalog/list?types=${type}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    out.push(...(page.objects ?? []));
    cursor = page.cursor;
  } while (cursor);
  return out;
}

// Categories: reuse ones that already exist (matched by name), create the rest.
const catId = {};
const objects = [];
// Check the token and location before doing anything else.
try {
  const { location } = await square(`locations/${encodeURIComponent(loc)}`);
  console.log(`Connected to sandbox location "${location.name}".\n`);
} catch (e) {
  console.error(e.status === 401 ? "Square rejected the access token. Use the Sandbox access token (Developer Console → your app → Credentials, Sandbox selected), not the production token or the application secret."
    : e.status === 404 ? `Square doesn't recognise location "${loc}" for this token. Use the location id from the same sandbox account.`
    : e.message);
  process.exit(1);
}
const existingCats = new Map((await listAll("CATEGORY")).filter((c) => !c.is_deleted).map((c) => [c.category_data?.name, c.id]));
for (const [key, name] of Object.entries(CATEGORIES)) {
  catId[key] = existingCats.get(name) ?? `#cat-${key}`;
  if (!existingCats.has(name)) {
    objects.push({ type: "CATEGORY", id: catId[key], category_data: { name } });
    console.log(`+ category ${name}`);
  }
}
const withCategory = (data, key) => ({ ...data, categories: [{ id: catId[key] }], reporting_category: { id: catId[key] } });

// Existing items, indexed by their variations' SKUs.
const itemBySku = new Map();
for (const item of await listAll("ITEM")) {
  if (item.is_deleted) continue;
  for (const v of item.item_data?.variations ?? []) if (v.item_variation_data?.sku) itemBySku.set(v.item_variation_data.sku, item);
}

const startCounts = []; // SKUs (new) or variation ids (existing) that need a starting count
for (const list of groups.values()) {
  const cat = list[0].cat;
  const found = list.filter((p) => itemBySku.has(p.id));

  if (found.length === 0) {
    const itemId = `#item-${list[0].id}`;
    const descs = new Set(list.map((p) => p.desc));
    objects.push({
      type: "ITEM",
      id: itemId,
      item_data: withCategory({
        name: list[0].name,
        ...(descs.size === 1 ? { description: list[0].desc } : {}),
        variations: list.map((p) => {
          startCounts.push({ ref: `#${p.id}`, label: p.id });
          return {
            type: "ITEM_VARIATION",
            id: `#${p.id}`,
            item_variation_data: {
              item_id: itemId, name: variationName(p), sku: p.id, pricing_type: "FIXED_PRICING",
              price_money: { amount: p.price * 100, currency: "USD" }, track_inventory: true,
            },
          };
        }),
      }, cat),
    });
    console.log(`+ item ${list[0].name} in ${CATEGORIES[cat]}: ${list.map((p) => `${variationName(p)} [${p.id}]`).join(", ")}`);
    continue;
  }

  const items = new Set(found.map((p) => itemBySku.get(p.id)));
  if (found.length !== list.length || items.size !== 1) {
    console.warn(`! skipping ${list[0].name}: its SKUs are missing or split across items (${list.map((p) => `${p.id}${itemBySku.has(p.id) ? "" : " missing"}`).join(", ")}). Fix it in Square Dashboard.`);
    continue;
  }

  // Existing item: fill in a missing category and turn tracking on, leaving everything else as it is.
  const item = structuredClone([...items][0]);
  const changes = [];
  const d = item.item_data;
  if (!d.categories?.length || !d.reporting_category) {
    Object.assign(d, withCategory(d, cat));
    changes.push(`category ${CATEGORIES[cat]}`);
  }
  for (const v of d.variations) {
    const vd = v.item_variation_data;
    const ov = (vd.location_overrides ?? []).find((o) => o.location_id === loc);
    if (vd.track_inventory !== true || ov?.track_inventory === false) {
      vd.track_inventory = true;
      if (ov) ov.track_inventory = true;
      startCounts.push({ ref: v.id, label: vd.sku ?? vd.name });
      changes.push(`track ${vd.name}${vd.sku ? ` [${vd.sku}]` : ""}`);
    }
  }
  if (changes.length) {
    objects.push(item);
    console.log(`~ ${d.name}: ${changes.join(", ")}`);
  }
}

console.log(`\n${objects.length} catalog changes; ${startCounts.length} variations will get a starting count of ${stock}.`);
if (dryRun || objects.length === 0) process.exit(0);
if (!process.argv.includes("--yes") && !/^y(es)?$/i.test(await ask("Apply these changes to the sandbox catalog? (y/N) "))) {
  console.log("Nothing changed.");
  process.exit(0);
}

const res = await square("catalog/batch-upsert", { idempotency_key: crypto.randomUUID(), batches: [{ objects }] });
const ids = Object.fromEntries((res.id_mappings ?? []).map((m) => [m.client_object_id, m.object_id]));
console.log("Catalog updated.");

const now = new Date().toISOString();
const counts = startCounts.map((c) => ({
  type: "PHYSICAL_COUNT",
  physical_count: { catalog_object_id: ids[c.ref] ?? c.ref, state: "IN_STOCK", location_id: loc, quantity: stock, occurred_at: now },
}));
for (let i = 0; i < counts.length; i += 100) {
  await square("inventory/changes/batch-create", { idempotency_key: crypto.randomUUID(), changes: counts.slice(i, i + 100) });
}
if (counts.length) console.log(`Set stock to ${stock} for ${startCounts.map((c) => c.label).join(", ")}.`);

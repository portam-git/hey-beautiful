// Shared Square helpers for the Netlify Functions.
//
// Env vars (set in Netlify → Project configuration → Environment variables):
//   SQUARE_ACCESS_TOKEN   required, secret
//   SQUARE_LOCATION_ID    required
//   SQUARE_ENVIRONMENT    "sandbox" (default) or "production"
//   SQUARE_VERSION        optional API version override

export const configured = () => Boolean(process.env.SQUARE_ACCESS_TOKEN && process.env.SQUARE_LOCATION_ID);
export const locationId = () => process.env.SQUARE_LOCATION_ID;

export async function square(path, body) {
  const host = process.env.SQUARE_ENVIRONMENT === "production" ? "connect.squareup.com" : "connect.squareupsandbox.com";
  const res = await fetch(`https://${host}/v2/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "Square-Version": process.env.SQUARE_VERSION || "2025-01-23",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Square ${path} failed: ${res.status} ${JSON.stringify(data.errors ?? data)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Whether a catalog object is sold at the given location.
function presentAt(obj, loc) {
  if (obj.present_at_all_locations === false) return (obj.present_at_location_ids ?? []).includes(loc);
  return !(obj.absent_at_location_ids ?? []).includes(loc);
}

// Loads every fixed-price variation with a SKU at our location.
// Returns Map sku → { variationId, name, price (cents), stock (number, or null when not tracked) }.
export async function loadCatalog() {
  const loc = locationId();
  const bySku = new Map();
  let cursor;
  do {
    const page = await square(`catalog/list?types=ITEM${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    for (const item of page.objects ?? []) {
      const d = item.item_data;
      if (!d || item.is_deleted || d.is_archived || !presentAt(item, loc)) continue;
      for (const v of d.variations ?? []) {
        const vd = v.item_variation_data;
        if (!vd?.sku || v.is_deleted || vd.pricing_type !== "FIXED_PRICING" || !vd.price_money || !presentAt(v, loc)) continue;
        const ov = (vd.location_overrides ?? []).find((o) => o.location_id === loc) ?? {};
        const tracked = ov.track_inventory ?? vd.track_inventory ?? false;
        bySku.set(vd.sku, {
          variationId: v.id,
          name: d.variations.length > 1 && vd.name ? `${d.name} — ${vd.name}` : d.name,
          price: Number(vd.price_money.amount),
          // Tracked counts are filled in below (no count means none in stock).
          // Untracked pieces are made to order, unless marked sold out in Square.
          stock: tracked || ov.sold_out ? 0 : null,
          tracked,
          soldOut: ov.sold_out === true,
        });
      }
    }
    cursor = page.cursor;
  } while (cursor);

  const tracked = [...bySku.values()].filter((p) => p.tracked);
  const byId = new Map(tracked.map((p) => [p.variationId, p]));
  for (let i = 0; i < tracked.length; i += 500) {
    let c;
    do {
      const page = await square("inventory/counts/batch-retrieve", {
        catalog_object_ids: tracked.slice(i, i + 500).map((p) => p.variationId),
        location_ids: [loc],
        states: ["IN_STOCK"],
        cursor: c,
      });
      for (const count of page.counts ?? []) {
        const p = byId.get(count.catalog_object_id);
        if (p && !p.soldOut) p.stock = Math.max(0, Math.floor(Number(count.quantity) || 0));
      }
      c = page.cursor;
    } while (c);
  }
  return bySku;
}

// Creates a Square-hosted checkout link for the bag and returns its URL.
// Prices come from the table below, never from the browser.
//
// Env vars (set in Netlify → Project configuration → Environment variables):
//   SQUARE_ACCESS_TOKEN   required, secret
//   SQUARE_LOCATION_ID    required
//   SQUARE_ENVIRONMENT    "sandbox" (default) or "production"
//   SHIPPING_FEE_CENTS    optional flat shipping fee, e.g. 800 for $8.00
//   SQUARE_VERSION        optional API version override

// Keep in sync with the P array in index.html: id → [name, colour, price in dollars]
const PRODUCTS = {
  nb1: ["A5 notebook", "Black", 49], nb2: ["A5 notebook", "Mocha", 49], nb3: ["A5 notebook", "Oat", 49],
  nb4: ["Weekly planner", "Sage", 49], bm1: ["Magnetic bookmark", "Rose", 19],
  pp1: ["Passport holder", "Black", 85], pp2: ["Passport holder", "Mocha", 85],
  lt1: ["Luggage tag", "Navy", 59], lt2: ["Luggage tag", "Oat", 59], lt3: ["Luggage tag", "Black", 59],
  cc1: ["Card holder", "Black", 65], cc2: ["Card holder", "Blush", 65],
  wl1: ["Bifold wallet", "Tan", 110], wl2: ["Bifold wallet", "Black", 110],
  po1: ["Clutch pouch", "Rose", 95], po2: ["Cosmetic bag", "Blush", 79], lc1: ["Laptop case 14\"", "Black", 159],
  kr1: ["Keyring", "Tan", 35], kr2: ["Keyring", "Black", 35],
  ch1: ["Heart bag charm", "Blush", 39], ch2: ["Heart bag charm", "Rose", 39],
  jp1: ["Initial pendant", "14k gold filled", 68], jp2: ["Initial pendant", "Sterling silver", 68],
  jb1: ["Engraved bar bracelet", "14k gold filled", 74], jb2: ["Charm bracelet base", "14k gold filled", 45],
  tr1: ["Trinket tray", "Sage", 55], gb1: ["Gift box & ribbon", "Oat", 12],
};
const FONTS = { arial: "Arial", helvetica: "Helvetica", times: "Times Roman", brush: "Brush Script" };
const SIZES = { sm: "6mm", md: "8mm", lg: "10mm" };
const FOILS = { gold: "Gold", silver: "Silver", white: "White", black: "Black", blind: "Blind press" };
const POSITIONS = { tl: "Top left", tc: "Top center", tr: "Top right", mc: "Middle", bl: "Bottom left", bc: "Bottom center", br: "Bottom right" };

const json = (body, status = 200) => Response.json(body, { status });

// Turns one bag line into a Square line item, or returns null if anything is off.
function lineItem(l) {
  if (!l || typeof l !== "object") return null;
  const p = Object.hasOwn(PRODUCTS, l.id) ? PRODUCTS[l.id] : null;
  const q = Number(l.q);
  if (!p || !Number.isInteger(q) || q < 1 || q > 99) return null;
  let note;
  if (l.blank === true) note = "No monogram";
  else {
    const ini = typeof l.i === "string" ? l.i.toUpperCase() : "";
    const pos = l.pos ?? "mc";
    if (!/^[A-Z]{1,3}$/.test(ini) || !Object.hasOwn(FONTS, l.font) || !Object.hasOwn(SIZES, l.size) ||
        !Object.hasOwn(FOILS, l.f) || !Object.hasOwn(POSITIONS, pos)) return null;
    note = `Monogram ${ini} · ${FONTS[l.font]} · ${SIZES[l.size]} · ${FOILS[l.f]} foil · ${POSITIONS[pos]}`;
  }
  return {
    name: `${p[0]} — ${p[1]}`,
    quantity: String(q),
    base_price_money: { amount: p[2] * 100, currency: "USD" },
    note,
  };
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const token = process.env.SQUARE_ACCESS_TOKEN;
  const locationId = process.env.SQUARE_LOCATION_ID;
  if (!token || !locationId) return json({ error: "Checkout isn't configured yet." }, 503);

  let bag;
  try { bag = (await req.json()).bag; } catch { return json({ error: "Invalid request." }, 400); }
  if (!Array.isArray(bag) || bag.length === 0 || bag.length > 50) return json({ error: "Your bag is empty." }, 400);

  const items = bag.map(lineItem);
  if (items.includes(null)) return json({ error: "Something in your bag is out of date. Please remove it and add it again." }, 400);

  const checkoutOptions = {
    redirect_url: `${new URL(req.url).origin}/?checkout=complete`,
    ask_for_shipping_address: true,
  };
  const shipping = Number(process.env.SHIPPING_FEE_CENTS);
  if (Number.isInteger(shipping) && shipping > 0) {
    checkoutOptions.shipping_fee = { name: "Shipping", charge: { amount: shipping, currency: "USD" } };
  }

  const host = process.env.SQUARE_ENVIRONMENT === "production" ? "connect.squareup.com" : "connect.squareupsandbox.com";
  const res = await fetch(`https://${host}/v2/online-checkout/payment-links`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Square-Version": process.env.SQUARE_VERSION || "2025-01-23",
    },
    body: JSON.stringify({
      idempotency_key: crypto.randomUUID(),
      order: { location_id: locationId, line_items: items },
      checkout_options: checkoutOptions,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.payment_link?.url) {
    console.error("Square payment link failed", res.status, JSON.stringify(data.errors ?? data));
    // TEMP: surface Square's error codes while setting up; remove once checkout works.
    const codes = (data.errors ?? []).map((e) => [e.code, e.field].filter(Boolean).join(" ")).join(", ");
    return json({ error: `We couldn't start checkout (Square ${res.status}${codes ? ": " + codes : ""}).` }, 502);
  }
  return json({ url: data.payment_link.url });
};

export const config = { path: "/api/checkout" };

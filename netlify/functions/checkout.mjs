// Creates a Square-hosted checkout link for the bag and returns its URL.
// Products, prices and stock come from the Square catalog (matched by SKU), never from the browser.
// Because line items reference catalog variations, Square deducts stock when the order is paid.
//
// Env vars: see ../lib/square.mjs, plus
//   SHIPPING_FEE_CENTS    optional flat shipping fee, e.g. 800 for $8.00
import { configured, locationId, loadCatalog, square } from "../lib/square.mjs";

const FONTS = { arial: "Arial", helvetica: "Helvetica", times: "Times Roman", brush: "Brush Script" };
const SIZES = { sm: "6mm", md: "8mm", lg: "10mm" };
const FOILS = { gold: "Gold", silver: "Silver", white: "White", black: "Black", blind: "Blind press" };
const POSITIONS = { tl: "Top left", tc: "Top center", tr: "Top right", mc: "Middle", bl: "Bottom left", bc: "Bottom center", br: "Bottom right" };

const json = (body, status = 200) => Response.json(body, { status });

// Validates one bag line and returns its monogram note, or null if anything is off.
function noteFor(l) {
  if (!l || typeof l !== "object" || typeof l.id !== "string") return null;
  const q = Number(l.q);
  if (!Number.isInteger(q) || q < 1 || q > 99) return null;
  if (l.blank === true) return "No monogram";
  const ini = typeof l.i === "string" ? l.i.toUpperCase() : "";
  const pos = l.pos ?? "mc";
  if (!/^[A-Z]{1,3}$/.test(ini) || !Object.hasOwn(FONTS, l.font) || !Object.hasOwn(SIZES, l.size) ||
      !Object.hasOwn(FOILS, l.f) || !Object.hasOwn(POSITIONS, pos)) return null;
  return `Monogram ${ini} · ${FONTS[l.font]} · ${SIZES[l.size]} · ${FOILS[l.f]} foil · ${POSITIONS[pos]}`;
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!configured()) return json({ error: "Checkout isn't configured yet." }, 503);

  let bag;
  try { bag = (await req.json()).bag; } catch { return json({ error: "Invalid request." }, 400); }
  if (!Array.isArray(bag) || bag.length === 0 || bag.length > 50) return json({ error: "Your bag is empty." }, 400);

  const notes = bag.map(noteFor);
  if (notes.includes(null)) return json({ error: "Something in your bag is out of date. Please remove it and add it again." }, 400);

  let catalog;
  try { catalog = await loadCatalog(); } catch (e) {
    console.error(e.message);
    return json({ error: "We couldn't start checkout. Please try again in a moment." }, 502);
  }

  // Check every piece still exists and that the bag doesn't ask for more than is in stock.
  const wanted = new Map();
  for (const l of bag) {
    const p = catalog.get(l.id);
    if (!p) return json({ error: "Something in your bag is no longer available. Please remove it to continue." }, 409);
    wanted.set(l.id, (wanted.get(l.id) ?? 0) + Number(l.q));
  }
  for (const [sku, q] of wanted) {
    const p = catalog.get(sku);
    if (p.stock !== null && q > p.stock) {
      return json({ error: p.stock === 0 ? `${p.name} has just sold out. Please remove it to continue.`
        : `Only ${p.stock} left of ${p.name}. Please lower the quantity to continue.` }, 409);
    }
  }

  const checkoutOptions = {
    redirect_url: `${new URL(req.url).origin}/?checkout=complete`,
    ask_for_shipping_address: true,
  };
  const shipping = Number(process.env.SHIPPING_FEE_CENTS);
  if (Number.isInteger(shipping) && shipping > 0) {
    checkoutOptions.shipping_fee = { name: "Shipping", charge: { amount: shipping, currency: "USD" } };
  }

  try {
    const data = await square("online-checkout/payment-links", {
      idempotency_key: crypto.randomUUID(),
      order: {
        location_id: locationId(),
        line_items: bag.map((l, i) => ({ catalog_object_id: catalog.get(l.id).variationId, quantity: String(Number(l.q)), note: notes[i] })),
      },
      checkout_options: checkoutOptions,
    });
    if (!data.payment_link?.url) throw new Error("Square returned no payment link");
    return json({ url: data.payment_link.url });
  } catch (e) {
    console.error(e.message);
    return json({ error: "We couldn't start checkout. Please try again in a moment." }, 502);
  }
};

export const config = { path: "/api/checkout" };

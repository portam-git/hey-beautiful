# Hey Beautiful

Shop site for Hey Beautiful, a Las Vegas studio making personalised leather goods and tarnish-free jewelry.

The whole site is a single static page, `index.html`. Its styles, scripts and product illustrations are all inline. There is no build step.

## Run locally

Open `index.html` in a browser, or serve the folder:

```bash
npx serve .
```

## Deploy

Hosted on Netlify at https://hey-beautiful-shop.netlify.app. `netlify.toml` publishes the repo root as-is.

## Checkout (Square)

The bag's Checkout button posts to `/api/checkout` ([netlify/functions/checkout.mjs](netlify/functions/checkout.mjs)). The function looks up each piece in the Square catalog, checks stock, creates a Square payment link, and redirects the shopper to Square's hosted payment page. Each line item's note carries the monogram details. Square collects the shipping address, then sends the shopper back to `/?checkout=complete`, which clears the bag.

Set these in Netlify → Project configuration → Environment variables:

| Variable | |
| --- | --- |
| `SQUARE_ACCESS_TOKEN` | Required. Mark it as secret. |
| `SQUARE_LOCATION_ID` | Required. |
| `SQUARE_ENVIRONMENT` | `sandbox` (default) or `production`. |
| `SHIPPING_FEE_CENTS` | Optional flat shipping fee, e.g. `800` for $8.00. |

## Inventory (Square catalog)

Square is the source of truth for prices and stock, shared with the studio's Point of Sale.

- Each product is a Square item, with its colours as variations. **Each variation's SKU must match the site's product id** in the `P` array in `index.html` (`nb1`, `pp2`, …). That's how the site knows which illustration and options to show.
- `/api/products` ([netlify/functions/products.mjs](netlify/functions/products.mjs)) returns live prices and stock, cached for 60 seconds. The page applies them on load: low stock shows "Only N left", zero shows "Sold out", and pieces whose SKU isn't in the catalog are hidden. If the feed fails, the page falls back to its built-in prices.
- **Track inventory should be on for every variation**, including made-to-order pieces: count whatever limits you (blanks, chain, weekly capacity). A variation with tracking off can never sell out on the site, so it can be oversold; only mark it sold out in Square to stop sales.
- Checkout line items reference the catalog variations, so Square deducts stock when an order is paid, the same as an in-store sale.

Day to day, change prices and stock in Square Dashboard or the POS app; the site follows within a minute. A brand-new kind of product needs a matching entry in `index.html` (it needs an illustration), with the same SKU in Square.

**Sandbox setup:** [scripts/seed-square-catalog.mjs](scripts/seed-square-catalog.mjs) loads the site's products into the sandbox catalog: each item in its category (also its reporting category), every piece tracked, 10 each. Run it again at any time to fill in missing categories and turn tracking back on; it leaves existing names, prices and stock alone. Set the sandbox `SQUARE_ACCESS_TOKEN` and `SQUARE_LOCATION_ID` in your shell, then run `node scripts/seed-square-catalog.mjs --dry-run` to see the changes and run it without `--dry-run` to apply them.

**Categories in Square** match the site's groups: Notebooks & stationery, Travel accessories, Wallets & card holders, Bags & pouches, Keyrings & charms, Jewelry. The site's tabs still come from `index.html`, so a piece moved to another category in Square stays in its original tab on the site.

**Production setup:** don't run the script. Add the SKUs to your existing Square items instead, and create any that are missing in Square Dashboard.

## Status

Prices, policies and reviews are placeholders. The event inquiry form and the newsletter sign-up are not connected to a backend yet. The bag is saved in the browser's `localStorage`.

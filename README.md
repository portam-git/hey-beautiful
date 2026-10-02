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

The bag's Checkout button posts to `/api/checkout` ([netlify/functions/checkout.mjs](netlify/functions/checkout.mjs)). The function rebuilds the order from its own price table, creates a Square payment link, and redirects the shopper to Square's hosted payment page. Each line item's note carries the monogram details. Square collects the shipping address, then sends the shopper back to `/?checkout=complete`, which clears the bag.

Set these in Netlify → Project configuration → Environment variables:

| Variable | |
| --- | --- |
| `SQUARE_ACCESS_TOKEN` | Required. Mark it as secret. |
| `SQUARE_LOCATION_ID` | Required. |
| `SQUARE_ENVIRONMENT` | `sandbox` (default) or `production`. |
| `SHIPPING_FEE_CENTS` | Optional flat shipping fee, e.g. `800` for $8.00. |

When you change a product or price, update both the `P` array in `index.html` and `PRODUCTS` in the function.

## Status

Prices, policies and reviews are placeholders. The event inquiry form and the newsletter sign-up are not connected to a backend yet. The bag is saved in the browser's `localStorage`.

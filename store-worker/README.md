# bakehouse-store

The Worker behind the recipe cards. Takes the payment, then hands over the PDF.

It is deliberately separate from the website Worker, the same way
`bakehouse-diagnose` is. Deploying this cannot break the site.

---

## What it does

| Route | Job |
| :---- | :---- |
| `POST /checkout` | Starts a Stripe payment for one recipe. The page sends a slug, nothing else. |
| `GET /download` | Checks with Stripe that the payment actually cleared, then streams the PDF. |

**The price lives in this Worker, not on the page.** That is the part that
matters. If the browser sent the price, anyone could open dev tools, change
500 to 1, and buy a $5 card for a penny. The page only ever says which
recipe; `CATALOG` in `src/index.js` decides what it costs.

**The PDFs are not on the website.** They sit in a private R2 bucket with no
public URL. The only way to get one is to present a Stripe session that
Stripe itself confirms is paid.

---

## Setting it up

Run each line on its own, pressing Enter between them.

### 1. Get to the folder

```
cd "/Users/mfrazier/Cowork OS/Big-Sky/Bakehouse/bakehouse-site/store-worker"
```

### 2. Log in to Cloudflare

```
npx wrangler login
```

A browser window opens. Approve it and come back.

### 3. Make the bucket the PDFs will live in

```
npx wrangler r2 bucket create bakehouse-recipes
```

### 4. Put the recipe PDFs in it

One line per recipe. Run them one at a time.

```
npx wrangler r2 object put bakehouse-recipes/soft-shells-tortillas.pdf --file "/Users/mfrazier/Cowork OS/Big-Sky/Bakehouse/Recipes/soft-shells-tortillas.pdf" --remote
```

```
npx wrangler r2 object put bakehouse-recipes/sourdough-pizza-crust.pdf --file "/Users/mfrazier/Cowork OS/Big-Sky/Bakehouse/Recipes/sourdough-pizza-crust.pdf" --remote
```

```
npx wrangler r2 object put bakehouse-recipes/plain-jane-loaf.pdf --file "/Users/mfrazier/Cowork OS/Big-Sky/Bakehouse/Recipes/plain-jane-loaf.pdf" --remote
```

Add the others as their cards get finished.

### 5. Give it your Stripe key

Get the key first: **dashboard.stripe.com**, then *Developers*, then *API keys*,
then the **Secret key**. It starts with `sk_live_` for real payments or
`sk_test_` for testing. **Start with the test one.**

```
npx wrangler secret put STRIPE_SECRET_KEY
```

It prompts you to paste. Paste it and press Enter. Nothing is echoed to the
screen and nothing is written into this folder.

### 6. Deploy

```
npx wrangler deploy
```

It prints a URL like `https://bakehouse-store.<your-name>.workers.dev`.
**Copy that URL.**

### 7. Switch the buttons on

Open `shop/index.html` in the site folder, find `CHECKOUT_URL`, and paste
the URL between the quotes. Commit and push, and the Buy buttons go live.

---

## Testing before real money moves

With the `sk_test_` key set, Stripe accepts card number
`4242 4242 4242 4242`, any future expiry, any CVC. It behaves exactly like a
real payment but nothing is charged. Buy a recipe from your own site, confirm
the PDF appears, then swap in the `sk_live_` key and deploy again.

## Changing a price

Edit `cents` in `CATALOG`, then `npx wrangler deploy`. Nothing on the website
needs to change, because the website never knew the price.

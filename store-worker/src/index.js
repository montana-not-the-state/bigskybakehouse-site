/* ------------------------------------------------------------------
   Big Sky Bakehouse recipe store.

   Three jobs:
     POST /checkout   start a Stripe payment for one recipe
     GET  /download   hand over the PDF, but only to someone who paid
     POST /webhook    record the sale (optional, see README)

   No npm packages. Stripe has a plain REST API and Workers can call it
   with fetch, which keeps this Worker dependency-free.
------------------------------------------------------------------ */

const ALLOWED_ORIGINS = [
  "https://bigskybakehouse.com",
  "https://www.bigskybakehouse.com",
];

/* ------------------------------------------------------------------
   THE CATALOG LIVES HERE, ON THE SERVER, AND THAT IS DELIBERATE.

   Price must never come from the browser. If the page sent the price,
   anyone could open dev tools, change 500 to 1, and buy a $5 recipe
   for a penny. The page sends only a slug; this file decides what that
   costs and which file it unlocks.

   cents  what Stripe charges, in cents. 500 = $5.00
   file   the object key in the R2 bucket
------------------------------------------------------------------ */
const CATALOG = {
  "soft-shells":       { name: "Soft Shells",                       cents: 500, file: "soft-shells-tortillas.pdf" },
  "brown-butter-bliss":{ name: "Brown Butter Bliss",                cents: 500, file: "brown-butter-bliss.pdf" },
  "zaa-crust":         { name: "Zaa Crust",                         cents: 500, file: "sourdough-pizza-crust.pdf" },
  "ooey-gooey":        { name: "The Ooey Gooey",                    cents: 500, file: "the-ooey-gooey-cinnamon-rolls.pdf" },
  "chocolate-chip":    { name: "Sourdough Chocolate Chip Cookies",  cents: 500, file: "sourdough-chocolate-chip-cookies.pdf" },
  "plain-jane-loaf":   { name: "Plain Jane Loaf",                   cents: 0,   file: "plain-jane-loaf.pdf" },
};

const SITE = "https://bigskybakehouse.com";

function cors(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}

/* Stripe's REST API takes form encoding, not JSON. */
async function stripe(env, path, method, params) {
  const init = {
    method,
    headers: {
      Authorization: "Bearer " + env.STRIPE_SECRET_KEY,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };
  if (params) init.body = new URLSearchParams(params).toString();
  const res = await fetch("https://api.stripe.com/v1/" + path, init);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "Stripe request failed");
  return data;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    if (!env.STRIPE_SECRET_KEY) {
      return json({ error: "Stripe key not set on this Worker yet." }, 503, origin);
    }

    /* ---------------- POST /checkout ---------------- */
    if (url.pathname === "/checkout" && request.method === "POST") {
      let slug;
      try { ({ slug } = await request.json()); } catch { return json({ error: "Bad request" }, 400, origin); }

      const item = CATALOG[slug];
      if (!item) return json({ error: "No such recipe" }, 404, origin);

      /* A free recipe never touches Stripe. Stripe will not process a
         zero charge, and there is nothing to verify afterwards. */
      if (item.cents === 0) return json({ free: true }, 200, origin);

      const session = await stripe(env, "checkout/sessions", "POST", {
        mode: "payment",
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": String(item.cents),
        "line_items[0][price_data][product_data][name]": item.name + " recipe card",
        "line_items[0][quantity]": "1",
        "metadata[slug]": slug,
        success_url: SITE + "/recipes/?paid={CHECKOUT_SESSION_ID}",
        cancel_url: SITE + "/r/" + slug,
});

      return json({ url: session.url }, 200, origin);
    }

    /* ---------------- GET /download ----------------
       The PDF is never at a guessable URL. The only way to get bytes
       out of this Worker is to present a Stripe session that Stripe
       itself confirms is paid. */
    if (url.pathname === "/download" && request.method === "GET") {
      const id = url.searchParams.get("session_id");
      if (!id) return json({ error: "Missing session" }, 400, origin);

      let session;
      try { session = await stripe(env, "checkout/sessions/" + encodeURIComponent(id), "GET"); }
      catch { return json({ error: "Could not verify that payment" }, 400, origin); }

      if (session.payment_status !== "paid") {
        return json({ error: "That payment did not complete" }, 402, origin);
      }

      const item = CATALOG[session.metadata?.slug];
      if (!item) return json({ error: "No such recipe" }, 404, origin);

      const obj = await env.RECIPES.get(item.file);
      if (!obj) return json({ error: "The file is missing. Email me and I will send it." }, 500, origin);

      return new Response(obj.body, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'inline; filename="' + item.file + '"',
          "Cache-Control": "private, no-store",
          ...cors(origin),
        },
      });
    }

    return json({ error: "Not found" }, 404, origin);
  },
};

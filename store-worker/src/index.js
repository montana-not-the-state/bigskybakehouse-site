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

   cents  what Stripe charges, in cents. 700 = $7.00
   file   the object key in the R2 bucket
------------------------------------------------------------------ */
const CATALOG = {
  "soft-shells":       { name: "Soft Shells",                       cents: 700, file: "soft-shells-tortillas.pdf" },
  "brown-butter-bliss":{ name: "Brown Butter Bliss",                cents: 700, file: "brown-butter-bliss.pdf" },
  "zaa-crust":         { name: "Zaa Crust",                         cents: 700, file: "sourdough-pizza-crust.pdf" },
  "ooey-gooey":        { name: "The Ooey Gooey",                    cents: 700, file: "the-ooey-gooey-cinnamon-rolls.pdf" },
  "chocolate-chip":    { name: "Sourdough Chocolate Chip Cookies",  cents: 700, file: "sourdough-chocolate-chip-cookies.pdf" },
  "plain-jane-loaf":   { name: "Plain Jane Loaf",                   cents: 0,   file: "plain-jane-loaf.pdf" },

  /* Physical goods. `ship: true` is the whole difference: Stripe has to ask
     for an address, and there is no file to hand back afterwards. */
  "kenzo-starter-kit": { name: "A Piece of Kenzo, dried starter",    cents: 1500, ship: true },
  "pancake-mix":       { name: "Sourdough Pancake Mix",              cents: 0,    ship: true },
};

const SITE = "https://bigskybakehouse.com";

/* Airtable. Ids rather than names, because a rename in the UI would silently
   break name-based references and this code runs unattended. */
const AT = {
  base:      "app1imrKz4YPnv38p",
  products:  "tbllIUKsQwUckRqpE",
  orders:    "tblMsQBgKvqP6RPIA",
  clients:   "tblICPgb3GoBdsLw5",
};

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

      const params = {
        mode: "payment",
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": String(item.cents),
        "line_items[0][price_data][product_data][name]": item.name,
        "line_items[0][quantity]": "1",
        "metadata[slug]": slug,
        success_url: SITE + "/shop/?paid={CHECKOUT_SESSION_ID}",
        cancel_url: SITE + "/r/" + slug,
      };

      /* Anything posted needs somewhere to post it to. Stripe collects and
         validates the address, so it never passes through this Worker. US
         only for now: interstate cottage food rules are unresolved and
         international is a different problem again. */
      if (item.ship) {
        params["shipping_address_collection[allowed_countries][0]"] = "US";
        params["phone_number_collection[enabled]"] = "true";
      }

      /* Stripe's own message comes back as readable JSON. Without this the
         Worker throws and Cloudflare shows a bare "error code: 1101", which
         says nothing about what Stripe actually objected to. */
      let session;
      try {
        session = await stripe(env, "checkout/sessions", "POST", params);
      } catch (e) {
        return json({ error: "Stripe: " + String(e && e.message || e) }, 502, origin);
      }
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

      /* Nothing to download for something that arrives in the post. */
      if (item.ship) {
        return json({ shipped: true, name: item.name }, 200, origin);
      }

      /* arrayBuffer, because KV returns the value itself rather than an
         object wrapper the way R2 does. */
      const pdf = await env.RECIPES.get(item.file, "arrayBuffer");
      if (!pdf) return json({ error: "The file is missing. Email me and I will send it." }, 500, origin);

      return new Response(pdf, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'inline; filename="' + item.file + '"',
          "Cache-Control": "private, no-store",
          ...cors(origin),
        },
      });
    }

    /* ---------------- POST /webhook ----------------
       Stripe calls this when a payment clears. It is the only thing that
       writes to Airtable, so a sale that Stripe did not confirm can never
       create a row. */
    if (url.pathname === "/webhook" && request.method === "POST") {
      const raw = await request.text();
      const sig = request.headers.get("stripe-signature") || "";

      /* Verify it really came from Stripe. Without this, anyone who finds
         this URL can post fake orders into her base. */
      if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: "No webhook secret set" }, 503, origin);
      const ok = await verifyStripe(raw, sig, env.STRIPE_WEBHOOK_SECRET);
      if (!ok) return json({ error: "Bad signature" }, 400, origin);

      const event = JSON.parse(raw);
      if (event.type !== "checkout.session.completed") {
        return json({ ignored: event.type }, 200, origin);
      }

      try {
        await recordOrder(env, event.data.object);
      } catch (e) {
        /* A 500 makes Stripe retry for up to 72 hours, which is what we want:
           a transient Airtable failure should not lose the order. */
        return json({ error: String(e && e.message || e) }, 500, origin);
      }
      return json({ ok: true }, 200, origin);
    }

    return json({ error: "Not found" }, 404, origin);
  },
};

/* ------------------------------------------------------------------
   Stripe webhook signature, done with WebCrypto because Workers has no
   Node crypto. Stripe signs "<timestamp>.<raw body>" with HMAC SHA-256.
------------------------------------------------------------------ */
async function verifyStripe(raw, header, secret) {
  const parts = {};
  header.split(",").forEach(function (p) {
    const i = p.indexOf("=");
    if (i > 0) parts[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  if (!parts.t || !parts.v1) return false;

  /* Reject anything older than five minutes, so a captured request cannot
     be replayed later. */
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(parts.t + "." + raw));
  const hex = [...new Uint8Array(mac)].map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");

  /* Constant-time compare, so a wrong signature does not leak how wrong. */
  if (hex.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}

async function at(env, path, method, body) {
  const res = await fetch("https://api.airtable.com/v0/" + path, {
    method: method || "GET",
    headers: {
      Authorization: "Bearer " + env.AIRTABLE_PAT,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error("Airtable: " + JSON.stringify(data.error || data));
  return data;
}

/* Clients is the address book and stays canonical, so an order links to an
   existing person rather than making a second row for the same email. */
async function findOrCreateClient(env, email, name) {
  if (!email) return null;
  const q = encodeURIComponent('LOWER({Email}) = "' + email.toLowerCase().replace(/"/g, '') + '"');
  const found = await at(env, AT.base + "/" + AT.clients + "?maxRecords=1&filterByFormula=" + q);
  if (found.records && found.records.length) return found.records[0].id;

  const made = await at(env, AT.base + "/" + AT.clients, "POST", {
    records: [{ fields: { Name: name || email, Email: email, Notes: "Added automatically from a shop order." } }],
  });
  return made.records[0].id;
}

async function recordOrder(env, session) {
  const slug = session.metadata && session.metadata.slug;
  const item = CATALOG[slug];

  /* Look the product up by slug. If it is missing the order is still written,
     just unlinked, because losing a sale is worse than an incomplete row. */
  let productId = null;
  if (slug) {
    const q = encodeURIComponent('{Slug} = "' + slug.replace(/"/g, '') + '"');
    const hit = await at(env, AT.base + "/" + AT.products + "?maxRecords=1&filterByFormula=" + q);
    if (hit.records && hit.records.length) productId = hit.records[0].id;
  }

  const d = session.customer_details || {};
  const ship = session.shipping_details || {};
  const a = (ship.address || d.address || {});
  const lines = [a.line1, a.line2, [a.city, a.state, a.postal_code].filter(Boolean).join(" "), a.country]
    .filter(Boolean).join("\n");

  const clientId = await findOrCreateClient(env, d.email, ship.name || d.name);

  const fields = {
    "Order ID": session.id,
    Date: new Date((session.created || Date.now() / 1000) * 1000).toISOString(),
    Amount: (session.amount_total || 0) / 100,
    Email: d.email || "",
  };
  if (productId) fields.Product = [productId];
  if (clientId) fields.Client = [clientId];
  if (item && item.ship) {
    fields["Ship Name"] = ship.name || d.name || "";
    fields["Ship Address"] = lines;
  }
  if (!productId) fields.Notes = "No product matched slug " + (slug || "(none)") + ". Check the Slug field.";

  await at(env, AT.base + "/" + AT.orders, "POST", { records: [{ fields: fields }] });
}

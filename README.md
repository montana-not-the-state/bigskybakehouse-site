# bigskybakehouse.com

The sourdough diagnostic — "What went wrong?" — plus the Worker that powers its
free-text box.

```
index.html          the whole site. One file, no build step.
worker/             optional. Only needed for the "describe it" box.
```

**The page works with no server at all.** The twelve symptom paths are in
`index.html`. Deploy that file and you have a working tool. The Worker is a
separate, later step.

---

## Step 1 — put the page online (about 15 minutes)

1. Go to **dash.cloudflare.com** → *Workers & Pages* → *Create* → *Pages* →
   *Connect to Git*, and point it at this repo.
2. Build settings: leave the build command **empty**, set the output directory
   to **`/`**. There's nothing to compile.
3. Deploy. Cloudflare gives you a `*.pages.dev` URL. Check it works.
4. *Custom domains* → *Set up a domain* → `bigskybakehouse.com`. If your domain
   is registered elsewhere, Cloudflare tells you which nameservers to point at
   it. That change is made at your registrar and can take a few hours.

Drag-and-drop also works if you'd rather not connect Git: on the same *Create*
screen choose *Upload assets* and drop this folder in.

**Before you share the link:** open it in a private window. What you see there
is what a stranger from Instagram sees.

### The favicon

`index.html` looks for `favicon.png` next to it. Copy `logo/profile-mark.png`
from the bakehouse vault into this folder and rename it. Until you do, the tab
just shows a blank icon — nothing breaks.

---

## Step 2 — the "describe it" box (optional)

This is the part that costs money and needs an API key. Skip it until the page
has proven it gets traffic.

You need an Anthropic API key from **console.anthropic.com**. Create it
yourself — it should never be pasted into a chat, a file, or this repo.

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY   # paste the key at the prompt
npx wrangler deploy
```

That last command prints a URL like
`https://bakehouse-diagnose.<your-name>.workers.dev`.

Then two edits:

1. In `index.html`, find `var API_ENDPOINT = "";` near the top of the script and
   paste that URL between the quotes. The box appears on the next deploy.
2. In `worker/src/index.js`, check `ALLOWED_ORIGINS` lists your real domain.
   Anything not on that list can't call the Worker from a browser.

### What it costs

Every question is one API call on **your** account — roughly 600 tokens in and
200 out on `claude-opus-5`. At a few hundred questions a month that's small, but
it is not zero and it scales with traffic, so keep an eye on the Anthropic
console for the first few weeks.

To spend less, change `model` in `worker/src/index.js` to `claude-sonnet-5` or
`claude-haiku-4-5`. Read a few answers afterward — the voice is the thing you'd
be trading away.

### The rate limit

`worker/src/index.js` caps each visitor at 8 questions per 10 minutes. It counts
in memory, which means Cloudflare's many server instances each keep their own
count — it's a speed bump, not a wall. If the tool ever gets real traffic or
someone abuses it, move the counter to a KV namespace or Cloudflare's Rate
Limiting binding.

---

## Step 3 — the email list (optional)

`index.html` has a "send me the printable" form, hidden until it has somewhere
to post. Make a form at MailerLite, Buttondown or Formspree (all have free
tiers), then paste its POST URL into `var EMAIL_ENDPOINT = "";`.

---

## Editing the content

Everything the tool says lives in the `SYMPTOMS` array in `index.html`. Each
entry is:

```js
{
  id:    "flat",                      // unique, no spaces
  name:  "Flat and spread out",       // the tile
  sub:   "Went wide instead of up",   // the small grey line
  lede:  "The classic. Nearly...",    // the italic line
  causes: [ { name, odds, why } ],    // odds: "high" | "mid" | "low"
  fix:   "Cut bulk short and..."      // the "Next bake" box
}
```

Add a symptom by copying a block and changing the text. The tile appears
automatically. `odds` sets both the label ("Most likely" / "Likely" /
"Possible") and the length of the bar, so use it honestly.

The colours and fonts at the top of the `<style>` block are the Big Sky
Bakehouse brand tokens. They match the brand guide and the other bakehouse
pages — don't restyle this one on its own.

---

## What is deliberately not here

- **No analytics.** Add Cloudflare Web Analytics from the dashboard if you want
  numbers; it needs no code and no cookie banner.
- **No tracking, no cookies, no consent banner.** Keep it that way if you can —
  it's one less thing to maintain and one less thing to get wrong.
- **Nothing from the bakehouse vault.** The operating plan, the margins and the
  Oscar's prep stay in the private repo. This repo is public.

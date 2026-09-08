# relay-portal — notes for Claude

Read this before changing anything. Every item below cost real debugging time
to find, and several of them look fine until you check the authoritative source.

## Landmines

**There is exactly one netlify.toml that Netlify reads: `relay-pwa/netlify.toml`.**
The Netlify UI sets **Base directory = `relay-pwa`**, so config resolves from
there, not the repo root. A second netlify.toml used to sit at the root and was
silently ignored on every build — edits to it looked applied and did nothing.
It has been deleted. Before editing build config, run
`find . -name netlify.toml -not -path "*/node_modules/*"` and confirm there is
still only one.

**The Netlify site IS connected to GitHub.** Pushing to `main` triggers a build
automatically (verified: push → build with matching `commit_ref` ~2s later).
A deploy showing `deploy_source: "api"` / `commit_ref: null` means *someone
deployed by upload*, not that the repo is unlinked. Do not conclude anything
about the Git connection from a deploy record you created yourself.

**The cloud container cannot push to this repo.** A proxy blocks
`RelayAiUSA/relay-portal`. Commit and push from the user's machine
(`device_bash`). Drafting files in the container is fine; just commit from the
device, then `git reset --hard origin/main` in the container so no duplicate
commits linger.

**`device_bash` cannot delete files** in mounted folders (`rm` → "Operation not
permitted"). Use `git rm --cached` plus a `.gitignore` entry to drop something
from the repo without unlinking it, or request delete permission.

**The Twilio SDK cannot be bundled by esbuild.** Its dynamic requires break with
`ERR_MODULE_NOT_FOUND: '../jwt/validation/ValidationToken'`, which crashes the
function at import. All functions send SMS via `fetch` against the Twilio REST
API instead. **Do not reintroduce `import twilio from 'twilio'`.**

**Netlify's secret scanner fails the build** if an env var's *value* appears in
source. Do not hardcode Stripe price IDs or anything else that is also an env
var. Tier config is env-driven in `stripe-webhook.mjs` for this reason.

**Plan names are inconsistently cased in Firestore** (`"Starter"` and
`"starter"` both exist). Always `.toLowerCase()` before comparing a plan.

**Scheduled functions:** `review-request` (hourly) and `oauth-refresh-sweep`
(daily 08:00 UTC). `oauth-refresh-sweep` also declares its schedule via
`export const config` in the file, which is authoritative. A scheduled function
returns **403** to a manual POST — that means it is correctly registered, not
that it is broken. Confirm registration in a deploy's `function_schedules`.

**The Stripe connector is read-only.** It can read prices, subscriptions and
webhook endpoints but cannot write any of them. Do not plan work that depends
on writing to Stripe; ask the user.

## Verify before claiming

Four wrong diagnoses in one session all came from inferring configuration from a
downstream symptom. Before asserting something is broken or misconfigured:

- **"Is X configured?"** → read the config itself, not a symptom of it.
- **"Is this unused / safe to remove?"** → enumerate what references it
  (payment links, subscriptions, imports, grep). Existence is not usage.
- **"Does this page/URL work?"** → render it in the browser. `curl` on a
  JS-rendered SPA returns an empty shell; grepping it for "error" or
  "not found" matches strings inside JS bundles and proves nothing.
- **Never treat your own action as evidence about the system.**

State confidence honestly: "verified by X" vs "I suspect". A wrong confident
claim costs more than saying you haven't checked yet.

## Layout

```
relay-pwa/netlify.toml      the only build config
relay-pwa/functions/*.mjs   Netlify Functions v2, ESM (export default async (req) => ...)
relay-pwa/functions/lib/    token-helpers.mjs, alert.mjs, accounting-sync.mjs
relay-pwa/js/app.js         frontend; STRIPE_BILLING + buy links live here
firestore.rules             billing fields are client-immutable
```

Firebase project `relay-portal-68417` is under **c.pryor006@gmail.com** — use
`https://console.firebase.google.com/u/1/...`.

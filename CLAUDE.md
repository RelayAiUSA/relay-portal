# relay-portal — notes for Claude

Read this before changing anything. Every item below cost real debugging time
to find, and several of them look fine until you check the authoritative source.

## Deploying — ASK FIRST, ALWAYS

**Clyde has explicitly asked that all changes be held locally until he says to
deploy.** Honour this without needing to be reminded again.

There is no staging step in this project: the Netlify site auto-builds from
GitHub, so **`git push` to `main` IS a production deploy** on portal-relay.com.
A push is not "saving work" here - it ships to real users the moment it lands.

The working pattern:
1. Make the change on the device (`device_bash`) and `git commit` locally.
2. **Do not push.** Say what is staged and wait.
3. Push only when Clyde says to deploy.

If a change genuinely must be visible before he approves it, push a BRANCH -
Netlify builds a deploy preview URL for branches - and never `main`.

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

**Firestore rules must cover EVERY collection the app touches.** Rules do not
inherit: a subcollection with no `match` block falls through to the deny-all.
This has already caused one production lockout. `loadUserData()` reads the
profile, invoices, customers and docCounts together; when docCounts had no rule
the denied read rejected the whole batch, the catch fell back to
`plan:'unpaid'`, and every signed-in user landed on the locked screen - locked
out of a paid account. `publicDocs` was denied at the same time, which broke
both creating a document and opening a share link in doc.html.
Before deploying rules, enumerate and compare:
`grep -ohE "collection\('[a-zA-Z_]+'\)" relay-pwa/js/app.js relay-pwa/functions/*.mjs | sort -u`
against `grep -oE "match /[a-zA-Z_]+/" firestore.rules`. Current collections:
users, invoices, customers, dispatch, docCounts, oauth_tokens, publicDocs.

**The contractor's phone number is the only thing identifying an inbound job
text**, and the field names did not line up. Signup wrote `phone`; every
function reads `phoneNumber`, which appeared ZERO times in app.js. Every account
created through the portal was therefore unable to text a job in from the moment
it was created - the reply was always "Phone number not registered with Relay".
Canonical fields are now `phoneNumber` (E.164) and `phoneDigits` (last 10, the
lookup key, immune to formatting). `phone` is still written for older readers.
Frontend `toE164`/`phoneDigits` and backend `normalizePhone` must agree; there
is a test that checks they do. If you add a new place a phone is stored, write
all three.

**The service worker was cache-first and silently hid every frontend deploy.**
`sw.js` served `caches.match(req).then(r => r || fetch(req))`, so any file
already in the cache was returned without ever consulting the network, and the
cache name was a hardcoded string nobody bumped. A returning user kept running
whatever `app.js` they first cached. Deploys succeeded, the server served the
new bundle, and the user saw nothing change - the symptom is "that feature you
said you shipped isn't there" while curl of the live file proves it is. Now
network-first for HTML/JS/CSS (cache is an offline fallback only) and
cache-first only for images, fonts and video. If a frontend change is reported
missing, check the live bundle with curl BEFORE assuming the deploy failed, then
suspect the service worker.

**Invoices have two field vocabularies for the same collection.** The portal
form writes `customer` / `work` / `email` / `phone`; twilio-sms writes
`customer_name` / `professional_description` / `customer_email` /
`customer_phone`. The invoice list read only the former, so every SMS-created
invoice displayed as "Unknown" with a blank description. twilio-sms now writes
BOTH shapes, and the frontend reads through `invCustomer()` / `invWork()` /
`invEmail()` / `invPhone()`, which fall back across both - so existing documents
render correctly with no migration. Do not rename either side alone:
accounting-sync and review-request read the underscored names.

**Zoho issues a refresh token only on the FIRST authorization.** Re-authorising
an already-connected account returns an access token alone unless the authorize
URL includes `prompt=consent`. Without it, `encrypt(undefined)` threw a raw
crypto error and the user saw "Could not complete authorization: Internal server
error" - with nothing pointing at reconnection as the trigger. The authorize URL
now sends `access_type=offline&prompt=consent`, oauth-token keeps the stored
refresh token when a provider omits one, and `encrypt()` rejects empty input
with a message naming the real problem. Providers can also answer HTTP 200 with
an error body, so check `data.error` as well as `resp.ok`.

**A missing env var reads as a wrong credential.** Zoho answered
`invalid_client_secret` for weeks. The client ID matched, the redirect URI was
registered, the data centre was right, and the secret itself was provably
valid - a direct curl to `accounts.zoho.com/oauth/v2/token` with that ID and
secret returned `invalid_code`, meaning the pair was accepted. The cause was
that **`ZOHO_CLIENT_SECRET` did not exist in Netlify at all**. `URLSearchParams`
stringifies `undefined` to the literal text `"undefined"`, so a perfectly
plausible "wrong secret" error was really "no secret". Before doubting a
credential's value, list the site's env vars and confirm the key is present -
and curl the provider directly with the pair to see whether the provider
accepts it.

**Every page that touches Firestore needs the SAME firebaseConfig.** `doc.html`
shipped with a placeholder project (`relay-portal-7f8c2`) while `js/app.js` and
`oauth-callback.html` used the real one (`relay-portal-68417`). The page looked
fine, the rules were right, the document existed - and every single share link
and every View / Print PDF click failed with "Could not load document", because
the read went to a project that does not exist. When a Firestore read fails
from one page but works from another, diff the configs before touching rules.

**A default of `platform: 'quickbooks'` is not a safe default.** New profiles
were created pointing at QuickBooks, so accounting-sync pushed invoices at an
account that was never connected. The default is now `'none'`, the profile form
writes `accountingProvider` alongside `platform` so the two cannot disagree, and
accounting-sync falls back to whichever platform actually has tokens on file
when no provider is recorded. An explicit `'none'` is still honoured.

**A valid OAuth token does not mean the right account.** Zoho answered HTTP 200
with an EMPTY `organizations` list: the token worked, the API host was right,
and the Zoho login that authorized simply owned no Zoho Books organization. The
portal showed a healthy connection and every invoice failed. Relay now requests
`AaaServer.profile.READ`, stores the connected account's email on the token
document, and REFUSES to report a successful connection when the account owns
no organization - naming the account in the error. When an integration is
"connected" but nothing syncs, ask which account, not which credential.

**`organizationId` and `realmId` were computed at connect time and never
stored.** They were absent from `tokenDoc`, so `ensureFreshToken` always
returned undefined for both: Zoho re-looked-up the organization on every single
invoice, and QuickBooks failed outright with "QuickBooks realmId missing" for
every customer. If a value is looked up during OAuth, confirm it is actually in
the document that gets written.

**Zoho's line-item `name` is a short label, max ~200 characters.** The AI writes
a paragraph of work performed, and that paragraph was being sent as the item
name, so Zoho answered `HTTP 400 code 15` on every real job while short test
data passed. The paragraph belongs in `description`. `name` now prefers
`job_type` and otherwise takes the first 100 characters cut on a word boundary.
QuickBooks caps `Description` at 4000 for the same class of failure. When an
integration works on test data and fails on real data, suspect a length limit.

**Sending an SMS is not delivering one.** Twilio accepts a message, returns a
SID, and learns the carrier's verdict later. Relay logged "reply sent" while the
handset stayed silent, which is indistinguishable from a bug in our own code.
The TwiML reply made this worse - no SID at all. The contractor reply now goes
through the REST API with a `StatusCallback`, and `sms-status.mjs` records the
carrier's verdict with the error code. Never report a send as a delivery.

**The Stripe connector is read-only.** It can read prices, subscriptions and
webhook endpoints but cannot write any of them. Do not plan work that depends
on writing to Stripe; ask the user.

**The brand name must be identical in three places.** A toll-free verification
reviewer compares the brand in your SMS message sample against the brand on the
opt-in page against the legal entity on the form. The SMS said "Relay AI" - a
retired name appearing nowhere else in the product - while the site said "Relay"
and the entity is Pryor Digital Ventures LLC. Three names is a standard
rejection. Current state: legal entity **Pryor Digital Ventures LLC**, brand
**Relay**, assumed name **"Relay Dispatch" filed with Michigan LARA and
processing** (the DBA "Relay" was DENIED - an entity with that name already
exists in Michigan). When the DBA clears, rename in the product copy only -
footer, page titles, landing hero, legal pages, signup consent and the SMS
strings in twilio-sms.mjs. Do NOT rename env vars, function names, Firestore
collections or CSS classes: pure regression risk, zero benefit. The domain
portal-relay.com stays either way.

**The document counter only counted half the product.** The usage meter read
`docCounts`, which only the portal's web form ever wrote. Almost every real
document arrives by SMS, so the number sat still and looked broken. Whenever a
counter, limit or metric looks wrong, check that EVERY path which creates the
thing being counted also increments it - there are two writers of the invoices
collection in this codebase and there have now been three separate bugs caused
by only updating one of them.

**An opt-out belongs to the consumer, not to a contractor's customer record.**
STOP was handled only by Twilio, so Relay's own data still believed an
opted-out consumer was textable - and a contractor could re-add or edit that
customer record and Relay would text them again, which is exactly the fact
pattern a TCPA claim is built on. `lib/suppression.mjs` keeps a top-level
`smsSuppressions` collection keyed by the last 10 digits, written by the Admin
SDK only (no client rule, so the deny-all covers it, which is correct). It is
captured on BOTH paths - an inbound STOP handled before the contractor lookup
(the person opting out is usually not one of our accounts, so a lookup-first
order would answer "not registered" and throw the opt-out away) and Twilio error
21610 on the status callback. It is checked inside `canTextCustomer()`, the one
gate every customer-facing message already passes, rather than at each call
site. `isSuppressed()` fails CLOSED.

**Quiet hours are enforced in the same gate.** The TCPA restricts texts before
8am and after 9pm in the RECIPIENT'S local time, and Relay sent whenever a job
happened to be texted in - a contractor finishing at 9:30pm generated a
violation automatically. The recipient's zone is inferred from their area code;
unknown codes fall back to Eastern deliberately, because Eastern reaches 9pm
first, so holding to it never sends late anywhere else in the country. A quiet
-hours block is a "not yet", not a "never": review-request runs hourly and picks
the message up in the morning.

**Review follow-up has THREE gates, all required.** (1) RelayPRO plan.
(2) The contractor ticked "Send a review follow-up to this customer" on that
customer's profile - `reviewFollowUp`, opt-in per customer, defaulted to an
explicit `false` so it is never undefined. (3) The consumer replied YES to the
invitation appended to their invoice. Nobody is solicited by default, on any
plan. The consumer's own answer is stored as `reviewConsentByCustomer` with the
exact prompt wording, and it outranks the contractor's attestation in both
directions - a YES satisfies the promotional scope outright, a NO blocks it
outright. The reply arrives from a CONSUMER's number, which belongs to no Relay
account, so it is handled BEFORE the contractor lookup in twilio-sms - exactly
like STOP - or it would hit "Phone number not registered" and the most valuable
consent artifact in the product would be discarded. See lib/review-invite.mjs.

**There is no bulk consent button, and there must not be one again.** It let a
contractor attest consent for an entire imported list in a single click -
people who never agreed to anything - and it was the only feature in this
product capable of generating hundreds of TCPA violations from one action.
Removed 2026-09-09. Permission is answered per customer, on that customer's own
page. If a future request asks for "approve all" or a bulk import shortcut, this
is the reason to push back.

**"Just use Eastern hours" does the opposite of what it sounds like.** 8am
Eastern is 5am in California, so holding every recipient to an Eastern START
creates the violation it was meant to prevent. Only the LATEST start and the
EARLIEST end are safe nationwide: **11:00-21:00 Eastern = 08:00-18:00 Pacific**.
That national window is a floor applied ON TOP of the per-recipient area-code
check, and both must pass - the recipient check is the accurate one, the
national floor is what holds when the area code is wrong about where someone
actually lives (people keep numbers when they move).

**`validateTwilioSignature` returns an OBJECT, not a boolean.** sms-status was
written as `if (!validateTwilioSignature(...))`. An object is always truthy, so
the negation was always false and the guard NEVER fired - every forged POST was
accepted. That was not cosmetic: `ErrorCode=21610` writes a permanent
suppression, so anyone could have silently blocked message delivery to any phone
number they named. twilio-sms reads `.valid` correctly; sms-status did not.
Read the helper's return type before negating it.

**A 204 response carrying a body breaks Netlify's lambda encoder.**
`new Response('', { status: 204 })` produced `error decoding lambda response:
unexpected end of JSON input` and a 502 on every Twilio status callback - so the
delivery monitoring built in L10 was dead on arrival and Twilio saw the endpoint
as broken. Return `200` with a short body instead. Health-check every function
after adding one: a POST that should give 403 giving 502 is the tell.

**A backup is a hypothesis until it has been restored.** `firestore-backup.mjs`
is only half the feature; `scripts/firestore-restore.mjs` is the half that gets
skipped and the half that matters on the worst day. Two design rules there are
load-bearing and should not be "simplified" away: the backup refuses to store a
snapshot with zero documents (an empty export means the credentials are pointed
at the wrong project - writing that over a good backup converts a config
mistake into data loss), and it reads the blob back and compares byte length
before pruning anything. A write that reports success and stores nothing is
precisely the failure the whole function exists to prevent, and nothing else in
the system would ever notice it.

**Firestore's managed backups are Blaze-only.** Scheduled backups,
point-in-time recovery and managed export/import all require the paid plan;
`relay-portal-68417` is on Spark. Nothing in the console will let you enable
them, so do not spend time hunting for the setting - it is a billing decision.

**The backup walk must never be hardcoded to a collection list.** It uses
`db.listCollections()` and, per document, `ref.listCollections()`. Firestore has
no global index of subcollection names, and almost all of the customer data in
this product lives in subcollections (`users/{uid}/customers`). A backup that
misses a collection looks completely healthy right up to the day it is needed.

**A snapshot pulled to disk is every customer's data in plaintext.** `.gitignore`
covers `backup-latest.json`, `*.backup.json` and bare `YYYY-MM-DD.json`. Do not
commit one, do not attach one, and delete local pulls when finished with them.

**Bare `import 'firebase-admin/...'` from `scripts/` resolves to a DIFFERENT
copy** than the functions use - the repo root has its own older firebase-admin
(v11) while `relay-pwa/functions/node_modules` has v12. Every `instanceof
Timestamp` is then false for reasons that have nothing to do with the code under
test. The repo-root package.json is largely vestigial; the functions' one is
what deploys. Test scripts import firebase-admin by explicit path into
`relay-pwa/functions/node_modules`, and the npm scripts `cd` there first.

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
relay-pwa/functions/lib/    token-helpers.mjs, alert.mjs, accounting-sync.mjs,
                            consent.mjs, suppression.mjs, review-invite.mjs,
                            parse-guard.mjs, sentry.mjs, twilio-signature.mjs,
                            firestore-backup.mjs
relay-pwa/js/app.js         frontend; STRIPE_BILLING + buy links live here
firestore.rules             billing fields are client-immutable
scripts/                    firestore-restore.mjs (list / pull / restore),
                            test-firestore-backup.mjs
```

Repo-root npm scripts: `backup:list`, `backup:pull`, `backup:restore`,
`test:backup`. Each `cd`s into `relay-pwa/functions` first so dependencies
resolve from the copy that actually deploys.

Firebase project `relay-portal-68417` is under **c.pryor006@gmail.com** — use
`https://console.firebase.google.com/u/1/...`.

## Status — last updated 2026-09-09

Update this section when something moves. It is the answer to "what's done?"

### Live service configuration — verified 2026-09-08

The authoritative record of how the external services are wired, so no future
session has to re-derive it from symptoms. Re-verify a line before trusting it
if the behaviour it describes has changed.

**Netlify** — project `deft-torrone-d9b9f8`, site id
`daf53c3c-d84e-46b2-b6ff-c75da02a8e27`, primary URL `https://portal-relay.com`,
team plan `nf_team_pro`. Base directory `relay-pwa`. Auto-deploys from GitHub
`RelayAiUSA/relay-portal` on push to `main`. **An empty commit does NOT trigger
a build** — Netlify cancels it; push a real file change or use Trigger deploy.
Seven functions: twilio-sms, oauth-token, oauth-refresh-sweep, review-request,
stripe-webhook, sms-status, firestore-backup. Scheduled: `review-request`
hourly, `firestore-backup` daily 07:00 UTC, `oauth-refresh-sweep` daily
08:00 UTC. Netlify Blobs store `firestore-backups` holds the snapshots.

**Netlify env vars** — scope matters. `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`,
`FIREBASE_PROJECT_ID`, `INTUIT_CLIENT_ID`, `QUICKBOOKS_CLIENT_ID`, `QB_CLIENT_ID`
are Functions-scope. Everything else is builds+functions+runtime. Function env
vars are **baked in at deploy time**: adding or changing one does nothing until
the site is rebuilt. `SECRETS_SCAN_OMIT_KEYS=TWILIO_FROM_NUMBER`.
Note: `ZOHO_CLIENT_SECRET` and `STRIPE_WEBHOOK_SECRET` are NOT flagged
`is_secret`, so their values are readable in the Netlify UI — worth toggling on.

**Firebase** — project `relay-portal-68417` (console under c.pryor006@gmail.com).
**Spark (free) plan**, verified 2026-09-09 on the Firestore Disaster Recovery
tab — so managed scheduled backups and point-in-time recovery are unavailable
until someone upgrades to Blaze. Database location `nam5`.
Every page that reads Firestore must carry this same config: app.js,
oauth-callback.html and doc.html. Collections: users, invoices, customers,
dispatch, docCounts, oauth_tokens, publicDocs. `publicDocs` is world-readable by
design — presentation fields only, never tokens or billing.

**Twilio** — the account SID is in Netlify as `TWILIO_ACCOUNT_SID`; it is
deliberately NOT written here, because GitHub push protection rejects a commit
containing one. From number
`+18447291376` (`TWILIO_PHONE_NUMBER`; `TWILIO_FROM_NUMBER` also exists and is
NOT what `sendSms` reads). Alert destination `+17137025744`. Toll-free
verification PENDING — see L-TF. Inbound webhook and StatusCallback both hit
portal-relay.com functions and both validate X-Twilio-Signature.

**Zoho Books** — API console app `RelayUSA`, client id
`1000.HPTPX3D50HAMNOOBYEV4LWZJ045Z7L`, US data centre (`accounts.zoho.com`).
Two redirect URIs registered; the one Relay uses is
`https://portal-relay.com/oauth-callback.html`. Scope
`ZohoBooks.fullaccess.all,AaaServer.profile.READ`. **API host is
`https://www.zohoapis.com/books/v3`, NOT the legacy `books.zoho.com/api/v3`.**
Organization `874815967` — "Pryor Property Solutions", US edition, owned by
PryorPropertySolutions269@Gmail.com. Connecting from any other Zoho login
produces a working token and zero organizations.

**Stripe** — Starter $19 / Essential+ $49 / RelayPRO $99 payment links match
their env vars. Webhook secret set, 5 events registered. The MCP connector is
READ-ONLY.

**Sentry** — DSN set in Netlify, reporting via the SDK-free envelope endpoint.

### Done and verified

- [x] All Netlify Functions load. Root cause was `command = "true"` (a no-op) so
      `npm install` never ran. *Verified: live HTTP responses from all 5.*
- [x] `twilio-sms` SMS dispatch. Was 502 on every inbound message (Twilio SDK vs
      esbuild). Now sends via `fetch`. *Verified: returns valid TwiML.*
- [x] Stripe webhook end to end. Correct 5 events registered, `STRIPE_WEBHOOK_SECRET`
      set. *Verified: signed request -> 200, bad signature -> 400.*
- [x] Firestore security rules deployed (billing fields client-immutable).
- [x] `ALERT_PHONE` set (+17137025744).
- [x] Both scheduled functions registered. *Verified: present in `function_schedules`.*
- [x] Plan tiering driven by env vars; unknown price defaults to `starter`
      (least privilege) rather than `essential`.
- [x] `review-request` lowercases plan before the tier gate.
- [x] Stale build copy removed from the publish dir (was public at `/sessions/...`).
- [x] Single `netlify.toml`; root duplicate and dead CommonJS tree deleted.
- [x] GitHub auto-deploy working. *Verified: push -> build with matching commit_ref.*
- [x] Ownership recorded: proprietary LICENSE + `author` in all package.json files.
- [x] Stripe payment links confirmed correct (Starter $19 / Essential+ $49 /
      RelayPRO $99 -> matching env vars). $19 Starter link since deactivated.

### Open

- [ ] **L-TF. Twilio toll-free verification** for +1 844-729-1376. THE launch
      blocker, and now confirmed rather than assumed: every outbound message is
      rejected with **error 30032, Toll-Free Verification Required**, verified
      on message SID SMc81832da5f4c95be0d6a62c92cac2bd9. Submitted; awaiting
      Twilio approval. Nothing in the code can work around it. Until it clears,
      Relay receives and processes texts perfectly and cannot reply to them.
- [x] **End-to-end SMS dispatch** — DONE 2026-09-08, Zoho invoice INV-000101
      created from a texted job. See L2. Outbound reply still blocked by L-TF.
- [ ] **Michigan LARA** — Articles of Organization for Pryor Digital Ventures LLC;
      Relay DBA filing.
- [ ] **InVideo commercial** — voiceover audio issue.
- [ ] **Google Business Profile** — point at portal-relay.com.
- [ ] **Warm-network outreach** — first 5-10 paying customers.
- [ ] *Optional:* archive the unused $59 Essential+ price in Stripe. No payment
      link and no subscriptions reference it — cosmetic only.

## Launch checklist

Itemised and ordered by what actually blocks a safe launch. L-numbers are stable
references: use them in commits and conversation. Move an item to Done with a
note on how it was verified, not just that it was done.

### Tier 1 - blocking. Do before any paying customer touches the product.

- [x] **L1. Validate the X-Twilio-Signature header on twilio-sms.**
      The endpoint is public and was unauthenticated, so a forged POST naming any
      contractor's phone number created a real invoice in their account, spent an
      Anthropic call, and synced a fabricated invoice to their QuickBooks or Zoho.
      Phone numbers are not secrets. stripe-webhook already validated its own
      signature; this brings the Twilio path to the same standard.
      Implemented in `functions/lib/twilio-signature.mjs`, verified against
      Twilio's published worked example plus forged-body, forged-From, missing
      header, wrong token and behind-a-proxy cases. Runs before the Firestore
      lookup, the AI call and the invoice write, so a forged request costs
      nothing. Escape hatch: `TWILIO_SIGNATURE_VALIDATION=off`.

- [x] **L2. End-to-end SMS dispatch - PROVEN 2026-09-08.**
      Text in -> AI parse -> invoice in Firestore -> printable public document
      -> Zoho Books. Verified in the live function log:
      `[accounting-sync] Synced invoice 178ezhOqabbeTHi8kqS5 to zoho: INV-000101`.
      Four separate bugs stood between the components and a working chain, all
      in Landmines above: doc.html pointed at a nonexistent Firebase project;
      the accounting provider defaulted to QuickBooks; the Zoho connection was
      authorized by an account with no Books organization; and the work
      description was being sent as Zoho's short item name.

      Still outstanding on this item: the contractor's reply SMS is built and
      accepted by Twilio but **undelivered - error 30032, Toll-Free
      Verification Required**. That is a carrier block, not a code path, and it
      clears with L-TF below. The customer-facing document forward and the 24h
      review request are gated behind the same verification and remain
      unproven end to end.

- [x] **L3. Real error monitoring.**
      Two problems, both fixed.

      (a) Every function had an unguarded prologue - work before its own try
      block, such as getDb() or reading the request - so an error there escaped
      with no alert: the function 500'd and nobody was told. All five handlers
      are now inner functions wrapped by an exported catch-all that logs,
      alerts, and returns a protocol-appropriate response (TwiML for twilio-sms
      so the contractor is not left in silence; 500 for stripe-webhook
      precisely because Stripe retries 5xx).

      (b) alertError() only texted a phone: no stack trace, no grouping, and
      one bug in a loop meant one text per occurrence. It also alerted THROUGH
      Twilio, so a Twilio outage silenced the alarm about itself.

      `lib/sentry.mjs` reports to Sentry over the envelope HTTP endpoint with
      NO SDK - deliberately. The twilio SDK already proved esbuild cannot bundle
      a large SDK here, and serverless SDKs queue events that are lost when the
      runtime freezes. A single awaited fetch has neither failure mode, and the
      file is a few KB against roughly a megabyte. Stack frames are parsed and
      reversed so the throwing line reads last, with node: internals and
      node_modules marked out-of-app.

      alertError now sends to both: Sentry always (never throttled - it is the
      record), SMS only when it is worth an interruption. SMS is deduplicated
      per error signature on a 15-minute window with a hard 5-per-container
      ceiling, so 200 identical errors in a minute produce one text instead of
      200 texts and 200 Twilio charges. A different error is never suppressed
      by another's window.

      Verified: 20 assertions on DSN parsing, stack parsing and event shape; 6
      on the throttle, exercising the real exported function rather than a
      re-implementation; and a live event accepted by Sentry, which delivered
      the notification email. SENTRY_DSN is set in Netlify. Missing DSN is a
      silent no-op, so nothing breaks without it.

- [x] **L4. Firestore backups - daily snapshots live 2026-09-09.**
      Relay held other businesses' customer lists with no recovery path at all.

      Firebase's own answer - scheduled backups and point-in-time recovery - is
      **Blaze-plan only**, and `relay-portal-68417` is on Spark. The Disaster
      Recovery tab says so outright: "Upgrade your plan to edit point-in-time
      recovery and scheduled backups." Managed export/import is Blaze too. So
      the checklist item as written could not be completed by clicking
      anything; it needed either a billing decision or code.

      Shipped the code, because a gap this size should not wait on a decision:
      `functions/firestore-backup.mjs`, scheduled daily 07:00 UTC (03:00 ET,
      deliberately an hour before oauth-refresh-sweep so the snapshot predates
      the day's writes). It walks every collection AND subcollection via
      `listCollections()` - nothing is hardcoded, so a new collection is backed
      up without a code change - and stores a type-preserving JSON snapshot in
      Netlify Blobs (store `firestore-backups`, key `YYYY-MM-DD.json`).
      Retention: every day for 30 days, plus first-of-month for 12 months,
      because a bug that has been quietly corrupting one field for six weeks is
      not recoverable from a window of dailies that are all already wrong.

      Two refusals worth knowing about: it will not store a snapshot containing
      zero documents (that means the credentials are pointed somewhere
      unexpected, and overwriting a good backup with an empty one turns a
      config mistake into data loss), and it reads the blob back after writing
      and fails if the byte count differs. Pruning only happens after that
      read-back succeeds. A failure alerts by SMS as well as Sentry - a backup
      failing silently is the same as having no backup.

      The restore half exists too, which is the half that usually does not:
      `scripts/firestore-restore.mjs`, wired to `npm run backup:list`,
      `backup:pull` and `backup:restore`. A restore is a DRY RUN unless
      `--confirm`, merges rather than replaces by default, and only deletes
      with both `--confirm` and `--purge`.

      Verified: 40 assertions (`npm run test:backup`) covering Timestamp,
      GeoPoint, Buffer, nested and in-array type round-trips; that a plain
      `{latitude, longitude}` map does NOT become a GeoPoint; that user data
      containing a literal `__type` key survives; subcollection discovery at
      two levels; the doc ceiling aborting rather than storing a partial
      snapshot; and every retention boundary. Also confirmed `@netlify/blobs`
      bundles and imports cleanly under esbuild, given the Twilio SDK history.

      STILL WORTH DOING, and it is Clyde's call because it needs a card on the
      Firebase project: upgrading to Blaze buys Google-operated, transactionally
      consistent backups plus point-in-time recovery to any minute in the last
      7 days. This snapshot is not point-in-time consistent - it walks document
      by document, so a write landing mid-walk can be caught on one side of a
      relationship and not the other. At this database's size the walk is
      seconds, and it is enormously better than nothing, but do not describe it
      as equivalent. It stays useful after a Blaze upgrade as an offsite second
      copy in a different vendor's storage.

- [x] **L5. Plan document limits enforced on both paths - 2026-09-08.**
      `docLimit()` lived only in app.js, so the limit existed exactly where it
      could not be enforced. Nothing on the SMS path read or incremented
      docCounts, so for a contractor working the way Relay is designed to be
      worked - by text - the usage meter never moved at all. `docLimit()` also
      returned 500 for BOTH Essential and Pro, making the two paid tiers
      identical.

      Now: **Pro 500, Essential (and anything else) 250, admin unlimited** -
      the two tables live in app.js and twilio-sms.mjs and MUST be kept
      identical; there is a check for this in the commit that introduced them.
      twilio-sms does a cheap read before the Anthropic call (so an over-limit
      contractor costs no AI request) and a transactional reservation at
      creation time. The portal's increment is a transaction too - it was a
      read-then-write, so two tabs could both read 249 and both write 250. A
      counter failure lets the job through and alerts rather than dropping a
      contractor's work.

      Isolation verified with 14 assertions: the counter is
      `users/{uid}/docCounts/{YYYY-MM}`, the SMS path derives that uid from the
      sender phone lookup rather than any request field, both paths read the
      limit from that user's own plan, and the rules allow read/write to the
      owner only, forbid moving a count backwards, require a new month to start
      at 1, and forbid deletion.

      The cut-off is visible on both paths: the New Job screen replaces the
      whole form with an upgrade panel at the limit, and a text gets a reply
      naming the limit and the reset date.

      Known gap: the portal path is still enforced in the browser. The rules
      stop a client resetting its own counter, but a determined user could
      create an invoice document directly and skip the increment. Closing that
      needs the portal to create documents through a function.

- [x] **L15. REGRESSION FIX: Firestore rules locked every user out.**
      The rules deployed earlier in this session covered users, invoices, jobs,
      dispatch, customers and oauth_tokens but not docCounts or publicDocs, and
      rules do not inherit. Consequences: every signed-in user was sent to the
      locked screen (denied docCounts read rejected loadUserData's whole
      Promise.all, catch fell back to plan:'unpaid'); creating a document failed
      (publicDocs write denied); and every share link in doc.html failed
      (publicDocs read denied). Rules for both added and published; verified on
      a fresh console load. `publicDocs` now carries a `uid` stamp so writes are
      owner-scoped while reads stay public, which share links require.
      `loadUserData()` switched to `Promise.allSettled` so one failing read can
      never blank a whole profile again - only the profile read is treated as
      load-bearing.

- [x] **L16. Business phone capture, the identity for every inbound text.**
      Signup wrote `phone`; twilio-sms and oauth-refresh-sweep read
      `phoneNumber`, a field app.js never wrote. Every portal signup was unable
      to text in. Fixed: signup and profile both write phoneNumber (E.164) and
      phoneDigits (last 10); the profile gains a required "Your business phone
      number" field that rejects unusable input rather than saving junk that
      silently never matches; the SMS lookup queries phoneDigits first, so
      formatting cannot break it, with the old exact-string queries kept as
      fallbacks for legacy documents; a dashboard banner appears when the number
      is missing, because otherwise the failure is only discoverable by texting
      from a roof and getting "not registered"; and existing accounts holding
      only `phone` are silently backfilled on next load rather than being asked
      to re-enter it. Verified: frontend and backend normalisation agree across
      7 input formats and reject 3 invalid ones.

- [x] **L17. Service worker was hiding every frontend deploy.**
      Cache-first with a hardcoded cache name meant returning users kept the
      first `app.js` they ever cached. Every frontend change made in this
      session - the consent dropdown, the reordered Add Customer form, the
      mojibake repair, the customer detail screen, the business phone field -
      was live on the server and invisible in the browser. Now network-first
      for code, cache-first only for static media. `sw.js` is served
      `Cache-Control: no-cache`, verified against the live server, so the new
      worker reaches existing clients.

- [x] **L18. SMS invoices showed as "Unknown" and could not be opened.**
      Field-name mismatch between the two writers of the invoices collection,
      plus there was no invoice detail screen at all. twilio-sms now writes both
      vocabularies; the frontend reads through fallback accessors so documents
      already in Firestore render correctly without a backfill; invoice rows
      open a detail screen showing amount, status, work performed, customer,
      job details, the original text message, a shareable link and Mark as Paid.
      A held document explains itself there rather than only carrying a badge.
      Verified by rendering the screen against the real invoice created by the
      first live SMS test.

- [x] **L19. Reconnecting an accounting integration always failed.**
      Zoho returns a refresh token only on first authorization, so every
      reconnect hit encrypt(undefined) and 500'd with "Internal server error".
      Any contractor whose token was revoked - the exact situation the reconnect
      flow exists for - could never recover, and the message gave them nothing
      to act on. Four layers fixed: prompt=consent on the authorize URL so Zoho
      always issues one; oauth-token preserves the stored refresh token if a
      provider omits it, rather than destroying a working connection; a missing
      access token or a truly absent refresh token now returns a specific,
      actionable 502 that the callback page already displays; and encrypt()
      rejects empty input naming the real cause instead of throwing a crypto
      error. Provider responses are also checked for an error body, since Zoho
      answers 200 on failures like an expired code. Verified across 5
      provider/reconnect permutations.

### Tier 2 - before roughly the tenth customer.

- [x] **L6. Validate the model's parsed output before it becomes a document.**
      `parsed.amount` went straight onto the invoice with no type or range check,
      so one bad parse could bill a customer $999,999 under the CONTRACTOR'S name
      - their relationship, not ours. `functions/lib/parse-guard.mjs` now coerces
      what is usable ("$1,250.00", "250"), zeroes what is not, normalises phone
      to E.164, validates email, clamps the description, constrains job_type, and
      unwraps markdown-fenced JSON. Amounts over $50k or confidence under 0.4 save
      as status 'needs_review' and are NOT auto-forwarded to the customer; over
      $10M is refused outright with a plain-English retry message. 32 assertions
      passing. Frontend renders the new status with a Needs Review badge and
      filter chip.

- [x] **L7. Onboarding checklist - 2026-09-09.**
      An account needs a phone number, an active plan, an accounting connection
      and (on Pro) a review URL. Miss any one and the product half-works
      SILENTLY, which is how a trial dies without anyone complaining.
      `onboardingSteps()` computes the four, the dashboard shows a progress card
      above everything else, and each step is tappable straight to where it is
      fixed. The card disappears permanently once every step is done, so an
      established account never sees it.
      Each step states what BREAKS if skipped rather than just naming a task -
      a checklist of chores gets ignored, a checklist of consequences gets done.
      The review step only appears for Pro, since it is a Pro feature.
      `trialing` counts as an active plan; `past_due` does not; an
      accountingProvider of 'none' does not count as connected.
      12 assertions. The separate phone banner stays: it is the one failure a
      contractor hits from a roof, and it earns the duplication.

- [ ] **L8. Lawyer review of the Terms.**
      Specifically whether Relay is positioned as sender or conduit, and whether
      the indemnity survives an actual plaintiff. TCPA statutory damages run
      $500-$1,500 per message. The consent system is the real defence; the
      paperwork should match it.
      Assume Relay is the SENDER, not a conduit: messages leave our number,
      under our branding, at our system's initiative. The Terms saying the
      contractor is "sender of record" is our contract with them, not the law's
      view, and a contractor with $12k in the bank cannot indemnify a $500k
      claim - indemnification transfers cost, never exposure.
      The engineering half is DONE (L20 below); this is the paperwork half.

- [ ] **L9. E&O and general liability insurance.**
      Sending texts on other businesses' behalf and holding their customers'
      data is the risk category that ends a solo company.
      **Ask explicitly for a TCPA/privacy endorsement** - many E&O policies
      exclude TCPA claims by default, which would make the policy worthless for
      the single largest exposure this business has.

- [x] **L20. TCPA engineering controls - 2026-09-09.**
      Four gaps closed. (1) STOP lived only inside Twilio, so Relay's own data
      still believed an opted-out consumer was textable and a contractor could
      re-add the customer record and text them again. `lib/suppression.mjs`
      keeps a top-level `smsSuppressions` collection, Admin-SDK only, captured
      from an inbound STOP (handled BEFORE the contractor lookup, because the
      person opting out is usually not one of our accounts) and from Twilio
      error 21610. Fails closed. (2) Quiet hours: no customer message before
      8am or after 9pm in the RECIPIENT'S local time, inferred from area code,
      falling back to Eastern because Eastern hits 9pm first. A block is a "not
      yet" - review-request runs hourly and sends in the morning. (3) Both are
      enforced inside `canTextCustomer()`, the single gate every customer-facing
      message already passes, not at each call site. (4) Review follow-up now
      carries consumer-granted consent - see the Landmines entry.
      Verified with 76 assertions across the three libraries.
      Still open on the paperwork side: L8 and L9.

- [x] **L10. Deliverability monitoring - delivery-status webhook live.**
      `sms-status.mjs` receives Twilio's status callbacks, validates
      X-Twilio-Signature the same way twilio-sms does, and logs failures at
      ERROR level with the code and a plain-English cause (30032 unverified
      toll-free, 30007 carrier spam filter, 21610 recipient replied STOP, and
      others). Proven against the real case: the reply to +17137025744 came
      back undelivered with 30032.
      Still outstanding: audit that STOP propagates into Firestore rather than
      living only in Twilio.

### Tier 3 - professional polish.

- [ ] **L11. Make support@portal-relay.com actually route somewhere.**
      It is published in the Terms and Privacy pages.

- [ ] **L12. Customer data export.**
      "What happens to my customer list if I leave?" comes up in the first sales
      conversation. Having an answer converts.

- [x] **L13. Email domain mismatch resolved - 2026-09-09.**
      Every address the product ships is now `support@portal-relay.com`, matching
      the site domain. The package.json author fields moved off
      @support-relayai.com earlier the same day; a full scan then found one
      survivor in LICENSE, now aligned. Verified: zero occurrences of
      support-relayai anywhere outside this checklist entry.
      What remains is EXTERNAL, not code: if @support-relayai.com is still the
      business email on the Twilio submission, the Stripe account or the LLC
      paperwork, those should be moved too - a contact domain that does not match
      the site is a flag on a toll-free review. Nothing in the repo depends on it.
      NOTE: `support@portal-relay.com` is published in Terms and Privacy and
      still routes nowhere. That is L11, and it is now the only email gap left.

- [ ] **L14. Archive the unused $59 Essential+ price in Stripe.**
      No payment link and no subscriptions reference it. Cosmetic.

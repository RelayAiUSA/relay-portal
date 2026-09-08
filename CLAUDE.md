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

## Status — last updated 2026-09-08

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
Six functions: twilio-sms, oauth-token, oauth-refresh-sweep, review-request,
stripe-webhook, sms-status. Scheduled: `review-request` hourly,
`oauth-refresh-sweep` daily 08:00 UTC.

**Netlify env vars** — scope matters. `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`,
`FIREBASE_PROJECT_ID`, `INTUIT_CLIENT_ID`, `QUICKBOOKS_CLIENT_ID`, `QB_CLIENT_ID`
are Functions-scope. Everything else is builds+functions+runtime. Function env
vars are **baked in at deploy time**: adding or changing one does nothing until
the site is rebuilt. `SECRETS_SCAN_OMIT_KEYS=TWILIO_FROM_NUMBER`.
Note: `ZOHO_CLIENT_SECRET` and `STRIPE_WEBHOOK_SECRET` are NOT flagged
`is_secret`, so their values are readable in the Netlify UI — worth toggling on.

**Firebase** — project `relay-portal-68417` (console under c.pryor006@gmail.com).
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

- [ ] **L4. Enable Firestore backups.**
      Holding other businesses' customer lists with no recovery path.

- [ ] **L5. Enforce plan document limits server-side.**
      `docLimit()` exists only in app.js. No function checks usage, so the SMS
      path ignores plan limits entirely. Partially advanced: the docCounts
      security rule now constrains writes so the counter can only move forward
      (new month starts at 1, existing month increments by exactly 1), closing
      the reset-to-zero bypass. Still outstanding: twilio-sms does not check or
      increment the counter at all, so SMS-created documents are uncounted.

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

- [ ] **L7. Onboarding checklist in the app.**
      An account needs phone number, active plan, accounting connection and
      review URL. Miss one and the product silently half-works. Show progress and
      block dispatch until the phone number is verified.

- [ ] **L8. Lawyer review of the Terms.**
      Specifically whether Relay is positioned as sender or conduit, and whether
      the indemnity survives an actual plaintiff. TCPA statutory damages run
      $500-$1,500 per message. The consent system is the real defence; the
      paperwork should match it.

- [ ] **L9. E&O and general liability insurance.**
      Sending texts on other businesses' behalf and holding their customers'
      data is the risk category that ends a solo company.

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

- [ ] **L13. Resolve the email domain mismatch.**
      Contact address is @support-relayai.com while the site is portal-relay.com.
      A small credibility tax on every touchpoint, and Twilio flags it.

- [ ] **L14. Archive the unused $59 Essential+ price in Stripe.**
      No payment link and no subscriptions reference it. Cosmetic.

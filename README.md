# WorkBridge

Recruitment and visa-processing platform for skilled workers. One Node/Express
service provides the REST API and serves the browser frontend.

Four roles share the platform:

| Role | Can do |
|---|---|
| **Worker / candidate** | Browse and filter local and overseas listings, see why a listing matched, apply, track applications, follow seven visa milestones, upload and download their own documents, read the salary guide, use the assistant, manage their profile and language |
| **Employer** | Create, edit, publish and close **their own** listings, see the risk check on each one, review applicants with explainable match reasons, shortlist, schedule interviews, issue offers, reject |
| **Recruitment consultancy** | Open a visa case from an application that has an issued offer, record milestone updates with a timestamp and the responsible user, review and verify documents for **assigned** candidates only |
| **Administrator** | Platform metrics, the listing review queue with the reasons behind every risk score, suspend/clear/remove listings, manage account status and verification, create other administrators, read the audit log |

---

## Quick start

```bash
npm ci
cp .env.example .env          # then edit it; see "Configuration"
npm start                     # http://localhost:5000
```

On first boot with `SEED_DEMO_DATA=true` the server creates the runtime database
and seeds a small demo dataset. The demo account emails are printed to the
console. Their shared password is whatever you set in `DEMO_PASSWORD`; if you
leave it empty, a random one is generated and printed **once** at that first
boot.

```
worker@demo.workbridge.local       (Worker, interface language Tamil)
worker2@demo.workbridge.local      (Worker)
employer@demo.workbridge.local     (Employer)
consultancy@demo.workbridge.local  (Consultancy)
admin@demo.workbridge.local        (Admin)
```

Demo data is development/test data. It contains no real person, employer,
licence number or verification claim, every demo account is flagged `demo: true`
in the database, and the emails use the non-routable `.workbridge.local` domain.
**Run a public deployment with `SEED_DEMO_DATA=false`.**

### Commands

| Command | What it does |
|---|---|
| `npm start` | Production start (`node server.js`) |
| `npm run dev` | Development start with file watching |
| `npm test` | Full API, authorisation, data-integrity, i18n and static-frontend suite (`node --test`) |
| `npm run lint` | ESLint over backend, frontend and tests |
| `npm run build` | Build validation: parses every file, loads every backend module, checks locale parity, asset references and env documentation |
| `npm run health` | Probes `/health` on a running instance and exits non-zero unless healthy |
| `npm run verify:api` | Signs in as the demo accounts and exercises every documented endpoint over the cookie transport, including the CSRF path (needs a running instance seeded with demo data) |
| `npm run verify:browser` | Drives the four role journeys plus the Tamil workflow through a real headless Chrome/Edge (needs a local browser; not part of `npm test`) |

---

## Configuration

Every variable lives in `.env.example` with a comment. The ones that matter most:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `5000` | The server binds the platform-provided port; falls back to 5000 locally |
| `NODE_ENV` | `development` | `production` enables HSTS and secure cookies, and **requires** `SESSION_SECRET` |
| `SESSION_SECRET` | *(generated in dev)* | Required in production. Sessions are keyed by an HMAC of this value, so changing it signs everyone out. `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `SESSION_ABSOLUTE_HOURS` | `168` | Hard session lifetime |
| `SESSION_IDLE_HOURS` | `12` | Idle timeout |
| `BCRYPT_ROUNDS` | `12` | Password hashing cost |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_LOCK_MINUTES` | `8` / `15` | Per-account lockout |
| `DATA_DIR` | `./backend/data` | Where the JSON database lives. **Point at a persistent disk in production** |
| `UPLOAD_DIR` | `./uploads` | Where uploaded documents land. **Same** |
| `MAX_UPLOAD_MB` | `5` | Per-file upload ceiling |
| `SEED_DEMO_DATA` | `true` in dev, `false` in production | Seeds demo data on first boot only |
| `DEMO_PASSWORD` | *(generated)* | Shared password for demo accounts. Ignored unless demo seeding runs |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | — | Provisions the first administrator on boot if no account with that email exists |
| `CORS_ORIGINS` | *(empty)* | Comma-separated allow-list. Empty means same-origin only, which is correct when this server also serves the frontend |
| `AI_PROVIDER` | `none` | `anthropic` for live model replies, `none` for the deterministic knowledge base |
| `ANTHROPIC_API_KEY` | — | Server-side only. Never reaches the browser |
| `AI_MODEL` | `claude-opus-5-5` | |
| `AI_MAX_TOKENS` / `AI_EFFORT` | `1024` / `low` | Chat replies are short by design |
| `AI_RATE_WINDOW_MINUTES` / `AI_RATE_MAX` | `5` / `20` | Per-user assistant rate limit |

`.env` is git-ignored. No secret is committed; `.env.example` contains no real
credentials.

---

## Authentication and authorisation

### How a session works

1. `POST /api/auth/register` or `POST /api/auth/login` verifies credentials and
   creates a **new** session row. Nothing issued before authentication is
   honoured, which is what closes session fixation.
2. The response sets two cookies and also returns the token in the body:
   - `wb_session` — `httpOnly`, `SameSite=Lax`, `Secure` in production. The
     browser app never reads or stores it, so XSS cannot exfiltrate it.
   - `wb_csrf` — readable by the page, echoed back in an `X-CSRF-Token` header.
3. Mutating requests authenticated **by cookie** must carry a matching
   `X-CSRF-Token`, or they are rejected with `403 CSRF_TOKEN_INVALID`.
   Requests authenticated by `Authorization: Bearer <token>` need no CSRF
   header, because a bearer token is not attached automatically by the browser.
4. Session rows store an HMAC of the token, never the token itself, so a
   database leak does not hand over live sessions.
5. Sessions expire on an absolute lifetime and an idle timeout. Changing a
   password revokes every other session; suspending an account revokes all of
   its sessions immediately.

### Password handling

Hashed with bcrypt (cost 12 by default). Minimum 10 characters with at least one
letter and one digit. No endpoint ever returns a hash, and the login response is
identical for an unknown account and a wrong password, so the endpoint cannot be
used to enumerate users.

### Roles

Public signup accepts `Worker`, `Employer` and `Consultancy` only. `Admin` is
not on the allow-list, so no request body can create an administrator — the
request is rejected rather than quietly downgraded. Administrators come from
`ADMIN_EMAIL`/`ADMIN_PASSWORD` at boot, or from `POST /api/admin/users/admin`
performed by an existing administrator.

A client cannot change its own `role` or `status`: `PATCH /api/auth/me` ignores
both. An employer cannot set its own `verificationStatus`.

### How each role is protected

Authorisation is enforced on the server for every protected route, never by
hiding a button:

- `requireAuth` → `401 AUTH_REQUIRED` (or `SESSION_EXPIRED`) when anonymous.
- `requireRole(...)` → `403 FORBIDDEN_ROLE` when the role is wrong. Every route
  in `backend/routes/admin.routes.js` is behind `requireRole('Admin')`.
- Ownership rules live in one place, `backend/lib/rbac.js`, and answer "is this
  mine?" for jobs, applications, visa cases and documents. Changing an id in a
  URL returns `403 FORBIDDEN_RESOURCE` (or `404` where confirming existence
  would itself leak information, as with a suspended listing).
- Workflow stages are permissioned *and* sequenced: `STAGE_PERMISSIONS` says
  which role may set a stage, and a transition table rejects illegal moves with
  `409 STAGE_TRANSITION_INVALID`.
- Document visibility: owners always; administrators always; the **assigned**
  consultancy sees a candidate's non-sensitive documents only. Documents of type
  `medical` are marked sensitive and stay with the owner and administrators.
  Employers never receive document files — only verification counts.
- Nobody can verify their own document (`403 CANNOT_VERIFY_OWN_DOCUMENT`).

### Password reset — partially implemented

`POST /api/auth/forgot-password` creates a reset token, stores a SHA-256 hash of
it with a 30-minute expiry, and writes an audit entry.
`POST /api/auth/reset-password` consumes it and revokes every session.

**The delivery step is not configured.** No email or SMS provider is wired up,
so the response reports `delivery: "not_configured"` and the token is *not*
returned over HTTP — returning it would let anyone reset any account. To finish
the flow, add a provider and send the token in a link from
`auth.routes.js → /forgot-password`. Until then the endpoint is honest about
being incomplete rather than pretending to send mail.

---

## Tamil language support

Tamil (தமிழ்) is a first-class interface language alongside English.

- All user-facing text comes from `public/locales/en.json` and
  `public/locales/ta.json`. There are no inline language conditionals in the
  views: they call `t('key')`.
- 499 keys, with full parity enforced by `npm run build` and by
  `tests/i18n.test.js`, which also fails if a Tamil value is still the English
  string, if a value contains no Tamil script, or if interpolation placeholders
  differ between bundles.
- Server responses carry machine-readable error **codes**; the frontend
  translates them, so no error sentence is hard-coded on the server and every
  code has an English and a Tamil message.
- A language toggle (**English | தமிழ்**) sits in the landing header, both
  authentication screens, the worker header and the sidebar footer.
- The choice persists in `localStorage` for the device *and* on the account
  (`PATCH /api/auth/me { language }`), so it survives navigation, reload, a new
  sign-in and a new device. Missing keys fall back to English, then to the key.
- Tamil renders with a Noto Sans Tamil font stack, with per-language line-height
  and heading sizes so Tamil text does not break the layout.
- The assistant replies in the language you are using: an explicit `lang` wins,
  otherwise Tamil script in the question selects Tamil, otherwise the account's
  saved preference applies. Mixed Tamil-English questions are matched too.
- Interface translation never touches user-generated content: employer listing
  text and document contents are stored and returned byte-for-byte.

Adding a third language means adding one locale file and one entry in
`SUPPORTED` in `public/i18n.js`.

---

## The WorkBridge AI assistant

Available as a floating panel on every signed-in page and as a full page at
`#/assistant`. It covers finding jobs and eligibility, application procedure,
visa stages and document requirements, destination countries, indicative trade
salaries, avoiding recruitment fraud, and how to use the platform.

**Two modes, and the interface always says which one answered:**

- `AI_PROVIDER=anthropic` with `ANTHROPIC_API_KEY` set → **live**. The request
  is assembled server-side from the knowledge base plus real figures read from
  the database (published listing counts by country and trade, the salary
  reference table, and the caller's *own* application and visa stages). The
  system prompt forbids inventing listings, salaries, legal requirements,
  processing times, approvals or anyone's status, requires that figures be
  labelled indicative, and forbids claiming anything is "verified".
- `AI_PROVIDER=none`, or any provider failure, refusal or empty response →
  **fallback**. Answers come from the bilingual knowledge base in
  `backend/lib/knowledge.js`, and the panel says so in plain language. A
  provider error is never surfaced as a fabricated answer.

Other properties: conversations are stored per user id and isolated between
accounts; a per-user sliding-window rate limit applies; messages are length
validated; the key never reaches the browser and never appears in a response;
and passwords, tokens and document files are never included in the context sent
to the model.

**This deployment ships with `AI_PROVIDER=none`.** No API key was available
while this was built, so the live path was verified against a stubbed SDK
(`tests/ai-live-path.test.js`) rather than the real API — see "Outstanding".

---

## Fraud and trust

`backend/lib/fraud.js` scores every listing server-side, from the stored
content, on create and on edit. A `riskScore`, `risk`, `verified` or
`reviewState` value in a request body is ignored.

Each point added carries a reason code, a weight and a sentence explaining it,
so a reviewer sees *why* a listing scored what it did. Signals include: a salary
far outside the indicative band for that trade and destination, a currency that
does not match the destination, text asking the worker for a fee or deposit,
off-platform contact details, a generic or missing company name, an unverified
or very new employer account, a thin description or missing requirements, an
overseas role without visa sponsorship, and an implausible vacancy count.

- Score ≥ 60 holds the listing at `under_review`; it is never shown in the
  public list until an administrator acts. Editing a published listing into that
  range pulls it back.
- Any signed-in user can report a listing; three reports move a published
  listing to review.
- Administrators clear, suspend or remove a listing. **A reason is mandatory**
  and every decision is written to the audit log with the actor, the target, the
  previous status and the score at the time.
- A score is an indicator that routes a listing to human review, not proof of
  fraud. Both the API response and the UI say so.
- Nothing is called "verified" without evidence. `employerVerified` reflects an
  administrator's decision on the employer account, which requires an
  `evidenceReference`; employers cannot set it. Listings themselves are never
  labelled verified.

Match scores are explainable too: `backend/lib/matching.js` compares profile and
listing fields and returns the reasons and weights behind the number. (The
previous implementation used `Math.random()`.)

---

## Database and persistence

The store is a single JSON document at `${DATA_DIR}/workbridge.json`, managed by
`backend/lib/store.js`:

- One authoritative in-memory copy; **every** mutation goes through a serialized
  promise chain and is flushed with an atomic write (temp file + rename) before
  the HTTP response returns. Overlapping requests can no longer lose each
  other's writes, which the previous read-modify-write implementation did.
- Monotonic per-collection id counters; a deleted id is never reused.
- A corrupt file is moved aside with a timestamped name and the server refuses
  to start, rather than silently continuing from an empty database.
- The runtime database is separate from the seed definition
  (`backend/seed/demo.js`) and is git-ignored.

**Known limitation:** this safety is per Node process. Running more than one
instance against the same file (cluster mode, several containers, a scaled web
service) would reintroduce lost updates. For a multi-instance deployment,
migrate to PostgreSQL: the data access is already funnelled through
`store.read()` / `store.mutate()` plus the helpers in `rbac.js`, so the
collections map onto tables one-to-one.

**Uploads do not survive an ephemeral filesystem.** Container and
platform-managed filesystems are wiped on redeploy, so `UPLOAD_DIR` must point
at a mounted disk or object storage. The download endpoint reports
`410 DOCUMENT_FILE_GONE` and says why, instead of a generic error, when a record
exists but its file has been wiped.

---

## HTTP API

All endpoints are under `/api`. Errors share one shape:

```json
{ "success": false, "error": "MACHINE_CODE", "message": "...", "details": { } }
```

Authentication column: **–** public, **✓** any signed-in user, or the roles
allowed.

### Auth

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/auth/register` | – | `name`, `email` and/or `phone`, `password`, `role` (Worker/Employer/Consultancy), `language`, `profile`. Rate limited |
| POST | `/api/auth/login` | – | `identifier` (email or mobile) + `password`. Rate limited, per-account lockout |
| POST | `/api/auth/logout` | ✓ | Revokes the current session |
| GET | `/api/auth/me` | ✓ | Current user + CSRF token |
| PATCH | `/api/auth/me` | ✓ | `name`, `email`, `phone`, `language`, `profile`. `role`/`status` ignored |
| POST | `/api/auth/change-password` | ✓ | Revokes other sessions, issues a new one |
| POST | `/api/auth/forgot-password` | – | Delivery not configured (see above) |
| POST | `/api/auth/reset-password` | – | `token` + `newPassword` |

### Jobs

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/jobs` | – | `search`, `category`, `type`, `country`, `page`, `pageSize`, `scope=mine`. Public results are published listings only |
| GET | `/api/jobs/:id` | – | Risk details only for the owner/admin; hidden listings return 404 |
| POST | `/api/jobs` | Employer, Admin | Server computes the risk score; may return `heldForReview: true` |
| PATCH | `/api/jobs/:id` | owner Employer, Admin | Re-runs the risk check |
| DELETE | `/api/jobs/:id` | owner Employer, Admin | Closes instead of deleting when live applications exist |
| POST | `/api/jobs/:id/report` | ✓ | `reason` required |
| GET | `/api/jobs/:id/applicants` | owner Employer, Admin | Match reasons + document counts, never files |

### Applications

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/applications` | ✓ | Scoped to what the caller may see. `status`, `jobId`, paging |
| GET | `/api/applications/:id` | party to it | |
| POST | `/api/applications` | Worker | `jobId`; worker taken from the session. Duplicate → `409 ALREADY_APPLIED` |
| PATCH | `/api/applications/:id` | per stage | Role-permissioned and transition-validated |
| POST | `/api/applications/:id/interview` | owner Employer, Admin | Future `scheduledAt` required |

### Visa

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/visa/my-status` | Worker | The caller's own case; `null` when none |
| GET | `/api/visa/cases` | ✓ | Only cases the caller is a party to |
| GET | `/api/visa/cases/:id` | party to it | Documents filtered per visibility; restricted ones counted only |
| POST | `/api/visa/cases` | Consultancy, Admin | From an application at `Offer Issued` |
| PATCH | `/api/visa/stages` | assigned Consultancy, Admin | `caseId`, `stageName`, `status`, `note`. Sequential; records who and when |

### Documents

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/documents` | ✓ | Visibility-filtered; `ownerId` honoured only where allowed |
| POST | `/api/documents/upload` | Worker, Admin | multipart `file` + `name` + `type`. PDF/JPEG/PNG/WebP, size capped |
| GET | `/api/documents/:id/file` | per visibility | Streams the file; access is audited |
| PATCH | `/api/documents/:id` | Consultancy (assigned), Admin | Verify or reject; rejection needs a reason |
| DELETE | `/api/documents/:id` | owner, Admin | A verified document is locked |

### Assistant

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/ai/chat` | ✓ | This user's history, provider mode, suggestions |
| POST | `/api/ai/chat` | ✓ | `message`, optional `lang`. Returns `mode`, `model`, `providerNote`, `sources` |
| DELETE | `/api/ai/chat` | ✓ | Clears the caller's conversation |
| GET | `/api/ai/suggestions` | – | `lang=en|ta` |

### Admin

| Method | Path | Notes |
|---|---|---|
| GET | `/api/admin/stats` | Counts computed from stored records; wage figures labelled indicative |
| GET | `/api/admin/fraud-queue` | Flagged/reported listings with full factor lists |
| POST | `/api/admin/fraud-action` | `id`, `action` (clear/suspend/remove), `reason` required |
| POST | `/api/admin/jobs/:id/reassess` | Recompute the score |
| GET | `/api/admin/jobs` | All listings with applicant counts |
| GET | `/api/admin/users` | `role`, `search` |
| PATCH | `/api/admin/users/:id/status` | Suspend/reactivate; reason required |
| PATCH | `/api/admin/users/:id/verification` | Evidence reference required to verify |
| POST | `/api/admin/users/admin` | Create another administrator |
| GET | `/api/admin/audit-log` | `limit`, `action` |

All administrator routes require the `Admin` role.

### Other

`GET /api/salary-guide` (public, indicative), `GET /api/meta` (public reference
data for forms), `GET /api/messages`, `POST /api/messages`,
`PATCH /api/messages/:id/read`, `GET /api/notifications`,
`GET /api/consultancy/cases`, `GET /api/my-activity`.

### Health

`GET /health` checks real dependencies and returns **503** when the datastore is
unusable. A read-only upload directory reports `degraded` with a 200, because
browsing and authentication still work.

```json
{
  "status": "healthy",
  "checks": {
    "database": { "ok": true, "file": "…" },
    "uploads":  { "ok": true },
    "aiAssistant": { "mode": "fallback", "provider": null, "model": null }
  }
}
```

---

## Security posture

- bcrypt password hashing; server-side sessions with HMAC-stored tokens;
  httpOnly session cookie plus double-submit CSRF.
- Brute-force protection: per-account lockout plus IP rate limits on
  login/signup, a global API limit and a per-user assistant limit.
- Only `public/` is served. Backend source, the runtime database, uploads and
  `.env` are not reachable over HTTP. (Previously the whole project directory
  was served, which exposed `/.env` and `/backend/data/db.json`.)
- Strict `script-src 'self'` CSP — the frontend uses delegated event handlers
  and contains no inline handlers — plus `frame-ancestors 'none'`, HSTS in
  production, and the other `helmet` defaults.
- CORS is closed by default; cross-origin callers must be listed in
  `CORS_ORIGINS`.
- All input is validated and bounded (types, lengths, enums, body size limits).
  Uploads are type- and size-checked and stored under a generated filename, so
  a client-supplied name can never traverse the filesystem.
- Errors return a code and a generic message with a request id; stack traces and
  internal messages are logged server-side only.
- Audit log for authentication, workflow and every administrative action.

---

## Deployment

The server listens on `process.env.PORT` and falls back to 5000.

**Docker**

```bash
docker build -t workbridge .
docker run -p 5000:5000 \
  -e NODE_ENV=production \
  -e SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")" \
  -e SEED_DEMO_DATA=false \
  -e ADMIN_EMAIL=admin@example.com -e ADMIN_PASSWORD='choose-a-strong-one' \
  -v workbridge-data:/data \
  workbridge
```

The volume is not optional. Without it the database and uploads are destroyed on
every redeploy.

**Render** — `render.yaml` provisions a persistent disk at `/var/data` and
points `DATA_DIR`/`UPLOAD_DIR` at it, generates `SESSION_SECRET`, sets
`healthCheckPath: /health`, and leaves `ADMIN_EMAIL`, `ADMIN_PASSWORD` and
`ANTHROPIC_API_KEY` to be set in the dashboard. A persistent disk needs a paid
instance type; **on the free plan all data is lost on each deploy.**

**Production checklist**

1. `NODE_ENV=production` and a stable `SESSION_SECRET`.
2. `SEED_DEMO_DATA=false`, `DEMO_PASSWORD` unset.
3. `DATA_DIR` and `UPLOAD_DIR` on persistent storage.
4. `ADMIN_EMAIL` / `ADMIN_PASSWORD` set for the first administrator, then
   rotate that password after first sign-in.
5. HTTPS terminated in front of the app (secure cookies assume it).
6. One instance only, until the store is migrated to PostgreSQL.
7. Back up `${DATA_DIR}/workbridge.json` and `UPLOAD_DIR`.

---

## Project layout

```
server.js                  start + graceful shutdown
backend/
  app.js                   express app factory, security headers, /health
  config.js                environment parsing and validation
  bootstrap.js             store init, demo seed, admin provisioning
  lib/
    store.js               serialized atomic JSON store
    auth.js                passwords, sessions, login throttling
    middleware.js          identity, requireAuth/requireRole, CSRF
    rbac.js                ownership and stage permissions
    fraud.js               explainable listing risk
    matching.js            explainable match scoring
    ai.js                  provider abstraction + fallback
    knowledge.js           bilingual knowledge base
    audit.js               audit log
    http.js                response envelope + validators
  routes/                  auth, jobs, applications, visa, documents, ai, admin, misc
  seed/demo.js             controlled demo dataset
public/
  index.html, style.css, components.css
  app.js                   SPA: state, shells, views, router, actions
  i18n.js, ui.js, api.js, assistant.js
  locales/en.json, locales/ta.json
scripts/                   build-check, health-check, browser-journey
tests/                     node:test suites
legacy/                    pre-refactor frontend and JSON db, kept for reference
```

---

## Outstanding

- **Live AI provider not exercised.** No API key was available, so the live path
  is covered by a stubbed SDK only. Set `AI_PROVIDER=anthropic` and
  `ANTHROPIC_API_KEY`, then send one message and confirm the panel header reads
  "Live AI assistant".
- **Password reset delivery** needs an email or SMS provider (above).
- **Single-instance only** until the JSON store is migrated to PostgreSQL.
- **Upload storage** must be a mounted disk or object storage; nothing in the
  code can make an ephemeral filesystem persistent.
- Employer/consultancy verification is a manual administrator decision backed by
  an evidence reference. There is no automated registry integration, and the UI
  does not claim one.

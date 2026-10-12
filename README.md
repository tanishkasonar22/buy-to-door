# Buy to Door

Age-verified ticketing prototype: checkout with a wallet age check, group tickets with guest claim links,
a privacy receipt, a data firewall, a gate page and an operations dashboard. Buyers and guests without a
mobile ID can still get a ticket, and the dashboard exports an audit CSV.

Built for the Credence ID Solution Engineer assignment. Code written with AI assistance (Claude); the deck and pitch are my own.

## Run it (mock mode, no keys needed)

    npm install
    cp .env.example .env        # VERIFIER_MODE=mock is the default
    npm run dev                 # http://localhost:3000
    npm run seed                # optional: fills the dashboard with demo data (server must be running)
    npm test                    # 143 tests
    npx tsc --noEmit

Pages: `/` shop, `/claim.html?t=...` guest claim, `/order.html?o=...` order tracking, `/gate.html`, `/dashboard.html`, `/readiness.html`.

## No mobile ID

Many people (for example in Texas) have no mobile ID. The shop and the guest claim page both have an
"I don't have a mobile ID" button. It issues the ticket straight away, collects no ID data online and
creates no privacy receipt, because nothing about the person was received. The ticket is marked
"ID check at the gate":

- The gate page says the age was not checked online and hides the manager override.
- The server refuses an override on these tickets (`id_check_required`). Staff must check a physical ID
  (recorded as a staff result) or a mobile ID.
- The order page labels these tickets, and the dashboard counts them.

## Audit export

`/dashboard.html` has a "Download audit CSV" link (`GET /api/export/audit.csv`). It has one row per
checkout step, order, ticket, claim and gate scan, oldest first, with ticket and order IDs, times,
methods and results. It never contains names, birth dates, photos, ticket codes, claim links, session
IDs or verification references. Cells that start with `=`, `+`, `-` or `@` are prefixed with `'`, so a
spreadsheet will not run them as formulas.

## Modes

| `VERIFIER_MODE` | Cloud SDK | Wallet answer |
| --- | --- | --- |
| `mock` | not called | simulated |
| `hybrid` | **called for real on every checkout, claim and gate check** | simulated (labelled on screen) |
| `real` | called for real | real wallet response |

Use `hybrid` when you have a Cloud SDK key but no wallet credential. The dashboard shows how many requests were created through the SDK since the server started.

## Run it against the real Cloud SDK (hybrid or real)

1. Create a free Evaluation key at verify.credenceid.com and copy the license key and profile ID.
2. Start an HTTPS tunnel to port 3000 and register that origin (public HTTPS only; localhost and IPs are rejected).
3. In `.env` set `VERIFIER_MODE=hybrid` (or `real` once you have a credential), `CLOUDSDK_LICENSE_KEY`, `CLOUDSDK_PROFILE_ID`, `CLOUDSDK_ORIGIN`, a long random `TICKET_SIGNING_SECRET`, and a `READINESS_TOKEN`.
4. Open `/readiness.html` through the tunnel, enter the token, run the checks, and fix anything marked Fail.
5. Use `DEV_INSPECT=1` once to see which field name your profile returns for the age result, then set `AGE_CLAIM_KEY`.
6. On an iPhone, open the tunnel address in Safari 17.4+ (iOS 17.4+). Only flow A (Apple Wallet) is built here.

## What is real and what is simulated

| Part | Status |
| --- | --- |
| Tickets, group orders, claim links, race handling, privacy receipt, firewall, dashboard | Real, covered by tests |
| No-mobile-ID tickets and the audit CSV | Real, covered by tests |
| Wallet consent and response in mock mode | Simulated, labelled on screen |
| Cloud SDK setup and request creation (hybrid and real modes) | Real code, tested against a fake SDK; not run against the live service from my build environment |
| Apple Wallet response verification | Written to the documented flow, not yet run with a real credential |
| Physical ID check at the gate | Done in Credence ID's Tap2iD Mobile app; staff record the result, labelled "staff-recorded" |
| Tap2iD SDK | Not integrated |

## Not verified yet

- The real Cloud SDK path end to end.
- The age field name for your profile (`AGE_CLAIM_KEY`).
- Whether a request can be created without a credential present.


In the project folder, run npm run dev.
In a second tab, run ngrok http --url=joyride-contently-scapegoat.ngrok-free.dev 3000.
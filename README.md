# Buy to Door

**Show your age, not your life.**

Buy to Door is an age-verified ticket shop built on the **Credence Cloud SDK**. A buyer proves they are over 21 from the digital ID in their phone wallet, and the shop learns one thing: **yes or no**. No name, no birth date and no photo is stored.

Designed and built by Tanishka Sonar this week as a prototype on the **Credence Cloud SDK**. AI tools (Claude Code, Anti gravity, Google Gemini) helped me build the project; I reviewed and tested the code with various cases and can explain every part.


---

## What it does

1. The buyer picks a ticket and taps **Verify age**.
2. Their phone wallet opens and shows the single question being asked: *am I over 21?* The buyer approves.
3. Credence checks that the ID is genuine, is on that phone, has not been altered, and is still valid.
4. A strict rule in the shop accepts only a clear **yes** and issues a one-time, signed ticket.
5. The buyer gets a **privacy receipt** listing what the shop kept (one yes) and what it discarded (for example the portrait and issuing authority).

Buyers without a digital ID can choose **"I do not have a mobile ID"**. They get a ticket marked for an ID check at the gate, and no verification data is stored.

## Who sees what

| View | Screen | For |
| --- | --- | --- |
| Buyer | **Shop** | Buying a ticket and verifying age |
| Organiser | **Dashboard** | Verified and refused counts, with no personal details |
| Organiser | **Readiness** | "Setup checks": press **Run checks** to confirm the Credence connection is set up and working |
| Organiser | **Gate** | Staff see whether a buyer's age was already checked online |

The Shop is the buyer's view. Dashboard, Readiness and Gate are organiser views. I combined them in one prototype so the whole flow can be seen in one place. In a real deployment, the organiser screens would sit behind a login.

---

## Quick start (about 10 minutes, no phone needed)

This runs the project in **mock mode**, with a simulated wallet. It needs no Credence license.

**You need:** Node.js 22 or later and npm.
## See the real wallet

The full flow runs on a **real Android wallet** and **real Credence Cloud SDK calls**. It is shown in the demo video: [VIDEO LINK].

**Real mode needs a Credence license tied to a registered web address, so it can't run straight from a clone. The quick start below uses **mock mode** (simulated wallet), so you can try the same flow in minutes. But the app works better with the real id. To run real mode yourself, use your own Credence license and follow [`docs/REAL_WALLET_TEST.md`](docs/REAL_WALLET_TEST.md). I'm also happy to run it live on a call.**

```bash
git clone -b real-wallet https://github.com/tanishkasonar22/buy-to-door.git
cd buy-to-door
npm install
cp .env.example .env        
npm test                   
npm run dev
```

Open **http://localhost:3000** in your browser.

### Try it

| Step | What to do | What you should see |
| --- | --- | --- |
| 1 | On the Shop, choose a ticket and tap **Verify age** | A request is created for the simulated wallet |
| 2 | Open the simulated wallet page and pick **pass** | The wallet shares the over-21 answer |
| 3 | Confirm in the shop | A ticket and a privacy receipt: one yes kept, the rest discarded |
| 4 | Repeat with the **under-age** scenario | The check says no and **no ticket is issued** |
| 5 | Repeat with **decline** | The shop reports the decline and does not confirm |
| 6 | Choose **I do not have a mobile ID** | A ticket marked for a check at the gate |
| 7 | Open **Readiness** and press **Run checks** | The setup checks run and show their results |
| 8 | Open **Dashboard** and **Gate** | Counts with no personal details, and the gate view of each ticket |

---

## Run it with the real Credence Cloud SDK

There are three modes, set with `VERIFIER_MODE` in your local `.env`.

| Mode | Wallet | Credence Cloud SDK | Use it for |
| --- | --- | --- | --- |
| `mock` | Simulated | Simulated | Evaluating the flow, running the tests |
| `hybrid` | Simulated | **Real calls** | A reliable demo of the real verification path |
| `real` | **Real Android wallet** | **Real calls** | The full end-to-end flow |

**For `hybrid` and `real` you need:**
- A Credence license key and a profile ID, from the Credence developer documentation.
- A public HTTPS address registered against your license. The shop sends this address on every Credence call, because the wallet ties its answer to it. A tunnel such as ngrok works for testing.

**For `real` you also need:**
- An Android phone with a current Chrome (tested with Chrome 154).
- A wallet that can answer a request. This project was tested with the open-source Multipaz test wallet (`org.multipaz.testapp`), holding a test driver's license created inside the wallet, because a state mobile ID was not available to me.

Step-by-step instructions are in [`docs/REAL_WALLET_TEST.md`](docs/REAL_WALLET_TEST.md).

### Settings (names only; set values in your own `.env`, which is never committed)

| Setting | Purpose |
| --- | --- |
| `VERIFIER_MODE` | `mock`, `hybrid` or `real` |
| `CLOUDSDK_LICENSE_KEY` | Your Credence license key |
| `CLOUDSDK_PROFILE_ID` | Your Credence profile ID |
| `CLOUDSDK_ORIGIN` | The public HTTPS address registered with your license |
| `DEV_INSPECT` | Developer view of the verdict, with personal values redacted |
| `DC_KEEP_READER_AUTH` | Turns off the reader-signature removal (see below) |
| `DC_KEEP_REQUESTED_ELEMENTS` | Turns off the age-only narrowing of the request |
| `DEMO_ACCEPT_UNLISTED_ISSUER` | Demo-only switch (see below). Off by default |

---

## How the Credence Cloud SDK is used

The server makes four REST calls, all with the registered page address:

| Call | Purpose |
| --- | --- |
| `setup` | Starts a session using the license, profile and registered address, and returns a token |
| `refresh` | Keeps the session alive |
| `getDocRequest` | Returns the request the wallet will show to the buyer |
| `verifyDocRequest` | Checks the wallet's answer and returns a verdict |

The verdict says whether the signatures are valid, whether the phone holds the ID, whether the data is intact and in date, and the age answer. A strict gatekeeper in the shop then accepts only a real **true** for "over 21" and denies everything else with a reason code.

**Privacy by design**
- The request is narrowed to a single question: over 21.
- Anything else that comes back (for example the portrait) is discarded before anything is saved.
- Tickets are HMAC-signed and single-use. Claim tokens are stored only as hashes.
- Every decision is written to an audit log with no personal values.
- Stored data: the age answer, a hashed one-time token, and the audit log.

---

## Real wallet: what is proven and what is not finished

**Proven:** a real Android wallet answered a live Credence request end to end. Credence confirmed the signatures, the device and the data integrity, the shop kept nothing personal, and a ticket was issued.

**Three demo shortcuts**, used because the test wallet's ID source is not one Credence already recognises:

1. **Reader signature removed** (applied in real mode). Credence's reader certificate lists its issuer name in a different attribute order from its CA, so the wallet rejects the chain. Turn this off with `DC_KEEP_READER_AUTH`.
2. **Request narrowed to age only** (on by default). The default profile did not request age by itself. Turn this off with `DC_KEEP_REQUESTED_ELEMENTS`.
3. **Unlisted ID source accepted** (**off by default**). Applies only when every other check passes, prints a warning when enabled, and is labelled on the receipt. With it on, the age check could be forged, so never enable it outside a demo.

With a recognised ID source and a corrected reader certificate, the shortcuts are not needed.

### Nine integration hurdles found

Six are solved in the code: an old browser, an empty wallet, a partial request, strict matching, the missing page address, and the age answer arriving as text. Three are handled with the demo shortcuts above and flagged for a production fix: the rejected security certificate, the unlisted ID source, and the age question not being in the profile. The hardest looked like a vague browser "network error" until the phone's own log showed the real cause.

---

## Tests

```bash
npm test
```

266 automated tests in 23 files cover the firewall, the Credence client, request rewriting, the receipts, the gate, the dashboard and the readiness checks, including the cases where the answer must be **no**.

---

## Project map

| Path | Job |
| --- | --- |
| `src/app.ts` | Routes: start, confirm, claim |
| `src/cloudsdk.ts` | Credence client (the four calls) |
| `src/identity.ts` | Verifier modes and age-value normalisation |
| `src/firewall.ts` | The strict decision gate |
| `src/stripReaderAuth.ts`, `src/narrowRequest.ts` | Request rewriting for the real-wallet demo |
| `src/receipt.ts`, `src/audit.ts`, `src/db.ts` | Privacy receipt, audit log, storage |
| `public/` | Browser pages |
| `docs/REAL_WALLET_TEST.md` | Real wallet test steps |
| `tests/` | Automated tests |

---

## Contact

Tanishka Sonar · tanishkanitin357@gmail.com

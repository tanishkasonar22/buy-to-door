# Real wallet test: manual checklist

This test uses the real Credence ID Cloud SDK and a real test credential. Everything below is done by hand.
The code has only been tested against fake SDK responses (see "What could not be verified").

## Before you start

- [ ] An **Android phone** with **Chrome 141 or later**. The Digital Credentials API is needed; Firefox and in-app browsers will not work.
- [ ] The **Multipaz Wallet** app installed on that phone.
- [ ] In Multipaz Wallet, provision the **Driver license (mDL)** credential from **issuer.multipaz.org**.
- [ ] The issuer's **root IACA certificate is already uploaded** in your Credence account (done).
- [ ] Your Credence profile is the **Age Check** profile. It returns only a portrait and an "age over 21" yes/no.
- [ ] ngrok installed and signed in on the computer that runs the server.

## Set up (on the computer)

1. Start the tunnel: `ngrok http 3000`. Copy the `https://….ngrok…` address it prints.
2. Register that exact address (scheme and host, no path, no trailing slash) as an allowed origin for your license
   in the Credence portal. A free ngrok address changes every time ngrok restarts, so register it again each time.
3. Edit `.env` yourself:
   - `VERIFIER_MODE=real`
   - `CLOUDSDK_ORIGIN=` the ngrok address from step 1
   - `DEV_INSPECT=1` for the first run only (see step 9)
   - `AGE_CLAIM_KEY=age_over_21`, or leave it blank; blank also means `age_over_21`
   - Keep your existing `CLOUDSDK_LICENSE_KEY`, `CLOUDSDK_PROFILE_ID`, `TICKET_SIGNING_SECRET` and `READINESS_TOKEN`.
4. Restart the server: stop `npm run dev` and start it again. Settings are only read at startup.
5. On the computer, open `https://<your-ngrok-address>/readiness.html`, enter the readiness token, and press
   **Run checks**. "Live token setup call" and "Live wallet request creation" should both say Pass. Fix
   anything marked Fail before going on.

## Run the test (on the phone that holds the wallet)

6. On the Android phone, open `https://<your-ngrok-address>/` in Chrome. The wallet must be on the same phone:
   this is a same-device flow.
   - If the page shows "This browser cannot ask a wallet for an ID. Open this page in a browser on the phone
     that holds your wallet.", you are in the wrong browser or on the wrong device.
7. Choose 1 ticket and press **Verify age with my wallet ID**. Android's wallet chooser should open and offer
   the Multipaz Driver license. Approve sharing.
8. Expected on the phone:
   - [ ] Status: "Age confirmed. Your ticket is ready." The ticket and its QR code appear.
   - [ ] Privacy receipt: "What we kept" lists `age_verified`, `verified_at` and `verification_ref`.
         "Received, then discarded" lists `portrait`.
9. Expected in the server terminal:
   - [ ] Always, in real mode: one line with the verdict and its reason code, for example
         `[firewall] decision=allow reason=age_confirmed` or `[firewall] decision=deny reason=authentication_checks_failed`.
   - [ ] Because `DEV_INSPECT=1`, just before it: a line starting `[inspect] raw verifier response (personal data redacted):`.
         Key names are kept; true/false values are shown; every other value appears only as `[redacted …]`, and
         the portrait as `[portrait omitted, N bytes]`. **Note where `age_over_21` sits in this output** and send
         it to me if the result was not "Age confirmed".
   - [ ] A line listing the field names returned by the verifier.
   - If there is a `[firewall]` line but no `[inspect]` line, DEV_INSPECT was off when the server started: it
     must be exactly `DEV_INSPECT=1` (not `true`), and `npm run dev` must be restarted after editing `.env`.
10. Try the other paths:
    - [ ] Press Verify and close the wallet chooser without sharing. Expected: "The wallet was closed before
          anything was shared. Nothing was shared. Press Verify to try again."
    - [ ] Optional: leave the chooser open for more than 2 minutes. Expected: "The wallet did not answer in time…"
11. On the computer, open `/dashboard.html`:
    - [ ] The SDK badge says **Live SDK**.
    - [ ] "Requests created" went up by one per Verify press. "Failed requests" is 0.
    - [ ] "Token setups" is at least 1.
12. Set `DEV_INSPECT=0` again and restart the server when you are done looking at the raw output.

### If it does not pass

| What you see | Most likely cause |
| --- | --- |
| "Your wallet did not share an age answer" | The age claim has a different name or place. Check the inspect line from step 9 and set `AGE_CLAIM_KEY` to the name shown. |
| "The ID could not be verified" | Credence returned `res: false`. Check that the IACA certificate is uploaded for this profile, and that the credential was issued by issuer.multipaz.org. |
| "The wallet answer could not be read" | The age value was not a true/false value (for example the text "true"). Send me the inspect line. |
| "The identity service could not complete the request" | The Cloud SDK call failed. The server log shows `CloudSdkError … HTTP nnn`. A 403 usually means `CLOUDSDK_ORIGIN` does not exactly match the registered origin. |
| No wallet chooser appears | Old Chrome, not Chrome, or the page was opened on a different device from the wallet. |

## Quick switch: `?dcdata=deviceRequest`

By default the shop does what Credence's official sample app does (React-CloudSDK-Integration,
`useISO18013Flow`): it passes the **whole** `dcRequest` object (`deviceRequest` and `encryptionInfo`) to the
wallet as the request `data`.

If the wallet chooser does not open, or the wallet reports a bad request, try the other form without changing
any code. Add `?dcdata=deviceRequest` to the shop address on the phone:

    https://<your-ngrok-address>/?dcdata=deviceRequest

With this flag only `dcRequest.deviceRequest` is passed. Remove it to go back to the default. It affects real
mode only; the hybrid and mock wallets ignore it.

## Reading the authentication block (DEV_INSPECT)

With `DEV_INSPECT=1`, every verification prints one line that starts like this:

    [inspect] raw verifier response (personal data redacted): {"res":true,"cancelled":false,"authentication":{…}} resDetails={…}

`res`, `cancelled` and the whole `authentication` block are printed first and in full: they are flags and
short error strings, not personal data. The rest of `resDetails` follows with its structure and key names,
but every value other than true/false and null is replaced by `[redacted string, N chars]` or
`[redacted number]`, and the portrait by `[portrait omitted, N bytes]`.

It is followed by the verdict line, which is printed in real mode even without DEV_INSPECT:

    [firewall] decision=deny reason=authentication_checks_failed

`authentication_checks_failed` is what the shop shows as "The ID did not pass a security check". For that
reason only, the same line also says which check failed, without needing DEV_INSPECT:

    [firewall] decision=deny reason=authentication_checks_failed res=true issuerRecognized=false … certValidationError="…"

It lists `res`, `issuerRecognized`, `issuerSignedAuthenticated`, `deviceSignedAuthenticated`, `dataIntegrity`,
`issuerAuthValid`, `deviceAuthValid` (each `true`, `false`, `missing` or `not-boolean`) and the first 200
characters of `certValidationError`. No claim values are printed.

For `unreadable_response` and `age_claim_missing`, the line instead describes the age claim, never its value:

    [firewall] decision=deny reason=unreadable_response ageClaimType=string ageClaimPath=identity.age_over_21 ageClaimLength=4 ageClaimString=true-like

`ageClaimType` is boolean, string, number, object, array, null or missing; `ageClaimPath` is where it was
found (keys only); for a string, `ageClaimString` says whether it reads as "true", "false" or other.
`resDetails=unparseable` means Credence's `resDetails` was not JSON at all.

Credence sends age flags such as `identity.age_over_21` as strings (for example `"True"`), so the Credence
adapter (`normalizeCredenceAgeFlags` in `src/identity.ts`) converts the words `true` / `false`, in any ASCII
letter case, to booleans under `identity` and `documents[].identity` before the firewall; anything else
(`"yes"`, `"1"`, extra whitespace) is still refused.

| Field | What it means if it is wrong |
| --- | --- |
| `issuerRecognized: false` | Credence does not trust the issuer of this credential. Check that the **issuer.multipaz.org root IACA certificate** is uploaded for the profile you are using, and that the credential in the wallet was issued by issuer.multipaz.org. The shop shows "The ID did not pass a security check." |
| `certValidationError` (any text) | Why the certificate chain failed, in Credence's words, for example an unknown or expired certificate. Read this first when `issuerRecognized` is false. Empty or missing means no certificate problem. |
| `issuerSignedAuthenticated` / `issuerAuthValid: false` | The issuer's signature on the data did not check out. |
| `deviceSignedAuthenticated` / `deviceAuthValid: false` | The phone's own signature (device binding) did not check out. |
| `dataIntegrity: false`, `msoValidity: false` | The data or its signed summary (MSO) is damaged or expired. |
| `authenticationResult` | Credence's overall verdict as text. |

The shop refuses whenever any of `issuerRecognized`, `issuerSignedAuthenticated`, `deviceSignedAuthenticated`
or `dataIntegrity` is `false`, even if `res` is true. The other fields are shown to help diagnose, but they do
not change the decision.

## Workaround: `readerAuthAll` is removed from the wallet request

**What:** in real mode, before the server sends `dcRequest` to the phone (from `/api/verify/start` and
`/api/claims/:token/start`), it removes the top-level `readerAuthAll` entry from `dcRequest.deviceRequest`.
Every other byte stays exactly as Credence produced it, including each document's `itemsRequest`;
`encryptionInfo` is not touched. The server log shows one line each time:

    [dc] removed readerAuthAll (verifier reader chain rejected by wallet)

**Why:** the reader certificate chain in Credence's `readerAuthAll` has issuer and subject names encoded
differently, so the Multipaz wallet rejects it ("Certificate chain is not valid: subject does not match
issuer") before reading the request. In Chrome this surfaced as a `NetworkError` right after "Agree and
continue". Without `readerAuthAll`, the wallet treats the shop as a verifier it cannot identify, but it still
answers. The answer is still encrypted to Credence's `encryptionInfo` key and checked by Credence as before.

**Scope:** real mode only, and on by default. Hybrid and mock are never changed. To send the request exactly as
Credence returns it (for example once Credence fixes the certificate encoding), set `DC_KEEP_READER_AUTH=1`
in `.env` yourself and restart the server. If a `deviceRequest` ever cannot be parsed, it is sent unchanged
and the log says `[dc] deviceRequest could not be parsed as CBOR; sent unchanged`.

This is a demo workaround, not a fix: report the certificate encoding to Credence so it can be removed.

## Demo workarounds for the locked Credence profile

Both are **demo workarounds**, real mode only. Hybrid and mock are never affected.

### A. The mDL request asks for `age_over_21` only (on by default)

**What:** in real mode, `/api/verify/start` and `/api/claims/:token/start` rewrite the mDL docRequest
(`org.iso.18013.5.1.mDL`) so it asks only for `age_over_21` in `org.iso.18013.5.1`, with intentToRetain
false. The docType, any `requestInfo`, the docRequest's other keys (such as `readerAuth`), the other
docRequests, `version`, `deviceRequestInfo` and `encryptionInfo` are copied byte for byte. The log says:

    [dc] mDL request narrowed to age_over_21 (profile asks for more)

**Why:** the locked Credence profile asks for more (for example the portrait) than the shop ever uses. The
shop only needs the yes/no age answer.

**Caveats:** a reader signature covers the original request, so a per-document `readerAuth` (and
`readerAuthAll`, if you keep it) no longer matches the narrowed request, and a wallet may reject or flag it.
Credence may also reject an answer that lacks elements its profile expects.

**Switch off:** set `DC_KEEP_REQUESTED_ELEMENTS=1` in `.env` yourself and restart the server.

### B. Accept an issuer that is not on the trust list (DEMO ONLY, off by default)

**What:** with `DEMO_ACCEPT_UNLISTED_ISSUER=1` in `.env` (set it yourself) and real mode, a credential whose
**only** failed check is `issuerRecognized: false` (with `res` true, and `issuerSignedAuthenticated`,
`deviceSignedAuthenticated` and `dataIntegrity` all true) goes on to the normal age check instead of being
refused. Any other failed check, `res: false`, or a cancelled answer is still refused. When it is used:

- the server log says `[firewall] WARNING demo override: issuer not on trust list`;
- the privacy receipt shows "Issuer not on the trust list (demo setting)" and stores `issuerTrust: demo-unlisted`;
- the audit CSV gets an `issuer_trust` row with `issuerTrust=demo-unlisted` for that ticket.

At startup, while it is on, the server also prints a warning line.

**Why:** the Multipaz test issuer is not on the locked profile's trust list, so every real test is refused at
`issuerRecognized` even though the signatures check out.

**Risk:** while this is on, anyone who can sign their own mDL passes the age check. Use it only for a demo, and
switch it off afterwards by removing the line from `.env` and restarting.

## Switch back to hybrid

1. In `.env`, set `VERIFIER_MODE=hybrid` and `DEV_INSPECT=0`.
2. Restart the server.
3. Open `/dashboard.html`. The badge still says **Live SDK**, and the shop goes back to the QR code and the
   separate simulated wallet page. Nothing else needs to change. The real-mode messages only appear when
   `VERIFIER_MODE=real`.

## What could not be verified without a real credential

- **The request and answer format, on a real phone.** The shop now matches Credence's official sample: the
  whole `dcRequest` goes to the wallet, and `credential.data` goes to `/v1/verifyDocRequest` as `{sessionId, data}`
  (a string as is, an object as JSON text). This is checked in tests against fakes only. If the wallet will not
  open, try `?dcdata=deviceRequest` (see above).
- **Where the Age Check profile puts `age_over_21` in `resDetails`.** The server now finds it at any depth: top
  level, under `identity`, under a namespace such as `org.iso.18013.5.1`, or in an
  `elementIdentifier`/`elementValue` list. This was tested only with made-up shapes.
- **That the portrait is called `portrait`.** It is dropped either way, because only the age claim's yes/no is
  ever used. The receipt would just list it under a different name.
- **Real Android behaviour:** the wallet chooser, what a cancel looks like (assumed `NotAllowedError`), and
  whether pressing Verify keeps enough of the tap's "user activation" for Chrome to allow the wallet prompt.
  The session is fetched when the finger goes down, to help with this.
- **Credence's `cancelled: true` response** in practice. It is handled, but has only been seen in fakes.
- **The real Cloud SDK calls themselves.** None were made while preparing this.

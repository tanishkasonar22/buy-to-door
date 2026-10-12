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
9. Expected in the server terminal (because `DEV_INSPECT=1`):
   - [ ] A line starting `[inspect] raw verifier response (portrait redacted):`. The portrait appears only as
         `[portrait omitted, N bytes]`. **Note where `age_over_21` sits in this output** and send it to me if
         the result was not "Age confirmed".
   - [ ] A line listing the field names returned by the verifier.
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

    [inspect] raw verifier response (portrait redacted): {"res":true,"cancelled":false,"authentication":{…}} resDetails={…}

`res`, `cancelled` and the whole `authentication` block are printed first and in full: they are flags and
short error strings, not personal data. The rest of `resDetails` follows, with the portrait shown only as
`[portrait omitted, N bytes]`.

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

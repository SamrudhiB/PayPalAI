# Ballast

**When a client pays late, Ballast shows a small agency owner what each recovery plan does to the schedule, the cash and the risk of missing payroll. Then it collects the payment through PayPal.**

Live demo: https://paypalai.onrender.com
Built for the PayPal AI Hackathon.

## The problem

A small agency plans work around client payments. When a $6,000 deposit arrives 10 days late, the owner has to decide fast: wait, move people between projects, or start work without being paid. Today that means a spreadsheet and a guess. A wrong guess means missing payroll.

## What it does

1. A milestone payment is late. Ballast rebuilds the schedule and the cash timeline for four recovery plans:
   - **A. Wait**: do nothing, blocked work stays blocked.
   - **B. Move a person** to another project so a payment lands earlier.
   - **C. Start now, at risk**: begin the blocked work before the money arrives.
   - **D. Offer an early-payment discount**: 3% off if the client pays by day 7. The simulation assumes the client accepts only some of the time.
   - **D. Offer 3% off to pay early**: costs $180 and only works if the client accepts (assumed 60%; the simulation also covers them declining).
2. A Monte Carlo simulation replays each plan against 2,000 possible futures and reports the chance of missing payroll, of finishing on time, and of doing unpaid work.
3. An AI model explains the trade-off in plain words, recommends a plan and drafts the message to the client.
4. The owner approves. Ballast creates a **PayPal** payment link for the late deposit.
5. When PayPal confirms the payment with a **signed webhook**, the Gantt chart and cash chart reflow to the new reality.

In the sample data, Plan A and Plan C each have a 100% chance of missing the $7,000 payroll. Plan B cuts that to 34%.

## How PayPal is used

- **Orders v2 API** creates a $6,000 sandbox order for the late deposit, tagged with `custom_id` so the payment can be matched to the milestone. The amount comes from the server's own data, never from the browser.
- **Capture** happens on the server when the buyer returns from PayPal.
- **Webhooks**: `PAYMENT.CAPTURE.COMPLETED` is the only event that marks a milestone as paid. Every event is checked with PayPal's `verify-webhook-signature` API, and each event id is processed once because PayPal retries deliveries.

Webhook rules, each covered by a test: a duplicate event is processed once; an event with an invalid signature is rejected and changes nothing; an approval that arrives after the capture cannot move a paid milestone backwards; a failed capture leaves the milestone unpaid; an event for an unrelated payment changes no milestone; paying one milestone does not touch the others. Every event and every manager decision is recorded in an audit trail shown in the Activity panel.

The page never trusts the redirect. It changes only when a signed event arrives.

## How AI is used

The AI explains and recommends. It never calculates.

- The engine computes every number (dates, cash, probabilities) in deterministic code.
- Gemini receives those numbers and writes the recommendation and the client message.
- A validator rejects any answer that contains a number the engine did not produce, then asks again. If the model is down or keeps failing, a rule-based template answer is shown and labelled as such. Both the server and the browser run this check.

## Architecture

```
web/            Vite app: Bryntum Gantt, plan cards, cash chart, approval flow
src/engine.js   Scheduler, cash timeline, plan generator, Monte Carlo risk
src/explain.js  Prompt, number validator, template fallback
src/ledger.js   Payment ledger: forward-only payment states, dedupe, signature gate, audit trail
src/server.js   Static hosting, PayPal orders + capture + webhook, Gemini calls
test/           27 tests (engine and AI layer)
```

The engine is plain JavaScript with no dependencies and runs in both Node and the browser, so what-if changes recompute instantly.

## Run it

Needs Node 20 or newer.

```bash
npm install
npm test
npm run build
node --env-file=.env src/server.js      # http://localhost:3000
```

Create a `.env` file (never commit it):

```
PAYPAL_CLIENT_ID=...
PAYPAL_SECRET=...
WEBHOOK_ID=...
GEMINI_API_KEY=...
```

Without keys the app still runs. The AI text falls back to the template, and the PayPal button reports that keys are missing. For local webhook testing, expose the server with a tunnel and register `<url>/webhook` in the PayPal developer dashboard.

`npm run demo` prints the plan comparison and risk table in the terminal.

## Honest limits

- The agency, projects and client payment habits are **sample data**. The reliability profile for each client (on time, 1 to 7 days late, 8 to 21 days late, never) is an assumption, not learned from real history. So is the 60% chance that a client accepts the early-payment discount.
- The scheduler handles one task per person, fixed and splittable tasks, and payment gates. It is not a full project-management engine.
- Events are kept in memory, so a server restart clears them.
- PayPal runs in the **sandbox** only. No real money moves.
- The Gantt chart uses the Bryntum Gantt trial, so a faint watermark is visible.

## Tools

Node.js, Vite, Bryntum Gantt (trial), PayPal Orders v2 and Webhooks (sandbox), Google Gemini API, Render, Claude and Claude Code (development assistance).

## License

MIT, see `LICENSE`.

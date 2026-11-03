# We Missed You

**Missed-call text-back for tradespeople.** A Blue Labs LTD product.

When a customer calls and you can't answer, We Missed You instantly sends them *your* message by SMS or WhatsApp, so the job doesn't go to the next number on Google.

## What it does

1. **Sign up:** name, email, password.
2. **Pay:** Stripe Checkout (subscription). The app stays locked until payment.
3. **Connect:** enter your mobile, choose how calls reach us, and choose SMS or WhatsApp. The app gives you a We Missed You number automatically.
4. **Home screen:** total missed calls, this week, messages sent, your message (edit, presets, pause), and recent callers.

### Two ways to connect

| Mode | How it works | Best for |
|---|---|---|
| **Keep my number** (forward) | The user dials `**004*<WMY number>#` once on their mobile. Calls they don't answer, reject or miss with no signal are forwarded to their WMY number, and the caller gets the message. Works on all UK networks. Turn off with `##004#`. | Tradespeople who already have a number customers know |
| **Business number** (mask) | Customers call the WMY number. We ring the user's mobile for 20s and show the caller's number. The user presses a key to accept, so voicemail picking up doesn't count as answered. If they don't accept, the caller gets the message. Their personal number stays private. | A separate business line |

### Built-in protections
- Sends at most one message per caller every 12 hours, so repeat callers aren't spammed
- Skips withheld numbers and the user's own number
- "Never message these numbers" list for family, suppliers and so on
- Twilio and Stripe webhooks are signature-verified
- Passwords are hashed with scrypt, sessions use signed httpOnly cookies, and forms have CSRF tokens

## Stack (deliberately tiny)
- Node 22 + Express (the only dependency)
- SQLite via Node's built-in `node:sqlite`, a single file
- Twilio and Stripe called over plain `fetch`, no SDKs
- Server-rendered HTML that can be installed as a PWA (Add to Home Screen shows "We Missed You" with the WMY icon)

## Preview it free (no keys needed)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/blulabsdigital-lgtm/We-Missed-You-)

Click the button, sign in to Render with GitHub, and press **Apply**. In a few minutes you get a live link you can open on your phone. It runs in test mode: payment unlocks for free and messages are logged instead of sent. The free plan sleeps when idle (the first load takes about 30s) and resets its data on each redeploy.

## Run it

```bash
npm install
npm start          # http://localhost:3000
npm test           # end-to-end flow test
```

With no keys set it runs in **DEV mode**. The pay button unlocks for free, a fake number is issued, and messages are printed to the console. You can click through the whole app straight away.

## Go live (fill the holes)

Copy `.env.example` to `.env` and fill it in:

1. **Host.** GitHub Pages only serves static files and can't run this, because the app needs a server for the phone webhooks. Cheapest options: Render, Railway or Fly.io (a `Dockerfile` is included; mount a disk at `/data`), or any £4/month VPS. Set `PUBLIC_URL` to the live URL.
2. **Twilio.** Add the Account SID and Auth Token. UK numbers need a Regulatory Bundle and Address in the Twilio console: put their SIDs in `TWILIO_BUNDLE_SID` and `TWILIO_ADDRESS_SID`. Numbers are bought automatically, and their voice webhook is set to `/twilio/voice`.
3. **WhatsApp.** Register one WhatsApp sender in Twilio and set `TWILIO_WHATSAPP_FROM`. Note: WhatsApp needs a Meta-approved *template* for business-initiated messages, so get the default message approved as a template (or use SMS until it is).
4. **Stripe.** Create a recurring Price and set `STRIPE_SECRET_KEY` and `STRIPE_PRICE_ID`. Add a webhook to `<PUBLIC_URL>/stripe/webhook` with the events `checkout.session.completed`, `customer.subscription.updated` and `customer.subscription.deleted`, then set `STRIPE_WEBHOOK_SECRET`. Turn on the Customer Portal so the "Manage billing" link works.

### Running costs (approx.)
A Twilio UK number is about £1/month per customer. A UK SMS is about 4p per message. Build both into the price.

## Later
- Password reset email (Resend), contact sync, Postgres/Supabase when it grows, an admin page.

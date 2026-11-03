# Private Telegram WHOIS Bot

A private Telegram bot using Who.is API, Vercel Functions, and Upstash Redis.

## Features

- `/whois example.com` — WHOIS lookup
- `/usage` — monthly usage counter
- Only the configured Telegram numeric user ID can use the bot
- 30-day result cache (cache hits do not call Who.is)
- Global 1-request-per-second guard
- Monthly local cap of 500 successful new lookups
- Who.is API key and Telegram secrets stay in server environment variables

## Important usage terms

This project is configured for one authorized personal account. Who.is API terms prohibit reselling or redistributing API responses as a standalone lookup service. Do not open this bot to other users or offer WHOIS results as a public service unless Who.is explicitly authorizes that use.

## 1. Create the Telegram bot

1. Open Telegram and message `@BotFather`.
2. Send `/newbot` and follow the steps.
3. Copy the bot token. Keep it private.
4. Get your numeric Telegram user ID from a trusted ID bot or Telegram tooling.

## 2. Create persistent Redis storage

Create a free database at Upstash Redis. Copy its REST URL and REST token.

Vercel serverless functions do not provide reliable persistent local storage; Redis is used for the cache and monthly counter.

## 3. Deploy to Vercel

1. Upload this folder to a new private GitHub repository.
2. Import the repository into Vercel.
3. Add these Environment Variables in Vercel Project Settings:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_WEBHOOK_SECRET` (random string, 32+ characters)
   - `TELEGRAM_ALLOWED_USER_ID` (your numeric Telegram user ID)
   - `WHOIS_API_KEY`
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   - `APP_URL` (your deployed `https://....vercel.app` URL)
4. Redeploy after adding variables.

## 4. Set the Telegram webhook

On a computer with Node.js installed, in this project folder:

```bash
npm install
npm run set-webhook
```

The command reads the environment variables from your shell. Alternatively, call Telegram's `setWebhook` method with URL `https://YOUR-APP.vercel.app/api/telegram` and the same secret token.

## 5. Test

Open your bot and send:
- `/start`
- `/whois example.com`
- `/usage`

## Notes

- The local monthly counter resets by using a new UTC month key.
- Who.is is the source of truth for its own quota and rate limits. This bot's 500 counter is an additional safety cap.
- A cache entry expires after 30 days. Who.is itself may serve a snapshot that is up to 30 days old. This bot does not request `?live=true`.
- If the Who.is API response schema changes, adjust `formatWhois` in `api/telegram.js`.
- Never put real tokens or API keys in GitHub, source code, screenshots, or chat messages.

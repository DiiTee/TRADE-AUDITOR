# Trade Auditor — Crypto Chart Analysis Engine

A Solana token trade auditing tool that analyses entry/exit timing against on-chain price data.

## How to run

The app starts automatically via the **Start application** workflow (`node server.js`), which serves the frontend and proxies external APIs on port 5000.

## Stack

- **Backend:** Node.js + Express (`server.js`) — proxies GeckoTerminal and Moralis APIs with rate-limiting
- **Frontend:** Single-page HTML app (`public/index.html`) — no build step required

## External APIs

| Service | Key required | Where configured |
|---|---|---|
| GeckoTerminal | Optional (`GECKO_API_KEY` secret) | Server env var — improves rate limit from 30 req/min |
| Moralis Solana | Required for Pump.fun pre-graduation tokens | Entered by the user in the app UI (passed per-request) |

## Secrets

- `SESSION_SECRET` — session signing key (already set)
- `GECKO_API_KEY` — optional GeckoTerminal API key for higher rate limits

## User preferences

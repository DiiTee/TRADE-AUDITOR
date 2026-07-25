'use strict';

const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 5000;

const GT_API_KEY   = process.env.GECKO_API_KEY || '';
const GT_BASE      = 'https://api.geckoterminal.com/api/v2';
const MORALIS_BASE = 'https://solana-gateway.moralis.io';

// ── GeckoTerminal rate-limited queue ─────────────────────────────
// The Demo API allows 30 calls/minute.  We serialize every outgoing
// GT request through this queue and enforce a minimum 2.1 s gap so
// we physically cannot exceed ~28 req/min — no matter how fast the
// browser fires page requests.
const GT_MIN_INTERVAL_MS = 2100;
let _gtQueue      = Promise.resolve(); // chain every call onto this
let _lastGTCallAt = 0;

function queuedGTFetch(url, options) {
  _gtQueue = _gtQueue.then(async () => {
    const gap = Date.now() - _lastGTCallAt;
    if (gap < GT_MIN_INTERVAL_MS) {
      await new Promise(r => setTimeout(r, GT_MIN_INTERVAL_MS - gap));
    }
    _lastGTCallAt = Date.now();
    return fetch(url, options);
  });
  return _gtQueue;
}

// ── Retry helper (safety net on top of the queue) ─────────────────
// If a 429 still slips through (e.g. burst from a previous run that
// exhausted the window), wait one full rate-limit window (65 s) then
// try again.  Up to 2 extra attempts.
async function gtFetchWithRetry(url, options, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const r = await queuedGTFetch(url, options);

    if (r.status !== 429 || attempt === maxRetries) return r;

    const retryAfterSec = parseInt(r.headers.get('retry-after') || '0', 10);
    const waitMs = retryAfterSec > 0 ? retryAfterSec * 1000 : 65000; // default: 65 s
    console.log(`[Gecko] 429 — waiting ${waitMs / 1000}s before retry ${attempt + 1}/${maxRetries}`);
    await new Promise(r => setTimeout(r, waitMs));
  }
}

// ── Serve static frontend ─────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── GeckoTerminal proxy ───────────────────────────────────────────
app.get('/api/gecko/*', async (req, res) => {
  const subPath  = req.params[0] || '';
  const queryStr = req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : '';
  const target   = `${GT_BASE}/${subPath}${queryStr}`;

  const headers = { 'Accept': 'application/json;version=20230302' };
  if (GT_API_KEY) headers['x-cg-demo-api-key'] = GT_API_KEY;

  try {
    const upstream = await gtFetchWithRetry(target, { headers });
    const body     = await upstream.text();
    res
      .status(upstream.status)
      .set('Content-Type', upstream.headers.get('content-type') || 'application/json')
      .send(body);
  } catch (err) {
    console.error('[Gecko proxy error]', err.message);
    res.status(502).json({ error: 'Failed to reach GeckoTerminal API', detail: err.message });
  }
});

// ── Moralis proxy ─────────────────────────────────────────────────
app.get('/api/moralis/*', async (req, res) => {
  const subPath  = req.params[0] || '';
  const queryStr = req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : '';
  const target   = `${MORALIS_BASE}/${subPath}${queryStr}`;

  const moralisKey = req.headers['x-moralis-key'] || '';
  if (!moralisKey) {
    return res.status(400).json({ error: 'Moralis API key missing — pass it as X-Moralis-Key header.' });
  }

  try {
    const upstream = await fetch(target, {
      headers: { 'X-API-Key': moralisKey, 'Accept': 'application/json' }
    });
    const body = await upstream.text();
    res
      .status(upstream.status)
      .set('Content-Type', upstream.headers.get('content-type') || 'application/json')
      .send(body);
  } catch (err) {
    console.error('[Moralis proxy error]', err.message);
    res.status(502).json({ error: 'Failed to reach Moralis API', detail: err.message });
  }
});

// ── MC Snapshot — fast single-candle lookup (bypasses audit queue) ─
// Used by the auto-fetch feature. Makes at most 2 GT calls per
// request (pool resolution + OHLCV). A separate lightweight cooldown
// prevents abuse while keeping the audit queue unblocked.
let _lastSnapAt = 0;
const SNAP_COOLDOWN_MS = 2100; // respect the same per-call minimum

app.get('/api/mc-snapshot', async (req, res) => {
  const { pool, ts } = req.query;
  if (!pool || !ts) return res.status(400).json({ error: 'pool and ts are required' });
  const timestamp = parseInt(ts, 10);
  if (isNaN(timestamp)) return res.status(400).json({ error: 'ts must be an integer' });

  // Lightweight cooldown — independent of the audit queue
  const gap = Date.now() - _lastSnapAt;
  if (gap < SNAP_COOLDOWN_MS) await new Promise(r => setTimeout(r, SNAP_COOLDOWN_MS - gap));
  _lastSnapAt = Date.now();

  const headers = { 'Accept': 'application/json;version=20230302' };
  if (GT_API_KEY) headers['x-cg-demo-api-key'] = GT_API_KEY;

  try {
    // Step 1 — resolve pool address (skip extra call if it already looks like a pool)
    let poolAddr = pool;
    const poolCheck = await fetch(`${GT_BASE}/networks/solana/pools/${pool}`, { headers });
    if (!poolCheck.ok) {
      _lastSnapAt = Date.now();
      const tokenR = await fetch(`${GT_BASE}/networks/solana/tokens/${pool}/pools?page=1`, { headers });
      if (!tokenR.ok) return res.status(404).json({ error: 'Pool not found for this address' });
      const td = await tokenR.json();
      const pools = td.data;
      if (!pools || pools.length === 0) return res.status(404).json({ error: 'No pools found for token' });
      const p = pools[0];
      poolAddr = (p.attributes && p.attributes.address)
        ? p.attributes.address
        : p.id.replace(/^solana_/, '');
    }

    // Step 2 — fetch a small window of candles around the entry timestamp
    _lastSnapAt = Date.now();
    const ohlcvUrl = `${GT_BASE}/networks/solana/pools/${poolAddr}/ohlcv/minute?aggregate=1&limit=10&before_timestamp=${timestamp + 300}`;
    const ohlcvR = await fetch(ohlcvUrl, { headers });
    if (ohlcvR.status === 429) return res.status(429).json({ error: 'Rate limited — wait a moment and try again' });
    if (!ohlcvR.ok) return res.status(ohlcvR.status).json({ error: `OHLCV fetch failed (${ohlcvR.status})` });

    const d = await ohlcvR.json();
    const candles = (d.data && d.data.attributes && d.data.attributes.ohlcv_list) || [];
    if (!candles.length) return res.status(404).json({ error: 'No candle data near that timestamp' });

    // Pick candle closest to requested timestamp
    const best = candles.reduce((prev, cur) =>
      Math.abs(cur[0] - timestamp) < Math.abs(prev[0] - timestamp) ? cur : prev);

    res.json({ resolvedPool: poolAddr, closePrice: best[4], candleTs: best[0] });
  } catch (err) {
    console.error('[MC snapshot error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Start (local / Replit) ────────────────────────────────────────
// On Vercel the file is imported as a module; app.listen() must not
// be called in that context.  `require.main === module` is true only
// when the file is executed directly (node server.js).
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Trade Auditor] Server running on port ${PORT}`);
    if (GT_API_KEY) {
      console.log('[Trade Auditor] GeckoTerminal API key: loaded from env');
    } else {
      console.log('[Trade Auditor] GeckoTerminal API key: NOT SET (add GECKO_API_KEY for better rate limits)');
    }
    console.log(`[Trade Auditor] GT request pacing: one request every ${GT_MIN_INTERVAL_MS}ms`);
  });
}

// Export for Vercel serverless
module.exports = app;

'use strict';

const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 5000;

const GT_API_KEY   = process.env.GECKO_API_KEY || '';
const GT_BASE      = 'https://api.geckoterminal.com/api/v2';
const MORALIS_BASE = 'https://solana-gateway.moralis.io';

// ── Retry helper ──────────────────────────────────────────────────
// Retries a fetch on 429 (rate-limited) up to `maxRetries` times.
// Respects the Retry-After header when present; otherwise backs off
// exponentially starting at 2 s.
async function fetchWithRetry(url, options, maxRetries = 4) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const r = await fetch(url, options);

    if (r.status !== 429 || attempt === maxRetries) return r;

    const retryAfterSec = parseInt(r.headers.get('retry-after') || '0', 10);
    const backoffMs = retryAfterSec > 0
      ? retryAfterSec * 1000
      : Math.min(2000 * 2 ** attempt, 30000); // 2 s, 4 s, 8 s, 16 s … capped at 30 s

    console.log(`[Gecko] 429 rate-limited — retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries})`);
    await new Promise(res => setTimeout(res, backoffMs));
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
    const upstream = await fetchWithRetry(target, { headers });
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

// ── Health check ──────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Trade Auditor] Server running on port ${PORT}`);
  if (GT_API_KEY) {
    console.log('[Trade Auditor] GeckoTerminal API key: loaded from env');
  } else {
    console.log('[Trade Auditor] GeckoTerminal API key: NOT SET (add GECKO_API_KEY env var for higher rate limits)');
  }
});

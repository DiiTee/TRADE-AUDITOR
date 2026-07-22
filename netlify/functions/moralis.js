'use strict';

const MORALIS_BASE = 'https://solana-gateway.moralis.io';

export async function handler(event) {
  const raw     = new URL(event.rawUrl);
  const subPath = raw.pathname.replace(/^\/?api\/moralis\/?/, '');
  const target  = `${MORALIS_BASE}/${subPath}${raw.search}`;

  const moralisKey = (event.headers || {})['x-moralis-key'] || '';
  if (!moralisKey) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Moralis API key missing — pass it as X-Moralis-Key header.' }),
    };
  }

  try {
    const upstream = await fetch(target, {
      headers: { 'X-API-Key': moralisKey, 'Accept': 'application/json' },
    });
    const body = await upstream.text();
    return {
      statusCode: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json' },
      body,
    };
  } catch (err) {
    console.error('[Moralis/Netlify proxy error]', err.message);
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to reach Moralis API', detail: err.message }),
    };
  }
}

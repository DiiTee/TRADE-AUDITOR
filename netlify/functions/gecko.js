'use strict';

const GT_BASE    = 'https://api.geckoterminal.com/api/v2';
const GT_API_KEY = process.env.GECKO_API_KEY || '';

// Retry on 429 — up to 2 extra attempts, honouring Retry-After header.
// (The in-process request queue from server.js cannot be shared across
//  stateless function invocations, so we rely on this retry safety-net.)
async function gtFetchWithRetry(url, options, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const r = await fetch(url, options);
    if (r.status !== 429 || attempt === maxRetries) return r;
    const retryAfterSec = parseInt(r.headers.get('retry-after') || '0', 10);
    const waitMs = retryAfterSec > 0 ? retryAfterSec * 1000 : 65000;
    console.log(`[Gecko/Netlify] 429 — waiting ${waitMs / 1000}s before retry ${attempt + 1}/${maxRetries}`);
    await new Promise(res => setTimeout(res, waitMs));
  }
}

export async function handler(event) {
  // Strip the function prefix; rawUrl carries the original request path + query.
  const raw     = new URL(event.rawUrl);
  const subPath = raw.pathname.replace(/^\/?api\/gecko\/?/, '');
  const target  = `${GT_BASE}/${subPath}${raw.search}`;

  const headers = { 'Accept': 'application/json;version=20230302' };
  if (GT_API_KEY) headers['x-cg-demo-api-key'] = GT_API_KEY;

  try {
    const upstream = await gtFetchWithRetry(target, { headers });
    const body     = await upstream.text();
    return {
      statusCode: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json' },
      body,
    };
  } catch (err) {
    console.error('[Gecko/Netlify proxy error]', err.message);
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to reach GeckoTerminal API', detail: err.message }),
    };
  }
}

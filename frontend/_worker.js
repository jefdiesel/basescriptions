// Cloudflare Pages Worker for dynamic routes
const API_BASE = 'https://basescriptions-api.wrapit.workers.dev';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Try to serve static assets first
    const staticPaths = ['/', '/index.html', '/register/', '/upload/', '/inscribe/', '/item/', '/address/'];
    if (staticPaths.includes(path) || path.includes('.')) {
      const response = await env.ASSETS.fetch(request);
      if (response.status !== 404) {
        return response;
      }
    }

    // Handle /item/0x... routes - serve item page
    if (path.startsWith('/item/') && path !== '/item/') {
      return serveAsset(env, request, '/item/index.html');
    }

    // Handle /address/0x... routes - serve address page
    if (path.startsWith('/address/') && path !== '/address/') {
      return serveAsset(env, request, '/address/index.html');
    }

    const segment = path.replace(/^\//, '').replace(/\/$/, '');

    if (!segment) {
      return env.ASSETS.fetch(request);
    }

    // Check if it's an Ethereum address (0x + 40 hex chars)
    if (/^0x[a-fA-F0-9]{40}$/i.test(segment)) {
      return serveAsset(env, request, '/address/index.html');
    }

    // Check if it's a hash (0x + 64 hex chars)
    if (/^0x[a-fA-F0-9]{64}$/i.test(segment)) {
      return serveAsset(env, request, '/item/index.html');
    }

    // Otherwise, treat as a registered name - check API and show owner's wallet
    if (/^[a-z0-9-]+$/i.test(segment) && segment.length <= 32) {
      try {
        const res = await fetch(`${API_BASE}/name/${segment.toLowerCase()}`);
        const data = await res.json();

        if (!data.available && data.owner) {
          // Name is registered, show the address page
          return serveAsset(env, request, '/address/index.html');
        }
      } catch (e) {
        // Fall through to 404
      }
    }

    // Return 404 page
    return serve404(env, request);
  }
};

async function serveAsset(env, request, assetPath) {
  const url = new URL(request.url);
  url.pathname = assetPath;
  const response = await env.ASSETS.fetch(url.toString());
  const html = await response.text();
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

async function serve404(env, request) {
  const url = new URL(request.url);
  url.pathname = '/404.html';
  const response = await env.ASSETS.fetch(url.toString());
  const html = await response.text();
  return new Response(html, {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

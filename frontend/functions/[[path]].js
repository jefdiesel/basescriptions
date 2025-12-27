// Catch-all Pages Function for dynamic routes
const API_BASE = 'https://basescriptions-api.wrapit.workers.dev';

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const path = url.pathname;

  // Skip static files
  if (path.includes('.') && !path.endsWith('/')) {
    return context.next();
  }

  // Handle /item/0x... or /view/0x... routes - serve item page
  if ((path.startsWith('/item/') && path !== '/item/') || path.startsWith('/view/')) {
    url.pathname = '/item/';
    const itemPage = await context.env.ASSETS.fetch(new Request(url.toString(), context.request));
    return new Response(itemPage.body, {
      headers: { 'Content-Type': 'text/html' }
    });
  }

  // Handle /address/0x... routes - serve address page
  if (path.startsWith('/address/') && path !== '/address/') {
    url.pathname = '/address/';
    const addressPage = await context.env.ASSETS.fetch(new Request(url.toString(), context.request));
    return new Response(addressPage.body, {
      headers: { 'Content-Type': 'text/html' }
    });
  }

  // Skip known static paths
  if (path.startsWith('/register') ||
      path.startsWith('/upload') ||
      path.startsWith('/inscribe') ||
      path === '/') {
    return context.next();
  }

  const segment = path.replace(/^\//, '').replace(/\/$/, '');

  if (!segment) {
    return context.next();
  }

  // Check if it's an Ethereum address (0x + 40 hex chars)
  if (/^0x[a-fA-F0-9]{40}$/i.test(segment)) {
    url.pathname = '/address/';
    const addressPage = await context.env.ASSETS.fetch(new Request(url.toString(), context.request));
    return new Response(addressPage.body, {
      headers: { 'Content-Type': 'text/html' }
    });
  }

  // Check if it's a hash (0x + 64 hex chars)
  if (/^0x[a-fA-F0-9]{64}$/i.test(segment)) {
    url.pathname = '/item/';
    const itemPage = await context.env.ASSETS.fetch(new Request(url.toString(), context.request));
    return new Response(itemPage.body, {
      headers: { 'Content-Type': 'text/html' }
    });
  }

  // Otherwise, treat as a registered name - show owner's wallet
  if (/^[a-z0-9-]+$/i.test(segment) && segment.length <= 32) {
    try {
      const res = await fetch(`${API_BASE}/name/${segment.toLowerCase()}`);
      const data = await res.json();

      if (!data.available && data.owner) {
        // Name is registered, show the owner's wallet
        url.pathname = '/address/';
        const addressPage = await context.env.ASSETS.fetch(new Request(url.toString(), context.request));
        return new Response(addressPage.body, {
          headers: { 'Content-Type': 'text/html' }
        });
      }
    } catch (e) {
      // Fall through to 404
    }
  }

  // Return 404 page
  url.pathname = '/404.html';
  const notFoundPage = await context.env.ASSETS.fetch(new Request(url.toString(), context.request));
  return new Response(notFoundPage.body, {
    status: 404,
    headers: { 'Content-Type': 'text/html' }
  });
}

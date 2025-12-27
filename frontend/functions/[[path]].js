// Catch-all Pages Function for dynamic routes
const API_BASE = 'https://basescriptions-api.wrapit.workers.dev';

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const path = url.pathname;

  // Skip static files and known paths
  if (path.startsWith('/register') ||
      path.startsWith('/upload') ||
      path.startsWith('/view') ||
      path.startsWith('/item') ||
      path.startsWith('/address') ||
      path.startsWith('/inscribe') ||
      path === '/' ||
      path.includes('.')) {
    return context.next();
  }

  const segment = path.replace(/^\//, '').replace(/\/$/, '');

  if (!segment) {
    return context.next();
  }

  // Check if it's an Ethereum address (0x + 40 hex chars)
  if (/^0x[a-fA-F0-9]{40}$/i.test(segment)) {
    // Redirect to address page
    return Response.redirect(`${url.origin}/address/?address=${segment}`, 302);
  }

  // Check if it's a transaction hash (0x + 64 hex chars)
  if (/^0x[a-fA-F0-9]{64}$/i.test(segment)) {
    // Redirect to item page
    return Response.redirect(`${url.origin}/item/?id=${segment}`, 302);
  }

  // Otherwise, treat as a registered name - check if it exists
  if (/^[a-z0-9-]+$/i.test(segment) && segment.length <= 32) {
    try {
      const res = await fetch(`${API_BASE}/name/${segment.toLowerCase()}`);
      const data = await res.json();

      if (!data.available && data.hash) {
        // Name is registered, redirect to item view
        return Response.redirect(`${url.origin}/item/?id=${data.hash}`, 302);
      }
    } catch (e) {
      // Fall through to 404
    }
  }

  // Not found - let it 404
  return context.next();
}

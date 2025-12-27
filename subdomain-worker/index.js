/**
 * Basescriptions Subdomain Router
 * Routes *.basescriptions.com to content stored on Base L2
 *
 * Manifest format:
 * {
 *   "basescriptions": {
 *     "sitename": {
 *       "home": "0x...",
 *       "about": "0x..."
 *     }
 *   }
 * }
 */

const API_BASE = 'https://basescriptions-api.wrapit.workers.dev';
const FAVICON = 'https://basescriptions.pages.dev/favicon.png';
const MAIN_SITE = 'https://basescriptions.pages.dev';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const hostname = url.hostname;
    const path = url.pathname;

    // Root domain - redirect to main site
    if (hostname === 'basescriptions.com' || hostname === 'www.basescriptions.com') {
      return Response.redirect(MAIN_SITE + path, 302);
    }

    // Extract subdomain
    const parts = hostname.split('.');
    if (parts.length < 3 || parts[parts.length - 2] !== 'basescriptions') {
      return new Response('Invalid hostname', { status: 400 });
    }

    const name = parts[0].toLowerCase();

    // Reserved subdomains
    const reserved = ['www', 'api', 'app', 'admin', 'mail'];
    if (reserved.includes(name)) {
      return Response.redirect(MAIN_SITE, 302);
    }

    try {
      // 1. Check if name exists
      const apiRes = await fetch(`${API_BASE}/name/${name}`);
      const data = await apiRes.json();

      if (data.available) {
        return new Response(availablePage(name), {
          status: 404,
          headers: { 'Content-Type': 'text/html' },
        });
      }

      const owner = data.owner;

      // 2. Look for basescriptions manifest
      const manifest = await findManifest(env.BASE_RPC, owner, name);

      if (!manifest) {
        // No manifest - show the name's content directly
        const content = await fetchTxContent(env.BASE_RPC, data.creation_tx);
        if (content) {
          return serveContent(name, content.decoded, data);
        }
        return new Response(noManifestPage(name, owner), {
          headers: { 'Content-Type': 'text/html' },
        });
      }

      // 3. Resolve route from manifest
      const route = path === '/' || path === '' ? 'home' : path.slice(1);
      const txHash = manifest[route];

      if (!txHash) {
        // Route not found - try serving name content
        if (route === 'home') {
          const content = await fetchTxContent(env.BASE_RPC, data.creation_tx);
          if (content) {
            return serveContent(name, content.decoded, data);
          }
        }
        return new Response(notFoundPage(name, route), {
          status: 404,
          headers: { 'Content-Type': 'text/html' },
        });
      }

      // 4. Fetch and serve content from manifest tx
      const content = await fetchTxContent(env.BASE_RPC, txHash);

      if (!content) {
        return new Response(errorPage('Could not load content'), {
          status: 500,
          headers: { 'Content-Type': 'text/html' },
        });
      }

      return serveContent(name, content.decoded, { ...data, creation_tx: txHash }, manifest);

    } catch (error) {
      console.error('Error:', error);
      return new Response(errorPage(error.message), {
        status: 500,
        headers: { 'Content-Type': 'text/html' },
      });
    }
  },
};

// Find basescriptions manifest for a name
async function findManifest(rpcUrl, owner, name) {
  try {
    // Get all JSON ethscriptions owned by this address
    const apiRes = await fetch(`${API_BASE}/owned/${owner}?limit=50`);
    const data = await apiRes.json();

    if (!data.ethscriptions?.length) return null;

    for (const eth of data.ethscriptions) {
      // Check if content is JSON
      if (!eth.content_uri?.startsWith('data:application/json')) continue;

      try {
        const content = await fetchTxContent(rpcUrl, eth.creation_tx);
        if (!content) continue;

        const parsed = JSON.parse(content.decoded.replace(/^data:application\/json,/, ''));

        // Look for basescriptions manifest format
        if (parsed.basescriptions && parsed.basescriptions[name]) {
          return parsed.basescriptions[name];
        }
      } catch (e) {
        // Not valid JSON or not basescriptions manifest
      }
    }

    return null;
  } catch (e) {
    console.error('Manifest lookup error:', e);
    return null;
  }
}

// Serve content based on type
function serveContent(name, decoded, data, manifest = null) {
  // Check if it's a data URI
  if (decoded.startsWith('data:')) {
    const mimeMatch = decoded.match(/^data:([^;,]+)/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'text/plain';

    // Image
    if (mimeType.startsWith('image/')) {
      const pixelArt = manifest?.pixel === true || manifest?.pixel === 'true';
      return new Response(imagePage(name, decoded, data, pixelArt), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // Video
    if (mimeType.startsWith('video/')) {
      return new Response(videoPage(name, decoded, data), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // HTML
    if (mimeType === 'text/html') {
      const html = decodeDataUri(decoded);
      return new Response(injectMeta(html, name, data, manifest), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // Plain text - show as landing page
    const text = decoded.replace(/^data:,/, '').replace(/^data:text\/plain,/, '');
    return new Response(textPage(name, decodeURIComponent(text), data), {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  // Raw HTML
  if (decoded.startsWith('<!DOCTYPE') || decoded.startsWith('<html') || decoded.startsWith('<HTML')) {
    return new Response(injectMeta(decoded, name, data, manifest), {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  // Plain text
  return new Response(textPage(name, decoded, data), {
    headers: { 'Content-Type': 'text/html' },
  });
}

// Fetch transaction content from RPC
async function fetchTxContent(rpcUrl, txHash) {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_getTransactionByHash',
        params: [txHash],
        id: 1,
      }),
    });
    const data = await res.json();

    if (!data.result?.input) return null;

    const hex = data.result.input;
    if (!hex || hex === '0x') return null;

    // Decode hex to string
    const bytes = [];
    for (let i = 2; i < hex.length; i += 2) {
      bytes.push(parseInt(hex.substr(i, 2), 16));
    }
    const decoded = new TextDecoder().decode(new Uint8Array(bytes));

    return { hex, decoded };
  } catch (e) {
    console.error('RPC error:', e);
    return null;
  }
}

function decodeDataUri(uri) {
  if (!uri || !uri.startsWith('data:')) return uri;
  const match = uri.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/);
  if (match) {
    if (uri.includes(';base64,')) return atob(match[2]);
    return decodeURIComponent(match[2]);
  }
  return uri;
}

function injectMeta(html, name, data, manifest = null) {
  const hasAbout = manifest?.about;

  const meta = `
<link rel="icon" href="${FAVICON}">
<meta property="og:title" content="${name}">
<meta property="og:url" content="https://${name}.basescriptions.com">
<meta property="og:site_name" content="Basescriptions">
<meta property="og:type" content="website">
`;

  const footer = `
<nav id="basescriptions-footer" style="position:fixed;bottom:0;left:0;right:0;background:#000;border-top:1px solid #222;padding:10px 20px;display:flex;justify-content:center;align-items:center;gap:24px;font-family:system-ui;font-size:13px;z-index:99999">
  ${hasAbout ? '<a href="/about" style="color:#888;text-decoration:none" onmouseover="this.style.color=\'#0052FF\'" onmouseout="this.style.color=\'#888\'">About</a>' : ''}
  <a href="https://basescan.org/tx/${data.creation_tx}" target="_blank" style="color:#555;text-decoration:none;font-size:11px">${data.creation_tx?.slice(0, 12)}...</a>
  <span style="color:#333">|</span>
  <a href="https://basescriptions.com" target="_blank" style="color:#555;text-decoration:none;font-size:11px">basescriptions</a>
</nav>
</body>`;

  let result = html;

  if (result.includes('</head>')) {
    result = result.replace('</head>', meta + '</head>');
  }

  if (result.includes('</body>')) {
    result = result.replace('</body>', footer);
  }

  return result;
}

// ============ Pages ============

function textPage(name, text, data) {
  const short = data.owner?.slice(0, 6) + '...' + data.owner?.slice(-4);
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name}</title>
<link rel="icon" href="${FAVICON}">
<meta property="og:title" content="${name}">
<meta property="og:url" content="https://${name}.basescriptions.com">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:40px}
.c{text-align:center;max-width:600px}
h1{font-size:4rem;margin-bottom:1rem;background:linear-gradient(135deg,#fff,#0052FF);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.owner{font-family:monospace;color:#0052FF;font-size:0.875rem;background:#141414;padding:8px 16px;border-radius:8px;display:inline-block;margin:1rem 0;border:1px solid #2a2a2a}
.meta{display:flex;gap:16px;justify-content:center;margin-top:2rem;font-size:0.75rem}
.meta a{color:#555;text-decoration:none}
.meta a:hover{color:#0052FF}
</style>
</head><body>
<div class="c">
<h1>${escapeHtml(text)}</h1>
<div class="owner">owned by ${short}</div>
<div class="meta">
<a href="https://basescan.org/tx/${data.creation_tx}" target="_blank">BaseScan</a>
<span style="color:#333">|</span>
<a href="https://basescriptions.com" target="_blank">basescriptions.com</a>
</div>
</div>
</body></html>`;
}

function imagePage(name, dataUri, data, pixelArt = false) {
  const short = data.owner?.slice(0, 6) + '...' + data.owner?.slice(-4);
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name}</title>
<link rel="icon" href="${FAVICON}">
<meta property="og:title" content="${name}">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#000;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;padding-bottom:60px}
img{max-width:100%;max-height:80vh;border-radius:8px;${pixelArt ? 'image-rendering:pixelated;image-rendering:crisp-edges;' : ''}}
.meta{position:fixed;bottom:0;left:0;right:0;background:#000;border-top:1px solid #222;padding:12px 20px;display:flex;justify-content:center;gap:24px;font-family:system-ui;font-size:13px}
.meta a{color:#555;text-decoration:none}
.meta a:hover{color:#0052FF}
.owner{color:#0052FF;font-family:monospace}
</style>
</head><body>
<img src="${dataUri}" alt="${name}">
<div class="meta">
<span class="owner">${short}</span>
<a href="https://basescan.org/tx/${data.creation_tx}" target="_blank">BaseScan</a>
<a href="https://basescriptions.com" target="_blank">basescriptions</a>
</div>
</body></html>`;
}

function videoPage(name, dataUri, data) {
  const short = data.owner?.slice(0, 6) + '...' + data.owner?.slice(-4);
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name}</title>
<link rel="icon" href="${FAVICON}">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#000;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;padding-bottom:60px}
video{max-width:100%;max-height:80vh;border-radius:8px}
.meta{position:fixed;bottom:0;left:0;right:0;background:#000;border-top:1px solid #222;padding:12px 20px;display:flex;justify-content:center;gap:24px;font-family:system-ui;font-size:13px}
.meta a{color:#555;text-decoration:none}
.meta a:hover{color:#0052FF}
.owner{color:#0052FF;font-family:monospace}
</style>
</head><body>
<video src="${dataUri}" controls autoplay loop playsinline></video>
<div class="meta">
<span class="owner">${short}</span>
<a href="https://basescan.org/tx/${data.creation_tx}" target="_blank">BaseScan</a>
<a href="https://basescriptions.com" target="_blank">basescriptions</a>
</div>
</body></html>`;
}

function noManifestPage(name, owner) {
  const short = owner.slice(0, 6) + '...' + owner.slice(-4);
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name}</title>
<link rel="icon" href="${FAVICON}">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.c{text-align:center;max-width:500px}
h1{font-size:2.5rem;margin-bottom:0.5rem}
.owner{font-family:monospace;color:#0052FF;font-size:0.875rem;background:#141414;padding:8px 16px;border-radius:8px;display:inline-block;margin:1rem 0;border:1px solid #2a2a2a}
.desc{color:#888;margin:1.5rem 0;line-height:1.6}
.btn{display:inline-block;background:#0052FF;color:#fff;padding:14px 32px;border-radius:9999px;font-weight:700;text-decoration:none}
.btn:hover{opacity:0.9}
</style>
</head><body>
<div class="c">
<h1>${name}</h1>
<div class="owner">owned by ${short}</div>
<p class="desc">This name is claimed but no site manifest is uploaded yet.</p>
<a href="https://basescriptions.com/inscribe.html" class="btn">Upload Content</a>
</div>
</body></html>`;
}

function notFoundPage(name, route) {
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>404 - ${name}</title>
<link rel="icon" href="${FAVICON}">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}
.c{text-align:center;padding:40px}
h1{font-size:4rem;color:#0052FF}
p{color:#888;margin:1rem 0}
code{background:#141414;padding:4px 8px;border-radius:4px;border:1px solid #2a2a2a}
a{color:#0052FF}
</style>
</head><body>
<div class="c">
<h1>404</h1>
<p>Route <code>/${route}</code> not found.</p>
<p><a href="/">← Home</a></p>
</div>
</body></html>`;
}

function availablePage(name) {
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} - Available</title>
<link rel="icon" href="${FAVICON}">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.c{text-align:center;max-width:500px}
h1{font-size:2.5rem;color:#30E000;margin-bottom:0.5rem}
.name{font-family:monospace;background:#141414;padding:12px 20px;border-radius:8px;display:inline-block;margin:1.5rem 0;font-size:1.25rem;border:1px solid #2a2a2a}
.desc{color:#888;margin-bottom:2rem;line-height:1.6}
.btn{display:inline-block;background:#0052FF;color:#fff;padding:14px 32px;border-radius:9999px;font-weight:700;text-decoration:none}
.btn:hover{opacity:0.9}
</style>
</head><body>
<div class="c">
<h1>Available!</h1>
<div class="name">${name}.basescriptions.com</div>
<p class="desc">This name isn't claimed yet. Register it on Base for ~$0.001.</p>
<a href="https://basescriptions.com" class="btn">Claim ${name}</a>
</div>
</body></html>`;
}

function errorPage(msg) {
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Error</title>
<link rel="icon" href="${FAVICON}">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}
.c{text-align:center;padding:40px}
h1{font-size:2rem;color:#ff4444;margin-bottom:1rem}
p{color:#888}
</style>
</head><body>
<div class="c">
<h1>Error</h1>
<p>${escapeHtml(msg)}</p>
</div>
</body></html>`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

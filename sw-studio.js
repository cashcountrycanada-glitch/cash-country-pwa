/**
 * sw-studio.js — Service Worker PWA Cash Country Studio Mobile
 *
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  ARCHITECTURE STOCKAGE — DEUX SYSTÈMES DISTINCTS                ║
 * ║                                                                  ║
 * ║  SW CACHE (ici)     → La PWA elle-même                          ║
 * ║    • index-pwa.html  • babel.min.js  • manifest.json            ║
 * ║    • libs React/lucide/scheduler (esm.sh)                       ║
 * ║    • lame.min.js  • recorder-worklet.js  • env_config.js        ║
 * ║    → Vérifié par CHECK_CACHE / réparé par REPAIR_CACHE          ║
 * ║                                                                  ║
 * ║  INDEXEDDB (StudioOfflineDB.ts) → Les chansons                  ║
 * ║    • Stems audio : inst_<id>, vocal_<id> (ArrayBuffer)          ║
 * ║    • Métadonnées chansons (songs.json)                          ║
 * ║    • Enregistrements vocaux                                      ║
 * ║    → Géré par useStudioOffline.ts via studioOfflineDB            ║
 * ║    → Le SW N'intervient PAS dans le stockage audio              ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const CACHE = 'studio-v195';

const CRITICAL = [
  '/index-pwa.html',
  '/libs/babel.min.js',
  '/manifest.json',
  '/sw-studio.js',
  '/recorder-worklet.js',
  '/env_config.js',
];

const USEFUL = [
  '/lame.min.js',
];

const EXTERNAL_LIBS = [
  'https://unpkg.com/@babel/standalone@7.23.10/babel.min.js',
  'https://esm.sh/react@19.0.0',
  'https://esm.sh/react-dom@19.0.0',
  'https://esm.sh/react-dom@19.0.0/client',
  'https://esm.sh/lucide-react@0.462.0',
  'https://esm.sh/scheduler@0.23.2',
  'https://esm.sh/@google/genai@1.35.0',
  'https://esm.sh/jszip@3.10.1',
  'https://esm.sh/pixi.js@8.1.0',
  'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;700;900&display=swap',
];

const EXTERNAL_DOMAINS = [
  'unpkg.com',
  'esm.sh',
  'cdn.tailwindcss.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

const NO_CORS_PASSTHROUGH = [
  'cdn.tailwindcss.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

const LOCAL_LIBS = [
  '/libs/babel.min.js',
  // Note v35: react/react-dom/lucide-react/scheduler servis par esm.sh — pas depuis /libs/
  // Les fichiers /libs/*.esm.js restent présents mais ne sont plus chargés dynamiquement
];

const SOURCE_EXTENSIONS = /\.(tsx|ts|js|css|json)$/i;

async function broadcast(msg) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach(c => c.postMessage(msg));
}

// ── cacheOne — bypasse l'ancien SW avec URL absolue + no-store ────────────────
// CRITIQUE: sans ça, un ancien SW intercepte les fetch et retourne MODULE_OFFLINE
async function cacheOne(cache, url, mode) {
  try {
    const absoluteUrl = url.startsWith('http') ? url : (self.location.origin + url);
    const fetchOpts = { cache: 'no-store' };
    if (mode) fetchOpts.mode = mode;
    const res = await fetch(absoluteUrl, fetchOpts);
    if (res.ok) {
      const ct = res.headers.get('content-type') || '';
      const isScript = url.match(/\.(js|ts|tsx|css|json)$/i);
      if (isScript && ct.includes('text/html')) {
        console.warn('[SW] Rejeté HTML pour', url, '— Mac éteint ou 404');
        return false;
      }
      await cache.put(url, res);
      return true;
    }
  } catch(e) {
    console.warn('[SW] fetch échoué pour', url, ':', e.message);
  }
  return false;
}

// ── Install ───────────────────────────────────────────────────────────────────
async function cacheOneWithRetry(cache, url, mode, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const ok = await cacheOne(cache, url, mode);
    if (ok) return true;
    if (i < retries - 1) await new Promise(r => setTimeout(r, 500 * (i + 1)));
  }
  console.warn('[SW v40] Échec après', retries, 'tentatives:', url);
  return false;
}

self.addEventListener('install', event => {
  console.log('[SW v40] Installation — esm.sh pour react/lucide/scheduler — fix Identifier already declared');
  event.waitUntil(
    caches.open(CACHE).then(async cache => {
      await Promise.allSettled(CRITICAL.map(u => cacheOneWithRetry(cache, u)));
      await Promise.allSettled(EXTERNAL_LIBS.map(u => cacheOne(cache, u, 'cors')));
      await Promise.allSettled(USEFUL.map(u => cacheOne(cache, u)));
      const babelCached = await cache.match('/libs/babel.min.js');
      console.log('[SW v40] Install terminé — Babel:', babelCached ? '✅' : '❌ ABSENT');
    }).then(() => self.skipWaiting())
  );
});

// ── Activate ──────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;

  if (url.pathname.startsWith('/api/studio/upload') ||
      url.pathname.startsWith('/api/studio/recording')) return;

  if (NO_CORS_PASSTHROUGH.some(d => url.hostname === d || url.hostname.endsWith('.' + d))) {
    return;
  }

  if (EXTERNAL_DOMAINS.some(d => url.hostname === d || url.hostname.endsWith('.' + d))) {
    event.respondWith(
      caches.match(req).then(cached => {
        if (cached) {
          fetch(req, { mode: 'cors' }).then(res => {
            if (res.ok) caches.open(CACHE).then(c => c.put(req, res.clone())).catch(() => {});
          }).catch(() => {});
          return cached;
        }
        return fetch(req, { mode: 'cors' }).then(res => {
          if (res.ok) caches.open(CACHE).then(c => c.put(req, res.clone())).catch(() => {});
          return res;
        }).catch(() => new Response('', { status: 503, headers: { 'Content-Type': 'text/javascript' } }));
      })
    );
    return;
  }

  if (url.pathname.startsWith('/api/media')) {
    event.respondWith(
      caches.match(req).then(cached => {
        if (cached) {
          fetch(req).then(res => {
            if (res.ok) caches.open(CACHE).then(c => c.put(req, res.clone())).catch(() => {});
          }).catch(() => {});
          return cached;
        }
        return fetch(req).then(res => {
          if (res.ok) caches.open(CACHE).then(c => c.put(req, res.clone())).catch(() => {});
          return res;
        }).catch(() => new Response(JSON.stringify({ offline: true }), {
          status: 503, headers: { 'Content-Type': 'application/json' }
        }));
      })
    );
    return;
  }

  if (url.pathname === '/api/songs') {
    event.respondWith(
      Promise.race([
        fetch(req).then(res => {
          if (res.ok) caches.open(CACHE).then(c => c.put(req, res.clone())).catch(() => {});
          return res;
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
      ]).catch(() => caches.match(req).then(c => c || new Response('[]', {
        headers: { 'Content-Type': 'application/json' }
      })))
    );
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req).catch(() => new Response(
        JSON.stringify({ offline: true }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      ))
    );
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index-pwa.html' || url.pathname === '/index.html') {
    event.respondWith(
      caches.match('/index-pwa.html').then(cached => {
        const networkUpdate = fetch('/index-pwa.html').then(res => {
          if (res.ok) caches.open(CACHE).then(c => c.put('/index-pwa.html', res.clone())).catch(() => {});
          return res;
        }).catch(() => null);
        return cached || networkUpdate.then(res => res || new Response(
          '<html><body style="background:#000;color:#fff;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:12px"><p>📵 Hors-ligne</p><p style="font-size:12px">Ouvre l\'app une fois avec le Mac allumé pour activer le mode autonome</p></body></html>',
          { headers: { 'Content-Type': 'text/html' } }
        ));
      })
    );
    return;
  }

  if (SOURCE_EXTENSIONS.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then(async cached => {
        if (cached) {
          fetch(req).then(res => {
            if (res.ok) {
              const ct = res.headers.get('content-type') || '';
              if (!ct.includes('text/html')) {
                caches.open(CACHE).then(c => c.put(req, res.clone())).catch(() => {});
              }
            }
          }).catch(() => {});
          return cached;
        }
        try {
          const res = await fetch(req);
          if (res.ok) {
            const ct = res.headers.get('content-type') || '';
            if (!ct.includes('text/html')) {
              caches.open(CACHE).then(c => c.put(req, res.clone())).catch(() => {});
              return res;
            }
            console.warn('[SW] HTML reçu pour', url.pathname, '— ignoré');
          }
        } catch {}
        if (url.pathname.endsWith('.tsx')) {
          const tsUrl = url.origin + url.pathname.replace(/\.tsx$/, '.ts');
          try {
            const res = await fetch(tsUrl);
            if (res.ok) {
              const ct = res.headers.get('content-type') || '';
              if (!ct.includes('text/html')) {
                caches.open(CACHE).then(c => {
                  c.put(req, res.clone());
                  c.put(tsUrl, res.clone());
                }).catch(() => {});
                return res;
              }
            }
          } catch {}
        }
        console.warn('[SW v40] Module absent hors-ligne:', url.pathname);
        return new Response(
          `throw new Error("MODULE_OFFLINE:${url.pathname}");`,
          { status: 200, headers: { 'Content-Type': 'application/javascript' } }
        );
      })
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(cached => {
      const update = fetch(req).then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(req, res.clone())).catch(() => {});
        return res;
      }).catch(() => null);
      if (cached) return cached;
      return update.then(res => res || caches.match('/index-pwa.html') || caches.match('/index.html'));
    })
  );
});

// ── Messages ──────────────────────────────────────────────────────────────────
self.addEventListener('message', async event => {
  const { type } = event.data || {};

  if (type === 'SKIP_WAITING') { self.skipWaiting(); return; }

  if (type === 'CHECK_CACHE') {
    const cache = await caches.open(CACHE);
    const missing = [];
    for (const url of CRITICAL) {
      const cached = await cache.match(url);
      if (!cached) missing.push(url);
    }
    await broadcast({
      type: 'CACHE_STATUS',
      missing,
      total: CRITICAL.length,
      complete: missing.length === 0,
    });
    return;
  }

  if (type === 'REPAIR_CACHE') {
    const cache = await caches.open(CACHE);
    const missing = [];
    for (const url of [...CRITICAL, ...EXTERNAL_LIBS]) {
      const cached = await cache.match(url);
      if (!cached) missing.push(url);
    }
    await broadcast({ type: 'REPAIR_START', total: missing.length });

    let repaired = 0, failed = 0;
    const failedList = [];
    for (const url of missing) {
      const isExternal = EXTERNAL_DOMAINS.some(d => url.includes(d));
      const ok = await cacheOne(cache, url, isExternal ? 'cors' : undefined);
      if (ok) repaired++;
      else { failed++; failedList.push(url); }
      await broadcast({ type: 'REPAIR_PROGRESS', repaired, total: missing.length });
    }

    await broadcast({
      type: 'REPAIR_DONE',
      repaired,
      failed,
      failedList,
      complete: failed === 0,
    });
    return;
  }

  // NOTE: Le stockage audio des chansons est géré par IndexedDB (StudioOfflineDB.ts)
  // via useStudioOffline.ts — le SW ne gère PAS le cache des chansons.
});

/**
 * sw-studio.js v11 — Service Worker auto-réparant Cash Country Studio Mobile
 *
 * ARCHITECTURE v11 :
 * - Install NON-BLOQUANT : skipWaiting même si cache incomplet (Mac éteint OK)
 * - Lazy Cache : chaque fetch réseau réussi est mis en cache automatiquement
 * - CHECK_CACHE : le kernel peut demander quels fichiers CRITICAL manquent
 * - REPAIR_CACHE : re-télécharge les manquants quand Mac disponible
 * - ?mode=studio : pathname "/" → toujours index.html (SPA routing correct)
 * - MODULE_OFFLINE : erreur claire si module absent hors-ligne (pas de loop)
 */

const CACHE = 'studio-v30-cors'; // v30: garde content-type — rejette HTML pour JS (Mac éteint)

const CRITICAL = [
  '/index-pwa.html',  // PWA iOS — fichier principal pour iPhone
  // ── Libs locales — autonomie complète sans CDN ─────────────────────────
  '/libs/babel.min.js',
  '/libs/react.esm.js',
  '/libs/react-dom.esm.js',
  '/libs/react-dom-client.esm.js',
  '/libs/lucide-react.esm.js',
  '/libs/scheduler.esm.js',
  '/index.html',      // Electron — servi par loadFile()
  '/index.css',
  '/env_config.js',
  '/manifest.json',
  '/index.tsx',
  '/types.ts',
  '/services/StudioService.ts',
  '/services/StudioOfflineDB.ts',
  '/services/db.ts',
  '/components/StudioMobile.tsx',
  '/components/MasteringEngine.tsx',        // copie originale (Mac)
  '/components/CompEditor.tsx',             // copie originale (Mac)
  '/components/StudioMobile/CompEditor.tsx',      // copie locale StudioMobile (iPhone)
  '/components/StudioMobile/MasteringEngine.tsx', // copie locale StudioMobile (iPhone)
  '/components/StudioMobile/studio.types.ts',
  '/components/StudioMobile/useStudioAudio.ts',
  '/components/StudioMobile/useStudioOffline.ts',
  '/components/StudioMobile/useStudioRecorder.ts',
  '/components/StudioMobile/RecordScreen.tsx',
  '/components/StudioMobile/MixerScreen.tsx',
  '/components/StudioMobile/SongSelector.tsx',
  '/components/StudioMobile/RecordingsList.tsx',
  '/components/StudioMobile/RecordingCard.tsx',
  '/components/StudioMobile/TrackCard.tsx',
  '/components/StudioMobile/VUMeter.tsx',
  '/components/StudioMobile/WaveformBar.tsx',
  '/recorder-worklet.js',
];

const USEFUL = [
  '/index-pwa.html',  // alias pour / sur PWA
  '/lame.min.js',
  '/services/ai.ts',
  '/services/environment.ts',
  '/components/StudioInbox.tsx',
];

const EXTERNAL_LIBS = [
  // Babel/React/Lucide sont maintenant servis localement via /libs/
  // Ces CDN restent en cache comme FALLBACK si /libs/ est indisponible.
  'https://unpkg.com/@babel/standalone@7.23.10/babel.min.js',
  'https://cdn.tailwindcss.com',
  'https://esm.sh/react@19.0.0',
  'https://esm.sh/react-dom@19.0.0',
  'https://esm.sh/react-dom@19.0.0/client',
  'https://esm.sh/lucide-react@0.462.0',
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

// CDN qui ne supportent PAS CORS — fetch en mode 'no-cors' (réponse opaque)
// On ne peut pas mettre en cache proprement, on laisse passer sans interception.
const NO_CORS_PASSTHROUGH = [
  'cdn.tailwindcss.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

// Libs locales — servis par le Mac, cachés comme assets critiques
const LOCAL_LIBS = [
  '/libs/babel.min.js',
  '/libs/react.esm.js',
  '/libs/react-dom.esm.js',
  '/libs/react-dom-client.esm.js',
  '/libs/lucide-react.esm.js',
  '/libs/scheduler.esm.js',
];

const SOURCE_EXTENSIONS = /\.(tsx|ts|js|css|json)$/i;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function broadcast(msg) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach(c => c.postMessage(msg));
}

async function cacheOne(cache, url, mode) {
  try {
    const res = await fetch(url, mode ? { mode } : undefined);
    if (res.ok) {
      // Ne jamais cacher du HTML à la place d'un fichier JS/TS/CSS
      // (Mac éteint → Express Railway retourne 404 HTML pour /libs/)
      const ct = res.headers.get('content-type') || '';
      const isScript = url.match(/\.(js|ts|tsx|css|json)$/i);
      if (isScript && ct.includes('text/html')) {
        console.warn('[SW] Rejeté HTML pour', url, '— Mac éteint ou 404');
        return false;
      }
      await cache.put(url, res);
      return true;
    }
  } catch {}
  return false;
}

// ── Install — NON-BLOQUANT ────────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW v11] Installation...');
  event.waitUntil(
    caches.open(CACHE).then(async cache => {
      await Promise.allSettled(CRITICAL.map(u => cacheOne(cache, u)));
      await Promise.allSettled(EXTERNAL_LIBS.map(u => cacheOne(cache, u, 'cors')));
      await Promise.allSettled(USEFUL.map(u => cacheOne(cache, u)));
      console.log('[SW v11] Install terminé (partiel OK si Mac éteint)');
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

  // CDN no-cors (Tailwind CDN etc.) — laisser passer sans interception SW
  // Ces CDN ne supportent pas CORS, le SW ne peut pas les mettre en cache proprement.
  if (NO_CORS_PASSTHROUGH.some(d => url.hostname === d || url.hostname.endsWith('.' + d))) {
    return; // le navigateur gère directement
  }

  // CDN externes — Cache First + lazy cache
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

  // /api/media — Cache First pour les fichiers audio
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

  // /api/songs — Network First avec timeout 3s + fallback cache
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

  // Autres /api/ — Network Only
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req).catch(() => new Response(
        JSON.stringify({ offline: true }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      ))
    );
    return;
  }

  // Page principale PWA — sert index-pwa.html en cache-first
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

  // Fichiers source — Cache First + lazy cache + erreur claire si absent hors-ligne
  if (SOURCE_EXTENSIONS.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then(async cached => {
        if (cached) {
          // Lazy update en arrière-plan — mais rejeter si le serveur retourne du HTML (404 Mac)
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
            // Ne pas cacher du HTML pour un fichier JS/TS/CSS (Mac éteint → 404 HTML)
            if (!ct.includes('text/html')) {
              caches.open(CACHE).then(c => c.put(req, res.clone())).catch(() => {});
              return res;
            }
            console.warn('[SW] HTML reçu pour', url.pathname, '— ignoré');
          }
        } catch {}
        // Fallback .tsx → .ts : si le fichier .tsx n'existe pas, essayer .ts
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
        // Module absent du cache ET hors-ligne — erreur JS claire pour le kernel
        console.warn('[SW v29] Module absent hors-ligne:', url.pathname);
        return new Response(
          `throw new Error("MODULE_OFFLINE:${url.pathname}");`,
          { status: 200, headers: { 'Content-Type': 'application/javascript' } }
        );
      })
    );
    return;
  }

  // Tout le reste — Cache First, fallback index.html
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

  // CHECK_CACHE — liste les fichiers CRITICAL absents
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

  // REPAIR_CACHE — re-télécharge les manquants (appeler quand Mac disponible)
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

  // CACHE_SONG — mise en cache d'une chanson
  if (type === 'CACHE_SONG') {
    const { songId, songTitle, urls = [] } = event.data;
    const cache = await caches.open(CACHE);
    await Promise.allSettled(['/api/songs', ...urls].map(u => cacheOne(cache, u)));
    await broadcast({ type: 'SONG_CACHED', songId, songTitle });
    return;
  }
});

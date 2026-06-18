import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import StudioMobile from './components/StudioMobile';

// Sur Railway, App.tsx et AudienceMode n'existent pas - on détecte le mode ICI
// pour ne jamais importer App (qui causait MODULE_OFFLINE sur Railway).
const _rh = window.location.hash.replace('#','').trim();
const _rp = new URLSearchParams(window.location.search);
const _isStudio   = _rh === 'studio'   || _rp.get('mode') === 'studio';
const _isAudience = _rh === 'audience' || _rp.get('mode') === 'audience';

// Wrapper qui charge les songs depuis /api/songs pour StudioMobile
function StudioMobileWithSongs() {
  const [songs, setSongs] = useState<any[]>([]);
  useEffect(() => {
    fetch('/api/songs').then(r => r.ok ? r.json() : []).then(s => {
      if (Array.isArray(s)) setSongs(s);
    }).catch(() => {});
  }, []);
  return <StudioMobile songs={songs} />;
}

const rootElement = document.getElementById('root');
if (rootElement) {
  const root = createRoot(rootElement);

  // ── Filet de sécurité global ──────────────────────────────────────────────
  // Les Error Boundaries React ne catchent QUE les erreurs de rendu synchrone.
  // Une exception dans un useEffect, un .then(), ou un callback async
  // (ex: décodage audio, IndexedDB) ne sera JAMAIS catchée par un boundary —
  // elle remonte au navigateur et peut laisser un écran vide/noir sans trace
  // visible. On logge ici dans localStorage pour pouvoir diagnostiquer
  // même après un crash qui a fait disparaître l'UI (DebugPanel inclus).
  const logCrash = (label: string, err: any) => {
    try {
      const msg = `[${new Date().toISOString().slice(11,19)}] ${label}: ${err?.message || err?.reason?.message || String(err?.reason ?? err)}`;
      const existing = JSON.parse(localStorage.getItem('cc_crash_log') || '[]');
      existing.unshift(msg);
      localStorage.setItem('cc_crash_log', JSON.stringify(existing.slice(0, 10)));
      console.error('[CRASH]', msg, err);
    } catch {}
  };
  window.addEventListener('error', (e) => logCrash('window.onerror', e.error || e));
  window.addEventListener('unhandledrejection', (e) => logCrash('unhandledrejection', e));

  root.render(
    <React.StrictMode>
      <StudioMobileWithSongs />
    </React.StrictMode>
  );
}
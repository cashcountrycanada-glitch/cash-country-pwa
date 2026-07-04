import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import StudioMobile from './components/StudioMobile';

const _rh = window.location.hash.replace('#','').trim();
const _rp = new URLSearchParams(window.location.search);
const _isStudio   = _rh === 'studio'   || _rp.get('mode') === 'studio';
const _isAudience = _rh === 'audience' || _rp.get('mode') === 'audience';

// ── Filet de sécurité global — capture TOUT crash avant que l'UI disparaisse ──
const logCrash = (label: string, err: any) => {
  try {
    const msg = `[${new Date().toISOString().slice(11,19)}] 💥 ${label}: ${err?.message || err?.reason?.message || String(err?.reason ?? err)}`;
    // 1. localStorage — survit au crash UI
    const existing = JSON.parse(localStorage.getItem('cc_crash_log') || '[]');
    existing.unshift(msg);
    localStorage.setItem('cc_crash_log', JSON.stringify(existing.slice(0, 20)));
    // 2. __addLog — visible dans le DebugPanel si l'UI est encore là
    (window as any).__addLog?.(msg);
    console.error('[CRASH]', msg, err);
  } catch {}
};

window.onerror = (message, source, lineno, colno, error) => {
  logCrash(`onerror ${source?.split('/').pop()}:${lineno}`, error || message);
  return false;
};

window.addEventListener('unhandledrejection', (e) => {
  logCrash('unhandledrejection', e);
});

// Wrapper qui charge les songs depuis /api/songs pour StudioMobile
function StudioMobileWithSongs() {
  const [songs, setSongs] = useState<any[]>([]);

  // Afficher les crash logs précédents dans le DebugPanel au démarrage
  useEffect(() => {
    try {
      const prev = JSON.parse(localStorage.getItem('cc_crash_log') || '[]') as string[];
      if (prev.length > 0) {
        setTimeout(() => {
          prev.forEach(msg => (window as any).__addLog?.(msg));
          // Vider après affichage
          localStorage.removeItem('cc_crash_log');
        }, 2000); // Attendre que __addLog soit initialisé
      }
    } catch {}
  }, []);

  // FIX OOM (v7.6.351) : /api/songs renvoie tout (~11 Mo : lyrics + pochettes
  // base64 des 166 chansons), et court-circuitait le fix OOM de StudioMobile.tsx
  // via propSongs (priorité sur apiSongs). On charge désormais l'index léger.
  useEffect(() => {
    fetch('/api/songs/list').then(r => r.ok ? r.json() : []).then(s => {
      if (Array.isArray(s)) setSongs(s);
    }).catch(() => {});
  }, []);
  return <StudioMobile songs={songs} />;
}

const rootElement = document.getElementById('root');
if (rootElement) {
  const root = createRoot(rootElement);
  root.render(
    <React.StrictMode>
      <StudioMobileWithSongs />
    </React.StrictMode>
  );
}
import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import StudioMobile from './components/StudioMobile';

// ── Filet de sécurité RACINE ────────────────────────────────────────────────
// ScreenErrorBoundary (dans StudioMobile.tsx) protège chaque écran, mais si une
// exception survient PENDANT que StudioMobile construit ses props/JSX (avant
// même qu'un boundary enfant ne soit monté), React démonte TOUT l'arbre — et
// comme rien n'entourait StudioMobile ici, `root` se retrouvait totalement
// vide : écran noir, sans aucun message, impossible à diagnostiquer sans
// rebrancher un débogueur. Ce boundary racine attrape ce cas et affiche un
// écran de secours exploitable, quel que soit l'endroit précis du crash.
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; errorMsg: string }
> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, errorMsg: '' };
  }
  static getDerivedStateFromError(error: any) {
    return { hasError: true, errorMsg: error?.message || String(error) };
  }
  componentDidCatch(error: any, info: any) {
    console.error('[RootErrorBoundary] Crash application:', error, info);
    try {
      const msg = `[${new Date().toISOString().slice(11, 19)}] RootErrorBoundary: ${error?.message || error}`;
      const existing = JSON.parse(localStorage.getItem('cc_crash_log') || '[]');
      existing.unshift(msg);
      localStorage.setItem('cc_crash_log', JSON.stringify(existing.slice(0, 10)));
    } catch {}
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh', background: '#020202', color: '#fff',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', gap: 16, padding: '0 24px', textAlign: 'center',
          fontFamily: 'sans-serif',
        }}>
          <p style={{ fontSize: 40 }}>⚠️</p>
          <p style={{ fontWeight: 900, fontSize: 20, letterSpacing: 2, textTransform: 'uppercase' }}>
            Application indisponible
          </p>
          <p style={{ fontSize: 11, color: '#71717a', maxWidth: 320 }}>
            Une erreur inattendue a stoppé l'appli. Tes prises et projets sont sauvegardés localement.
          </p>
          <p style={{ fontSize: 9, color: '#3f3f46', fontFamily: 'monospace', maxWidth: 320, wordBreak: 'break-all' }}>
            {this.state.errorMsg}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '12px 24px', background: '#dc2626', borderRadius: 16, border: 'none',
              color: '#fff', fontWeight: 900, fontSize: 13, letterSpacing: 2, textTransform: 'uppercase',
              marginTop: 8,
            }}>
            ↻ Relancer
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

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
  const logCrash = (label: string, err: any, e?: any) => {
    try {
      const baseMsg = err?.message || err?.reason?.message || String(err?.reason ?? err);
      // FIX diagnostic "Script error." (v7.6.410) : ce message générique sans
      // fichier/ligne apparaît quand l'erreur vient d'un script cross-origin —
      // le navigateur masque les détails par sécurité. On capture ici tout ce
      // qui est encore accessible (fichier, ligne, colonne, stack) pour ne
      // rien perdre quand c'est disponible, même si "Script error." lui-même
      // reste parfois impossible à détailler davantage côté JS.
      const loc = e && (e.filename || e.lineno) ? ` @ ${e.filename || '?'}:${e.lineno ?? '?'}:${e.colno ?? '?'}` : '';
      const stack = err?.stack ? ` | stack: ${String(err.stack).slice(0, 200)}` : '';
      const msg = `[${new Date().toISOString().slice(11,19)}] ${label}: ${baseMsg}${loc}${stack}`;
      const existing = JSON.parse(localStorage.getItem('cc_crash_log') || '[]');
      existing.unshift(msg);
      localStorage.setItem('cc_crash_log', JSON.stringify(existing.slice(0, 10)));
      console.error('[CRASH]', msg, err);
    } catch {}
  };
  window.addEventListener('error', (e) => logCrash('window.onerror', e.error || e, e));
  window.addEventListener('unhandledrejection', (e) => logCrash('unhandledrejection', e));

  root.render(
    <React.StrictMode>
      <RootErrorBoundary>
        <StudioMobileWithSongs />
      </RootErrorBoundary>
    </React.StrictMode>
  );
}
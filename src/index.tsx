import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import StudioMobile from './components/StudioMobile';
import MasteringEngine from './components/StudioMobile/MasteringEngine';
import { studioOfflineDB } from './services/StudioOfflineDB';

const _rh = window.location.hash.replace('#','').trim();
const _rp = new URLSearchParams(window.location.search);
const _isStudio   = _rh === 'studio'   || _rp.get('mode') === 'studio';
const _isAudience = _rh === 'audience' || _rp.get('mode') === 'audience';

// ── Filet de sécurité global — capture TOUT crash avant que l'UI disparaisse ──
// FIX diagnostic "Script error." (v7.6.420) : capture aussi fichier/ligne/
// colonne/stack quand le navigateur les rend disponibles (pas toujours le cas
// pour les erreurs cross-origin masquées, mais on ne perd rien qui existe).
const logCrash = (label: string, err: any, e?: any) => {
  try {
    const baseMsg = err?.message || err?.reason?.message || String(err?.reason ?? err);
    const loc = e && (e.filename || e.lineno) ? ` @ ${e.filename || '?'}:${e.lineno ?? '?'}:${e.colno ?? '?'}` : '';
    const stack = err?.stack ? ` | stack: ${String(err.stack).slice(0, 200)}` : '';
    const msg = `[${new Date().toISOString().slice(11,19)}] 💥 ${label}: ${baseMsg}${loc}${stack}`;
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
  logCrash(`onerror ${source?.split('/').pop()}:${lineno}`, error || message, { filename: source, lineno, colno });
  return false;
};

window.addEventListener('unhandledrejection', (e) => {
  logCrash('unhandledrejection', e);
});

// ── Filet de sécurité RACINE ────────────────────────────────────────────────
// ScreenErrorBoundary (dans StudioMobile.tsx) protège chaque écran, mais si une
// exception survient PENDANT que StudioMobile construit ses props/JSX (avant
// même qu'un boundary enfant ne soit monté), React démonte TOUT l'arbre — et
// sans rien autour de StudioMobile ici, `root` se retrouvait totalement vide :
// écran noir, sans aucun message, impossible à diagnostiquer. Ce boundary
// racine attrape ce cas et affiche un écran de secours exploitable.
// FIX CRITIQUE (v7.6.420) : ce fichier (src/index.tsx) est le VRAI point
// d'entrée compilé par build.js — un index.tsx à la racine du projet existait
// en parallèle et avait reçu tous les correctifs précédents (RootErrorBoundary,
// retrait de StrictMode, page de masterisation isolée) SANS JAMAIS être
// réellement inclus dans aucun build testé. Ce fichier-ci est maintenant la
// version fusionnée et définitive — le doublon à la racine a été supprimé.
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
    logCrash('RootErrorBoundary', error);
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

// Wrapper qui charge les songs depuis /api/songs/list pour StudioMobile
function StudioMobileWithSongs() {
  const [songs, setSongs] = useState<any[]>([]);

  // Afficher les crash logs précédents dans le DebugPanel au démarrage
  useEffect(() => {
    try {
      const prev = JSON.parse(localStorage.getItem('cc_crash_log') || '[]') as string[];
      if (prev.length > 0) {
        setTimeout(() => {
          prev.forEach(msg => (window as any).__addLog?.(msg));
          localStorage.removeItem('cc_crash_log');
        }, 2000);
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

// ── ÉCRAN MASTERING STANDALONE (v7.6.420) ───────────────────────────────────
// Nouvelle approche pour le bug "écran noir" sur Masteriser & Exporter : au
// lieu de basculer d'écran DANS le même arbre React que le mixeur (avec des
// dizaines de hooks/contextes audio déjà actifs, où un crash invisible
// survenait systématiquement sans laisser de trace exploitable), cet écran
// se charge sur une page FRAÎCHE et isolée. Le mixeur sauvegarde le mix en
// stockage permanent puis navigue ici via URL (?master=...) — cette page
// démarre à zéro : aucun état hérité, aucun risque d'interférence.
function MasteringStandalone({ projectId, songId, hasInst, instOffsetMs }: { projectId: string; songId: string; hasInst: boolean; instOffsetMs: number }) {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; vocalBlob?: Blob; instBlob?: Blob | null; songTitle?: string; error?: string }>({ status: 'loading' });

  useEffect(() => {
    (async () => {
      try {
        const vocalBlob = await studioOfflineDB.getAudio(`master_pending_${projectId}`);
        if (!vocalBlob || vocalBlob.size < 100) {
          setState({ status: 'error', error: "Le mix n'a pas été trouvé. Retourne au mixeur et relance le mixage." });
          return;
        }
        const instBlob = hasInst ? await studioOfflineDB.getAudio(`master_pending_inst_${projectId}`).catch(() => null) : null;
        let songTitle = 'Chanson';
        try {
          const r = await fetch(`/api/songs/${encodeURIComponent(songId)}`);
          if (r.ok) { const s = await r.json(); songTitle = s?.title || s?.name || songTitle; }
        } catch {}
        setState({ status: 'ready', vocalBlob, instBlob, songTitle });
      } catch (e: any) {
        setState({ status: 'error', error: e?.message || String(e) });
      }
    })();
  }, [projectId, songId, hasInst]);

  const goBack = () => { window.location.href = window.location.origin + window.location.pathname; };

  if (state.status === 'loading') {
    return (
      <div style={{ minHeight: '100vh', background: '#020202', color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, fontFamily: 'sans-serif' }}>
        <p style={{ fontSize: 32 }}>🎛️</p>
        <p style={{ fontSize: 13, color: '#a1a1aa', letterSpacing: 1 }}>Chargement du mix…</p>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div style={{ minHeight: '100vh', background: '#020202', color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: '0 24px', textAlign: 'center', fontFamily: 'sans-serif' }}>
        <p style={{ fontSize: 40 }}>⚠️</p>
        <p style={{ fontSize: 13, color: '#a1a1aa', maxWidth: 320 }}>{state.error}</p>
        <button onClick={goBack} style={{ padding: '12px 24px', background: '#dc2626', borderRadius: 16, border: 'none', color: '#fff', fontWeight: 900, fontSize: 13, letterSpacing: 2, textTransform: 'uppercase' }}>
          ← Retour au mixeur
        </button>
      </div>
    );
  }
  return (
    <MasteringEngine
      vocalBlob={state.vocalBlob!}
      instBlob={state.instBlob ?? null}
      instOffsetMs={instOffsetMs}
      songTitle={state.songTitle || 'Chanson'}
      songId={songId}
      onBack={goBack}
      onStemReady={async () => {}}
      isOnline={navigator.onLine}
    />
  );
}

const rootElement = document.getElementById('root');
if (rootElement) {
  const root = createRoot(rootElement);

  const _masterParams = new URLSearchParams(window.location.search);
  const _masterProjectId = _masterParams.get('master');
  const _masterSongId = _masterParams.get('songId');
  const _masterHasInst = _masterParams.get('hasInst') === '1';
  const _masterInstOffsetMs = Number(_masterParams.get('instOffsetMs') || '0') || 0;

  // FIX CRASH ÉCRAN NOIR (v7.6.420) : <React.StrictMode> était encore actif ici
  // (ce fichier n'avait jamais reçu ce correctif car un doublon à la racine du
  // projet recevait les modifications à sa place). StrictMode double les rendus
  // et les cycles d'effets — un outil de développement, jamais destiné à une
  // version livrée aux utilisateurs. Retiré définitivement.
  root.render(
    <RootErrorBoundary>
      {_masterProjectId && _masterSongId
        ? <MasteringStandalone projectId={_masterProjectId} songId={_masterSongId} hasInst={_masterHasInst} instOffsetMs={_masterInstOffsetMs} />
        : <StudioMobileWithSongs />}
    </RootErrorBoundary>
  );
}

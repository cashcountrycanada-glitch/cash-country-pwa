/**
StudioMobile.tsx — Orchestrateur v7.4
CORRECTIFS MAJEURS :
1. Warm-up : Crée UN SEUL AudioContext global (__warmContext), le démarre, 
   demande la permission, stoppe les tracks MAIS GARDE LE CONTEXTE OUVERT.
2. Plus de double upload dans handleStemReady.
3. Capture sèche forcée via recorder.
*/
import React, { useState, useEffect, useRef } from 'react';
import { studioService, ReverbType, MobileRecording, TrackProject, Take } from '../services/StudioService';
import { studioOfflineDB } from '../services/StudioOfflineDB';
import { Song, SongType } from '../types';
import { Screen, TRACK_PRESETS, TrackPreset } from './StudioMobile/studio.types';
import { useStudioAudio }    from './StudioMobile/useStudioAudio';
import { useStudioOffline }  from './StudioMobile/useStudioOffline';
import { useStudioRecorder } from './StudioMobile/useStudioRecorder';
import SongSelector    from './StudioMobile/SongSelector';
import RecordScreen    from './StudioMobile/RecordScreen';
import MixerScreen     from './StudioMobile/MixerScreen';
import RecordingsList  from './StudioMobile/RecordingsList';
import CompEditor      from './StudioMobile/CompEditor';
import MasteringEngine, { MasteringProps } from './StudioMobile/MasteringEngine';

interface Props { songs?: Song[]; }
const BUILD_VERSION = 'v7.6.349';

function ModeToggleButton() {
  const [autonomous, setAutonomous] = React.useState<boolean>(
    () => localStorage.getItem('cc_force_autonomous') === '1'
  );

  // Synchroniser si MacUrlConfig change le flag dans le même onglet
  React.useEffect(() => {
    const sync = () => setAutonomous(localStorage.getItem('cc_force_autonomous') === '1');
    window.addEventListener('cc_mode_changed', sync);
    return () => window.removeEventListener('cc_mode_changed', sync);
  }, []);

  const toggle = () => {
    if (!autonomous) {
      (window as any).__CC_MAC_URL_SAVED = (window as any).__CC_MAC_URL || localStorage.getItem('cc_mac_url') || '';
      (window as any).__CC_MAC_URL = '';
      localStorage.setItem('cc_force_autonomous', '1');
      window.dispatchEvent(new Event('cc_mode_changed'));
      window.location.reload();
    } else {
      localStorage.removeItem('cc_force_autonomous');
      const saved = (window as any).__CC_MAC_URL_SAVED || localStorage.getItem('cc_mac_url') || '';
      if (saved) localStorage.setItem('cc_mac_url', saved);
      window.dispatchEvent(new Event('cc_mode_changed'));
      window.location.reload();
    }
  };

  return (
    <button
      onClick={toggle}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 12px', borderRadius: 10, cursor: 'pointer',
        background: autonomous ? '#1a1a2e' : '#1e3a1e',
        border: `1.5px solid ${autonomous ? '#3b82f6' : '#16a34a'}`,
        transition: 'all 0.2s',
      }}>
      <span style={{ fontSize: 13 }}>{autonomous ? '📡' : '💻'}</span>
      <span style={{
        fontSize: 10, fontWeight: 900, textTransform: 'uppercase', letterSpacing: 1,
        color: autonomous ? '#60a5fa' : '#4ade80',
      }}>
        {autonomous ? 'Autonome' : 'Mac'}
      </span>
    </button>
  );
}

function DebugPanel({ debugLog, onClear }: { debugLog: string[]; onClear: () => void }) {
  const [minimized, setMinimized] = React.useState(true);
  const ctxRate = (window as any).__warmContext?.sampleRate;
  const ctxState = (window as any).__warmContext?.state;
  const rateColor = !ctxRate ? '#71717a' : ctxRate >= 44000 ? '#22c55e' : '#f59e0b';
  return (
    <div style={{
      position:'fixed', bottom:0, left:0, right:0, zIndex:9999,
      background:'rgba(0,0,0,0.92)', padding:'8px',
      maxHeight: minimized ? 'auto' : '40vh',
      overflowY: minimized ? 'hidden' : 'auto',
    }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: minimized ? 0 : 4 }}>
        <div style={{ display:'flex', alignItems:'center', gap: 8 }}>
          <span style={{ color:'#f59e0b', fontSize:13, fontWeight:900, letterSpacing:2 }}>
            {BUILD_VERSION}
          </span>
          <ModeToggleButton />
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          {ctxRate && (
            <span style={{ color: rateColor, fontSize: 9, fontWeight: 900, fontFamily: 'monospace' }}>
              🎵 {ctxRate}Hz{ctxState === 'suspended' ? ' ⏸' : ''}
            </span>
          )}
          <span style={{ color:'#facc15', fontSize:9, fontWeight:900, textTransform:'uppercase' }}>
            {minimized ? `LOG(${debugLog.length})` : 'DEBUG'}
          </span>
          <button
            onClick={() => setMinimized(m => !m)}
            style={{ color:'#a1a1aa', fontSize:11, background:'rgba(255,255,255,0.08)', border:'1px solid #3f3f46', borderRadius:6, padding:'4px 10px', minWidth:36, minHeight:28 }}>
            {minimized ? '▲' : '▼'}
          </button>
          {debugLog.length > 0 && (
            <button onClick={onClear} style={{ color:'#ef4444', fontSize:9, background:'none', border:'none' }}>
              CLEAR
            </button>
          )}
        </div>
      </div>
      {!minimized && debugLog.map((l,i) => (
        <div key={i} style={{
          fontFamily:'monospace', fontSize:9,
          color: l.includes('❌') || l.includes('ERREUR') || l.includes('ERROR') || l.includes('fail') ? '#ef4444'
            : l.includes('✅') || l.includes('SUCCÈS') || l.includes('OK') ? '#22c55e'
            : l.includes('⚠️') || l.includes('⚠') || l.includes('WARN') ? '#f59e0b'
            : l.includes('▶') || l.includes('play') ? '#60a5fa'
            : '#a1a1aa',
          borderBottom:'1px solid #1a1a1a', paddingBottom:2, marginBottom:2,
          wordBreak: 'break-all',
        }}>{l}</div>
      ))}
    </div>
  );
}

// ── ScreenErrorBoundary ─────────────────────────────────────────────────────
// Avant ce correctif : un crash de rendu dans n'importe quel écran (Comp,
// Mixer, etc.) démontait tout l'arbre React → écran complètement NOIR sans
// aucun message, impossible à diagnostiquer pour l'utilisateur.
// Maintenant : on catch l'erreur et on affiche un écran de secours avec un
// bouton "Retour" — au minimum l'app reste utilisable et le bug est visible.
class ScreenErrorBoundary extends React.Component<
  { children: React.ReactNode; onReset: () => void; screenName: string },
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
    console.error(`[ScreenErrorBoundary] Crash dans l'écran "${this.props.screenName}":`, error, info);
    try { (window as any).__addLog?.(`❌ CRASH écran "${this.props.screenName}": ${error?.message || error}`); } catch {}
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#020202] text-white flex flex-col items-center justify-center gap-4 px-6">
          <p className="text-[40px]">⚠️</p>
          <p className="font-bebas text-xl tracking-widest text-center">ÉCRAN INDISPONIBLE</p>
          <p className="text-[11px] text-zinc-500 text-center max-w-xs">
            Une erreur est survenue dans l'écran "{this.props.screenName}". Tes prises et projets sont sauvegardés — tu peux revenir en arrière sans rien perdre.
          </p>
          <p className="text-[9px] text-zinc-700 font-mono text-center max-w-xs break-all">
            {this.state.errorMsg}
          </p>
          <button
            onClick={() => { this.setState({ hasError: false, errorMsg: '' }); this.props.onReset(); }}
            className="px-6 py-3 bg-red-600 rounded-2xl font-black text-[13px] uppercase tracking-widest active:scale-95 transition-all mt-2">
            ← Retour
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function StudioMobile({ songs: propSongs = [] }: Props) {
  const [screen, setScreen]     = useState<Screen>('songs');
  const [selected, setSelected] = useState<Song | null>(null);
  const [project, setProject]   = useState<TrackProject | null>(null);
  const [apiSongs, setApiSongs] = useState<Song[]>([]);
  const [recordings, setRecordings] = useState<MobileRecording[]>([]);
  const [currentPreset, setCurrentPreset] = useState<TrackPreset>(TRACK_PRESETS[0]);
  // Reverb par défaut : 'hall' (grande salle) plutôt que 'room' (petite pièce).
  // 'hall' a la traîne la plus longue (2.2s) et le decay le plus doux (2.8) des
  // trois types — donne l'impression de chanter dans un grand espace, ce qui
  // aide à projeter naturellement sans forcer la voix, même en chantant dans
  // un environnement réel petit et sec (ex: voiture).
  const [reverb, setReverb] = useState<ReverbType>('hall');
  const [showLyrics, setShowLyrics] = useState(true);
  const [isMixing, setIsMixing] = useState(false);
  const [mixProgress, setMixProgress] = useState(0);
  const [mixLabel, setMixLabel]     = useState('');
  const [mixDone, setMixDone] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [uploadDone, setUploadDone] = useState<string | null>(null);
  const [compTakes, setCompTakes] = useState<Take[]>([]);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const isPreviewingRef = useRef(false);
  const [slotGuideActive, setSlotGuideActive] = useState<'A'|'B'|'C'|null>(null);
  const [takeSlot, setTakeSlot] = useState<'A' | 'B' | 'C'>('A');
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [masterVocalBlob, setMasterVocalBlob] = useState<Blob | null>(null);
  const [masterInstBlob, setMasterInstBlob] = useState<Blob | null>(null);

  const addLog = (msg: string) => {
    const t = new Date().toISOString().slice(11,19);
    setDebugLog(prev => [`[${t}] ${msg}`, ...prev].slice(0, 20));
  };
  (window as any).__addLog = addLog;

  // Rejouer les crashs survenus avant ce rechargement (capturés par le filet
  // global window.onerror / unhandledrejection dans index.tsx). Permet de
  // diagnostiquer un écran noir même après avoir relancé l'app, puisque
  // le DebugPanel disparaissait avec le reste de l'UI au moment du crash.
  useEffect(() => {
    try {
      const crashes = JSON.parse(localStorage.getItem('cc_crash_log') || '[]');
      if (crashes.length > 0) {
        crashes.slice(0, 5).forEach((c: string) => addLog(`💥 ${c}`));
        localStorage.removeItem('cc_crash_log');
      }
    } catch {}
  }, []);

  // Pré-initialiser IndexedDB dès le premier render
  // Lister les clés après 2s pour diagnostic — sans bloquer l'init
  useEffect(() => {
    studioOfflineDB.init().then(() => {
      setTimeout(() => {
        studioOfflineDB.listAllAudioKeys().then(keys => {
          const dbLog = (window as any).__addLog;
          if (keys.length === 0) {
            dbLog?.('[DB] ⚠️ IndexedDB VIDE — aucun stem stocké');
          } else {
            const vides = keys.filter(k => k.includes('⚠️VIDE'));
            const ok    = keys.filter(k => !k.includes('⚠️VIDE'));
            dbLog?.(`[DB] 📦 ${ok.length} stems OK, ${vides.length} purgés par iOS`);
            if (vides.length > 0) vides.forEach(k => dbLog?.(`  ❌ ${k}`));
          }
        }).catch(() => {});
      }, 2000); // délai pour ne pas interférer avec le chargement initial
    }).catch(() => {});
  }, []);

  // Forcer la mise à jour du SW immédiatement sans attendre fermeture des onglets
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    // Recharger la page quand un nouveau SW prend le contrôle
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      window.location.reload();
    });
    navigator.serviceWorker.ready.then(reg => {
      const activate = (sw: ServiceWorker) => {
        sw.postMessage({ type: 'SKIP_WAITING' });
      };
      if (reg.waiting) { activate(reg.waiting); return; }
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => { if (sw.state === 'installed') activate(sw); });
      });
      // Vérifier s'il y a une mise à jour disponible maintenant
      reg.update().catch(() => {});
    }).catch(() => {});
  }, []);

  const audio = useStudioAudio(selected);
  const offline = useStudioOffline();
  
  const recorder = useStudioRecorder({
    reverb, currentPreset,
    instUrl: audio.instUrl, vocalGuideUrl: audio.vocalGuideUrl,
    vocalGuideVol: audio.vocalGuideVol,
    vocalGuideVolRef: audio.vocalVolRef,
    instRef: audio.instRef, vocalGuideRef: audio.vocalGuideRef,
    backingTracks: project?.tracks
      .filter(t => (t as any).isGenerated && !t.muted && t.dataUrl)
      .map(t => ({ dataUrl: t.dataUrl!, gain: (t.gain ?? 0.4) * 0.6, pan: t.pan ?? 0,
        trackIndex: t.trackIndex })) ?? [],
    sections: (project?.sections as any[]) ?? [],
    takeSlot,
    onLog: addLog,
    instOffsetMs: audio.instOffsetMs,
  });

  const allSongs = propSongs.length > 0 ? propSongs : apiSongs;
  const originals = allSongs.filter(s => s.type === SongType.ORIGINAL || (s as any).type === 'Original');

  // FIX OOM : on ne charge plus jamais /api/songs (11 Mo, tous les champs lourds
  // — posterUrl, realPartition, lyrics...) au démarrage. On charge l'INDEX LÉGER
  // (/api/songs/list) pour la liste, et la chanson complète est chargée à la
  // demande (voir hydrateSelectedSong plus bas), seulement quand on l'ouvre.
  useEffect(() => {
    (async () => {
      try {
        const cached = await studioOfflineDB.getAllSongs();
        if (cached.length > 0) setApiSongs(cached);
      } catch {}
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        // Priorité : Mac local (données fraîches) → Railway (données statiques du repo)
        const macUrl = (window as any).__CC_MAC_URL as string || '';
        const songsUrl = macUrl.startsWith('http')
          ? `${macUrl}/api/songs/list`
          : '/api/songs/list';
        const res = await fetch(songsUrl, { signal: controller.signal, cache: 'no-store' });
        clearTimeout(timeout);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && data.length > 0) {
            setApiSongs(data);
            studioOfflineDB.saveSongs(data).catch(() => {});
            addLog(`✅ Songs chargés depuis ${macUrl ? 'Mac' : 'Railway'}: ${data.length} chansons (index léger)`);
          }
        }
      } catch {
        // Si Mac inaccessible, essayer Railway en fallback
        try {
          const res2 = await fetch('/api/songs/list', { cache: 'no-store' });
          if (res2.ok) {
            const data2 = await res2.json();
            if (Array.isArray(data2) && data2.length > 0) {
              setApiSongs(data2);
              studioOfflineDB.saveSongs(data2).catch(() => {});
            }
          }
        } catch {}
      }
    })();
  }, []);

  // Poll depuis le Mac toutes les 5 minutes pour détecter nouvelles chansons
  useEffect(() => {
    const poll = async () => {
      const macUrl = (window as any).__CC_MAC_URL as string || '';
      if (!macUrl.startsWith('http')) return;
      try {
        const res = await fetch(`${macUrl}/api/songs/list`, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
        if (!res.ok) return;
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) return;
        setApiSongs(prev => {
          if (data.length !== prev.length || data.some((s: any, i: number) => s.id !== prev[i]?.id)) {
            studioOfflineDB.saveSongs(data).catch(() => {});
            addLog(`🔄 Chansons Mac: ${data.length} (était ${prev.length})`);
            return data;
          }
          return prev;
        });
      } catch {}
    };
    const iv = setInterval(poll, 5 * 60 * 1000); // toutes les 5 minutes
    return () => clearInterval(iv);
  }, []);
  useEffect(() => {
    if (!selected || apiSongs.length === 0) return;
    const fresh = apiSongs.find(s => s.id === selected.id);
    // Fusion superficielle : `fresh` (index léger) n'a pas posterUrl/realPartition/
    // lyrics — on garde ces champs déjà hydratés sur `selected` intacts, on ne
    // met à jour que les champs légers (versions, titre, etc).
    if (fresh && JSON.stringify(fresh.versions) !== JSON.stringify(selected.versions)) {
      setSelected(prev => prev ? { ...prev, ...fresh } : fresh);
      addLog(`🔄 Chanson mise à jour: ${fresh.versions?.length ?? 0} version(s)`);
    }
  }, [apiSongs]);

  // ── Hydratation à la demande de la chanson complète ─────────────────────────
  // FIX OOM : quand on ouvre une chanson (screen 'record'/'mixer'), on va
  // chercher les champs lourds (posterUrl, realPartition, lyrics synchro) qui
  // ne sont plus dans l'index léger. On tente d'abord le cache offline
  // (chanson déjà ouverte avant → hors-ligne instantané), sinon le réseau.
  const hydratedSongIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!selected) return;
    if (hydratedSongIds.current.has(selected.id)) return;
    // Déjà hydratée dans cette session (realPartition présent) → rien à faire
    if ((selected as any).realPartition !== undefined) {
      hydratedSongIds.current.add(selected.id);
      return;
    }
    let cancelled = false;
    (async () => {
      // 1) Cache offline (chanson déjà ouverte avant)
      try {
        const cachedFull = await studioOfflineDB.getFullSong(selected.id);
        if (cachedFull && !cancelled) {
          hydratedSongIds.current.add(selected.id);
          setSelected(prev => (prev && prev.id === selected.id) ? { ...prev, ...cachedFull } : prev);
          return;
        }
      } catch {}
      // 2) Réseau (Mac local en priorité, sinon Railway)
      try {
        const macUrl = (window as any).__CC_MAC_URL as string || '';
        const url = macUrl.startsWith('http') ? `${macUrl}/api/songs/${selected.id}` : `/api/songs/${selected.id}`;
        const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const full = await res.json();
          if (full && full.id && !cancelled) {
            hydratedSongIds.current.add(selected.id);
            setSelected(prev => (prev && prev.id === selected.id) ? { ...prev, ...full } : prev);
            studioOfflineDB.saveFullSong(full).catch(() => {});
          }
        }
      } catch (e: any) {
        addLog(`⚠️ Chanson complète non chargée (hors-ligne ?) : ${e?.message || 'erreur réseau'}`);
      }
    })();
    return () => { cancelled = true; };
  }, [selected?.id]);

  const handleRefreshSong = async () => {
    if (!selected) return;
    addLog('🔄 Rechargement des données de la chanson...');
    try {
      // FIX OOM : on ne recharge plus tout le catalogue (11 Mo) pour rafraîchir
      // une seule chanson — juste /api/songs/:id.
      const macUrl = (window as any).__CC_MAC_URL as string || '';
      const url = macUrl.startsWith('http') ? `${macUrl}/api/songs/${selected.id}` : `/api/songs/${selected.id}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) {
        const fresh = await res.json();
        if (fresh && fresh.id) {
          setSelected(prev => (prev && prev.id === fresh.id) ? { ...prev, ...fresh } : fresh);
          studioOfflineDB.saveFullSong(fresh).catch(() => {});
          addLog(`✅ Stems rechargés depuis ${macUrl ? 'Mac' : 'Railway'}: ${fresh.versions?.length ?? 0} version(s)`);
        }
      }
    } catch (e: any) {
      addLog(`❌ Erreur rechargement: ${e.message}`);
    }
  };
  // Stratégie confirmée (ios-safe-audio-context, WebKit Bugzilla #154538) :
  // 1. Créer AudioContext AU MONTAGE (pas dans un geste user pour le contexte lui-même,
  //    car on est dans un useEffect post-render — pas de geste requis pour la création).
  // 2. Le vrai "warm-up" se fait dans preWarmMic() via un GESTE USER (tap sur micro) :
  //    getUserMedia() → stopper tracks → __warmContext reste ouvert → AVAudioSession stable.
  // 3. On NE stocke PAS __warmStream — inutile et trompeur (stream mort = silence).
  // 4. Sur iOS, le sampleRate (48kHz interne, 44.1kHz casque) est dicté par le hardware.
  //    On l'accepte tel quel. Le WAV AudioWorklet est encodé au sampleRate natif.
  useEffect(() => {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;

    // Pré-créer le contexte sans geste si possible (Chrome/Android/desktop).
    // Sur iOS, le contexte démarre en 'suspended' jusqu'au premier geste.
    try {
      let ctx = (window as any).__warmContext as AudioContext | undefined;
      if (!ctx || ctx.state === 'closed') {
        ctx = new AudioCtx({ latencyHint: 'interactive' });
        (window as any).__warmContext = ctx;
        (window as any).__warmWorkletLoaded = null;
        addLog(`AudioContext pré-créé | ${ctx.sampleRate}Hz | state=${ctx.state}`);
      }
    } catch (e) {
      addLog(`⚠️ Pré-création contexte échouée: ${e}`);
    }

    // Résumer le contexte sur CHAQUE interaction utilisateur (pas seulement visibilitychange)
    // iOS suspend le contexte après inactivité même si l'app est en foreground
    const resumeOnTap = () => {
      const ctx = (window as any).__warmContext as AudioContext | undefined;
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
    };
    document.addEventListener('touchstart', resumeOnTap, { passive: true });
    document.addEventListener('pointerdown', resumeOnTap, { passive: true });

    // Visibilité : reprendre le contexte si suspendu (app en background puis foreground)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        const ctx = (window as any).__warmContext as AudioContext | undefined;
        if (ctx && ctx.state === 'suspended') {
          ctx.resume().then(() => addLog(`AudioContext repris | ${ctx.sampleRate}Hz`)).catch(() => {});
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      document.removeEventListener('touchstart', resumeOnTap);
      document.removeEventListener('pointerdown', resumeOnTap);
    };
  }, []);

  useEffect(() => {
    // Récupérer les prises OPFS orphelines (fichier OPFS présent mais métadonnées IDB perdues)
    // Cela arrive si l'app a crashé ou iOS a vidé IDB pendant AVAudioSession
    studioOfflineDB.recoverOrphanOPFSRecordings().then(recovered => {
      if (recovered.length > 0) {
        addLog(`🔄 ${recovered.length} prise(s) OPFS récupérée(s) après redémarrage`);
      }
    }).catch(() => {}).finally(() => {
      studioService.getLocalRecordingsAsync().then(setRecordings).catch(() => setRecordings(studioService.getLocalRecordings()));
    });
  }, []);
  
  // Vider la file de sauvegardes différées quand l'écran change
  useEffect(() => {
    const queue: any[] = (window as any).__pendingSaves || [];
    if (queue.length > 0) {
      addLog(`💾 ${queue.length} prise(s) en attente — tentative sauvegarde...`);
      const trySave = async () => {
        const saved: any[] = [];
        for (const item of queue) {
          try {
            await studioOfflineDB.init();
            await studioService.saveRecordingLocallyAsync(item.rec);
            const ok = await studioOfflineDB.hasAudio(`rec_${item.rec.id}`);
            if (ok) { saved.push(item); addLog(`💾 ✅ Prise différée sauvegardée`); }
          } catch {}
        }
        (window as any).__pendingSaves = queue.filter((q: any) => !saved.includes(q));
        if ((window as any).__pendingSaves.length === 0) addLog('💾 ✅ Toutes les prises sécurisées');
      };
      trySave().catch(() => {});
    }
  }, [screen]);

  useEffect(() => {
    if (!selected) return;
    const proj = studioService.getOrCreateProject(selected.id, selected.title);
    if (selected.key && !(proj as any).suggestedKey) (proj as any).suggestedKey = selected.key;

    // Nettoyer les doublons de voix principale au chargement
    // Stratégie : garder UNE SEULE piste par slot — la première trouvée suffit
    // (même id, même date = même prise dupliquée en localStorage)
    const seenIds   = new Set<string>();
    const seenTrackSlots = new Set<string>(); // clé = `${trackIndex}_${slot}` pour voix + harmonies manuelles
    const cleanedTracks = proj.tracks.filter((t: any) => {
      // Dédupliquer par id d'abord (cas id identique)
      if (t.id && seenIds.has(t.id)) return false;
      if (t.id) seenIds.add(t.id);
      // Pour les pistes manuelles (voix principale + harmonies manuelles) : une seule par trackIndex+slot
      if (!t.isGenerated && t.trackIndex >= 0) {
        const slotKey = `${t.trackIndex}_${t.takeSlot ?? 'A'}`;
        if (seenTrackSlots.has(slotKey)) return false;
        seenTrackSlots.add(slotKey);
      }
      return true;
    });
    // Normaliser les gains trop élevés (> 1.0 = CLIP)
    const normalizedTracks = cleanedTracks.map((t: any) => ({
      ...t,
      gain: t.gain && t.gain > 1.0 ? 1.0 : t.gain,
    }));
    const cleanedProj = { ...proj, tracks: normalizedTracks };
    // Toujours sauvegarder pour purger localStorage des doublons
    studioService.saveProject(cleanedProj);
    setProject(cleanedProj);
    setMixDone(!!proj.mixedDataUrl);

    // Restaurer le slot actif depuis IDB (survit aux redémarrages iOS)
    studioOfflineDB.init().then(() =>
      studioOfflineDB.getState<string>(`takeSlot_${selected.id}`, 'A')
    ).then(saved => {
      if (saved && ['A','B','C'].includes(saved)) setTakeSlot(saved as 'A'|'B'|'C');
      else setTakeSlot('A');
    }).catch(() => setTakeSlot('A'));

    // Recharger les dataUrl depuis IDB pour tous les tracks au demarrage
    // blob: URLs meurent au redemarrage iOS -> toujours recrer depuis IDB
    // data: URLs base64 -> conserver (petites harmonies)
    // FIX OOM : charger seulement le slot actif au démarrage — les autres slots chargent
    // à la demande quand l'utilisateur clique sur le bouton du slot
    if (proj.tracks.length > 0) {
      // Utiliser le takeSlot déjà chargé plus haut (pas de await ici)
      const activeSlotName = takeSlot || 'A';

      const loadOneTrack = async (track: any) => {
        // data: URL base64 valide -> conserver
        if (track.dataUrl && track.dataUrl.startsWith('data:') && track.dataUrl.length > 1000) return track;
        // blob: URL ou vide -> invalide, on nettoie et recharge depuis IDB
        const cleanTrack = { ...track, dataUrl: undefined as any };
        // Cle principale rec_
        try {
          const blob = await studioOfflineDB.getAudio(`rec_${track.id}`);
          if (blob && blob.size > 1000) {
            // Forcer audio/mp4 sur iOS si type inconnu ou webm (non supporté)
            const safeBlob = (blob.type === '' || blob.type.includes('webm') || blob.type.includes('ogg'))
              ? new Blob([blob], { type: 'audio/mp4' }) : blob;
            const dataUrl = URL.createObjectURL(safeBlob);
            (window as any)[`__trackBlob_${track.id}`] = safeBlob;
            addLog(`Slot ${track.takeSlot ?? track.trackIndex} recharge IDB (${(blob.size/1024).toFixed(0)} KB)`);
            if (track.trackIndex === 0) {
              blob.arrayBuffer().then(ab => {
                const tmp = new (window.AudioContext || (window as any).webkitAudioContext)();
                return tmp.decodeAudioData(ab).then(buf => {
                  (window as any).__lastRecDecodedBuf = buf;
                  (window as any).__lastRecDecodedId  = track.id;
                  tmp.close();
                }).catch(() => { tmp.close(); });
              }).catch(() => {});
            }
            return { ...cleanTrack, dataUrl };
          }
        } catch {}
        // Cle harmonie generee — la vraie cle est dans dataUrl si sentinelle opfs:
        if ((track as any).isGenerated) {
          // Priorite 1: cle exacte depuis la sentinelle opfs: stockee dans dataUrl
          const opfsKey = track.dataUrl?.startsWith('opfs:') ? track.dataUrl.slice(5) : null;
          const keysToTry: string[] = [];
          if (opfsKey) keysToTry.push(opfsKey);
          // Priorite 2: cle par voiceId extraite de l'opfsKey si disponible
          // Priorite 3: fallback legacy avec songId (ancienne convention incorrecte)
          if (track.songId && track.trackIndex != null) {
            keysToTry.push(`harmony_${track.songId}_t${track.trackIndex}`);
          }
          for (const harmKey of keysToTry) {
            try {
              const blob = await studioOfflineDB.getAudio(harmKey);
              if (blob && blob.size > 1000) {
                const safeHBlob = (blob.type === '' || blob.type.includes('webm') || blob.type.includes('ogg'))
                  ? new Blob([blob], { type: 'audio/mp4' }) : blob;
                const dataUrl = URL.createObjectURL(safeHBlob);
                (window as any)[`__trackBlob_${track.id}`] = safeHBlob;
                (window as any).__harmonyBlobs = (window as any).__harmonyBlobs || {};
                (window as any).__harmonyBlobs[harmKey] = safeHBlob;
                addLog(`Harmonie t${track.trackIndex} rechargee (${harmKey.slice(-20)})`);
                // Conserver la vraie cle opfs: dans dataUrl pour les prochains rechargements
                return { ...cleanTrack, dataUrl };
              }
            } catch {}
          }
        }
        // Cle backup
        try {
          const backup = await studioOfflineDB.getAudio(`backup_voice_${track.id}`);
          if (backup && backup.size > 1000) {
            const dataUrl = URL.createObjectURL(backup);
            (window as any)[`__trackBlob_${track.id}`] = backup;
            addLog(`Slot ${track.takeSlot ?? track.trackIndex} restaure BACKUP`);
            return { ...cleanTrack, dataUrl };
          }
        } catch {}
        addLog(`Slot ${track.takeSlot ?? track.trackIndex} — audio non chargé (${track.id.slice(-6)})`);
        return cleanTrack;
      };

      Promise.all(
        proj.tracks.map(async (track) => {
          const trackSlot = (track.takeSlot ?? 'A') as string;
          // Charger immédiatement : slot actif + harmonies générées (légères)
          if (trackSlot === activeSlotName || (track as any).isGenerated) {
            return loadOneTrack(track);
          }
          // Slots inactifs (B et C si slot actif = A, etc.) : ne pas charger maintenant
          // Ils seront chargés via handleTakeSlotChange quand l'utilisateur clique
          addLog(`Slot ${trackSlot} — chargement différé (inactif au démarrage)`);
          return track; // retourner sans dataUrl — sera chargé à la demande
        })
      ).then(tracksWithData => {
        setProject(prev => prev ? { ...prev, tracks: tracksWithData } : prev);
      }).catch(() => {});
    }
  }, [selected?.id]);

  // Calculer les prises existantes par slot pour la chanson sélectionnée
  const slotTakes = React.useMemo(() => {
    const takes: { A?: any; B?: any; C?: any } = {};
    if (!project) return takes;
    // Pour la voix principale seulement (trackIndex 0, non générée)
    // takeSlot absent (anciennes prises) → défaut 'A' (slots B/C n'existaient pas encore)
    project.tracks.forEach(t => {
      if (t.trackIndex === 0 && !t.isGenerated) {
        const slot = (t.takeSlot as 'A' | 'B' | 'C') ?? 'A';
        const existing = takes[slot];
        if (!existing || (t as any).recordedAt > (existing as any).recordedAt) {
          takes[slot] = t;
        }
      }
    });
    return takes;
  }, [project]);

  const reloadRecordings = () => studioService.getLocalRecordingsAsync().then(setRecordings).catch(() => setRecordings(studioService.getLocalRecordings()));
  const updateProject = (updater: (p: TrackProject) => TrackProject) => setProject(prev => { if (!prev) return prev; const n = updater(prev); studioService.saveProject(n); return n; });
  const handleMuteTrack = (i: number, v: boolean) => updateProject(p => ({ ...p, tracks: p.tracks.map(t => t.trackIndex === i ? { ...t, muted: v } : t) }));
  const handleSoloTrack = (i: number) => updateProject(p => {
    const alreadySolo = p.tracks.every(t => t.trackIndex === i ? !t.muted : t.muted);
    return { ...p, tracks: p.tracks.map(t => ({ ...t, muted: alreadySolo ? false : t.trackIndex !== i })) };
  });
  const handleVolumeTrack = (i: number, v: number) => updateProject(p => ({ ...p, tracks: p.tracks.map(t => t.trackIndex === i ? { ...t, gain: v } : t) }));
  const handlePanTrack = (i: number, v: number) => updateProject(p => ({ ...p, tracks: p.tracks.map(t => t.trackIndex === i ? { ...t, pan: v } : t) }));
  // FIX bug critique : la suppression filtrait par trackIndex seul, donc
  // supprimer la voix principale slot A effaçait AUSSI les slots B et C
  // (même trackIndex: 0 pour les trois). Maintenant on filtre par id unique,
  // qui ne se confond jamais entre deux prises différentes, peu importe
  // leur trackIndex ou leur slot.
  const handleDeleteTrack = (trackId: string) => updateProject(p => ({ ...p, tracks: p.tracks.filter(t => t.id !== trackId) }));

  // ── Libération mémoire au changement de chanson ──────────────────────────
  // FIX OOM : __trackBlob_ et __lastRecDecodedBuf s'accumulent en mémoire window
  // sans jamais être libérés lors de la navigation entre chansons.
  // À appeler avant setSelected(null) ou setSelected(newSong).
  const clearSongMemory = () => {
    // Révoquer toutes les blob URLs du projet courant avant de changer de chanson
    if (project) {
      for (const t of project.tracks) {
        if (t.dataUrl && t.dataUrl.startsWith('blob:')) {
          try { URL.revokeObjectURL(t.dataUrl); } catch {}
        }
      }
    }
    // Libérer tous les blobs de pistes en mémoire
    const keys = Object.keys(window).filter(k =>
      k.startsWith('__trackBlob_') || k.startsWith('__originalBlob_')
    );
    for (const k of keys) {
      try { delete (window as any)[k]; } catch {}
    }
    // Libérer le buffer vocal décodé (~40 MB pour un vocal 4 min)
    (window as any).__lastRecDecodedBuf = null;
    (window as any).__lastRecDecodedId  = null;
    // Libérer le dernier blob FX (~40 MB)
    (window as any).__lastFxBlob = null;
    (window as any).__lastFxKey  = null;
    (window as any).__lastFxSourceUrl = null;
    // Libérer le worker harmony s'il existe
    try { (window as any).__harmonyWorker?.terminate(); } catch {}
    (window as any).__harmonyWorker = null;
    // Libérer les blobs d'harmonies
    (window as any).__harmonyBlobs = {};
  };

  const handlePreviewStems = async () => {
    const inst  = audio.instRef.current;
    const vocal = audio.vocalGuideRef.current;
    addLog(`PREVIEW tap | instUrl=${audio.instUrl ? audio.instUrl.slice(0,30) : 'NULL'} | instCached=${audio.instCached}`);

    if (isPreviewingRef.current) {
      inst?.pause(); vocal?.pause();
      try { (window as any).__instBufSrc?.stop();  } catch {} finally { (window as any).__instBufSrc  = null; (window as any).__instCtxActive = false; (window as any).__instWallStart = null; }
      try { (window as any).__vocalBufSrc?.stop(); } catch {} finally { (window as any).__vocalBufSrc = null; (window as any).__vocalBufGain = null; }
      isPreviewingRef.current = false; setIsPreviewing(false);
      return;
    }

    const ctx = (window as any).__warmContext as AudioContext | undefined;

    const hasInst  = inst  && (audio.instUrl  || inst.src);
    const hasVocal = vocal && audio.vocalGuideUrl;

    if (!hasInst && !hasVocal) {
      addLog('PREVIEW: aucun stem disponible');
      return;
    }

    isPreviewingRef.current = true; setIsPreviewing(true);

    // ── Résumer le contexte d'abord (nécessaire sur iOS après inactivité) ─────
    if (ctx && ctx.state === 'suspended') {
      try { await ctx.resume(); } catch {}
    }

    // ── Charger les ArrayBuffer des deux stems en parallèle ──────────────────
    // On utilise fetch() + decodeAudioData pour obtenir deux AudioBuffer
    // synchronisables via ctx.currentTime (horloge commune, sample-accurate).
    const fetchAndDecode = async (url: string, label: string): Promise<AudioBuffer | null> => {
      try {
        addLog(`${label} fetch → ${url.slice(0, 50)}`);
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const ab = await resp.arrayBuffer();
        if (!ctx) throw new Error('no ctx');
        const buf = await ctx.decodeAudioData(ab);
        addLog(`${label} décodé: ${buf.duration.toFixed(1)}s`);
        return buf;
      } catch (e: any) {
        addLog(`${label} ERREUR decode: ${e.message}`);
        return null;
      }
    };

    const instSrc  = audio.instUrl  || inst?.src  || null;
    const vocalSrc = audio.vocalGuideUrl || null;

    // Si pas de contexte AudioContext disponible → fallback <audio> séquentiel
    if (!ctx) {
      addLog('PREVIEW: pas de ctx → fallback <audio>');
      const playElFallback = (el: HTMLAudioElement, label: string) => {
        el.currentTime = 0;
        el.play().then(() => addLog(`${label}.play() OK`)).catch((e: Error) => addLog(`${label}.play() ERR: ${e.message}`));
      };
      if (inst && instSrc) { if (inst.src !== instSrc) { inst.src = instSrc; inst.load(); } playElFallback(inst, 'inst'); }
      if (vocal && vocalSrc) { if (vocal.src !== vocalSrc) { vocal.src = vocalSrc; vocal.load(); } try { vocal.volume = audio.vocalVolRef.current; } catch {} playElFallback(vocal, 'vocal'); }
      return;
    }

    // ── Décoder les deux stems en parallèle ───────────────────────────────────
    const [instBuf, vocalBuf] = await Promise.all([
      hasInst  && instSrc  ? fetchAndDecode(instSrc, 'inst')   : Promise.resolve(null),
      hasVocal && vocalSrc ? fetchAndDecode(vocalSrc, 'vocal') : Promise.resolve(null),
    ]);

    // Vérifier que l'utilisateur n'a pas annulé pendant le chargement
    if (!isPreviewingRef.current) { addLog('PREVIEW: annulé pendant chargement'); return; }

    // ── Planifier les deux BufferSourceNode au MÊME instant ctx ──────────────
    // startAt dans le futur de 80ms pour laisser le temps au scheduler audio
    const startAt = ctx.currentTime + 0.08;

    if (instBuf) {
      const bsrc = ctx.createBufferSource();
      bsrc.buffer = instBuf;
      bsrc.connect(ctx.destination);
      (window as any).__instCtxStartTime = startAt;
      (window as any).__instCtxOffset    = 0;
      (window as any).__instCtxActive    = true;
      (window as any).__instWallStart    = Date.now() + 80;
      (window as any).__instBufSrc       = bsrc;
      bsrc.onended = () => {
        isPreviewingRef.current = false; setIsPreviewing(false);
        (window as any).__instCtxActive = false;
        (window as any).__instBufSrc    = null;
        (window as any).__instWallStart = null;
        // Arrêter le vocal s'il tourne encore
        try { (window as any).__vocalBufSrc?.stop(); } catch {}
        (window as any).__vocalBufSrc = null;
        (window as any).__vocalBufGain = null;
      };
      // Appliquer le décalage Auto Sync — même convention que mixProject/REC :
      // offset > 0 → inst démarre plus tard ; offset < 0 → inst démarre plus avancé
      const previewOffsetSec = (audio.instOffsetMs ?? 0) / 1000;
      if (previewOffsetSec >= 0) {
        bsrc.start(startAt + previewOffsetSec);
      } else {
        bsrc.start(startAt, Math.min(-previewOffsetSec, Math.max(0, instBuf.duration)));
      }
      addLog(`inst BufferSource → start @ ctx+80ms (offset=${(audio.instOffsetMs ?? 0)}ms)`);
    }

    if (vocalBuf) {
      const vGain = ctx.createGain();
      vGain.gain.value = audio.vocalVolRef.current;
      const vsrc = ctx.createBufferSource();
      vsrc.buffer = vocalBuf;
      // Transposition du guide vocal — slider 🎼 Guide dans RecordScreen
      // (window.__vocalGuidePlaybackRate, persisté dans localStorage)
      try { vsrc.playbackRate.value = (window as any).__vocalGuidePlaybackRate ?? 1.0; } catch {}
      vsrc.connect(vGain);
      vGain.connect(ctx.destination);
      (window as any).__vocalBufGain = vGain;
      (window as any).__vocalBufSrc  = vsrc;
      vsrc.onended = () => {
        (window as any).__vocalBufSrc  = null;
        (window as any).__vocalBufGain = null;
        if (!instBuf) { isPreviewingRef.current = false; setIsPreviewing(false); }
      };
      vsrc.start(startAt); // ← même startAt que inst : synchronisation sample-accurate
      addLog(`vocal BufferSource → start @ ctx+80ms (transpose=${((window as any).__vocalGuidePlaybackRate ?? 1.0).toFixed(3)}x)`);
    }

    // Si aucun buffer n'a pu être décodé → setIsPreviewing(false)
    if (!instBuf && !vocalBuf) {
      addLog('PREVIEW: échec décodage des deux stems');
      isPreviewingRef.current = false; setIsPreviewing(false);
    }
  };

  const handleDeleteRecording = (id: string) => { studioService.deleteLocalRecording(id); reloadRecordings(); };
  const handleUploadRecording = async (rec: MobileRecording) => {
    setUploading(rec.id);
    try {
      let blob: Blob | null = null;
      try { blob = await studioOfflineDB.getAudio(`rec_${rec.id}`); } catch {}
      if (!blob && rec.dataUrl) blob = await studioService.resolveBlobAsync(rec.dataUrl);
      if (!blob) { alert('Fichier introuvable.'); return; }
      const ok = await studioService.uploadToServer(rec, blob);
      if (ok) { studioService.markTransferred(rec.id); reloadRecordings(); setUploadDone(rec.id); setTimeout(() => setUploadDone(null), 3000); }
      else alert('Échec transfert.');
    } catch (e: any) {
      const isQuota = e?.name === 'QuotaExceededError' || e?.message?.toLowerCase().includes('quota');
      if (!isQuota) alert('Erreur : ' + e.message);
    }
    finally { setUploading(null); }
  };

  // Charger un slot comme guide vocal dans vocalGuideRef
  const handleSlotGuide = (slot: 'A'|'B'|'C'|null) => {
    setSlotGuideActive(slot);
    const el = audio.vocalGuideRef.current;
    if (!el) return;
    if (!slot) {
      el.pause(); el.src = ''; return;
    }
    const take = slotTakes[slot];
    if (!take?.dataUrl) return;
    el.pause();
    el.src = take.dataUrl;
    el.loop = false;
    // Synchroniser avec l'instrumental si en cours, sinon partir du début
    const instEl = audio.instRef.current;
    if (instEl && !instEl.paused) {
      el.currentTime = instEl.currentTime;
    } else {
      el.currentTime = 0;
    }
    el.play().catch(() => {});
  };

  // Reset guide quand on change de slot actif
  const handleTakeSlotChange = (slot: 'A'|'B'|'C') => {
    if (slotGuideActive) {
      const el = audio.vocalGuideRef.current;
      if (el) { el.pause(); el.src = ''; }
      setSlotGuideActive(null);
    }

    // Libérer l'ancien slot de la mémoire avant de charger le nouveau
    if (project && slot !== takeSlot) {
      const oldSlotTracks = project.tracks.filter(t =>
        !t.isGenerated && (t.takeSlot ?? 'A') === takeSlot
      );
      for (const t of oldSlotTracks) {
        // Révoquer la blob URL avant de supprimer le blob
        if (t.dataUrl && t.dataUrl.startsWith('blob:')) {
          try { URL.revokeObjectURL(t.dataUrl); } catch {}
        }
        try { delete (window as any)[`__trackBlob_${t.id}`]; } catch {}
      }
      // Libérer aussi le buffer décodé si il appartenait à l'ancien slot
      const oldId = oldSlotTracks[0]?.id;
      if (oldId && (window as any).__lastRecDecodedId === oldId) {
        (window as any).__lastRecDecodedBuf = null;
        (window as any).__lastRecDecodedId  = null;
      }
    }

    setTakeSlot(slot);
    // Persister le slot actif en IDB
    if (selected?.id) {
      studioOfflineDB.init().then(() =>
        studioOfflineDB.setState(`takeSlot_${selected.id}`, slot)
      ).catch(() => {});
    }

    // Chargement à la demande : si le slot n'a pas encore son audio, le charger maintenant
    if (!project) return;
    const slotTracks = project.tracks.filter(t =>
      !t.isGenerated && (t.takeSlot ?? 'A') === slot && t.trackIndex === 0
    );
    const needsLoad = slotTracks.filter(t =>
      !t.dataUrl || t.dataUrl.startsWith('blob:') === false && !t.dataUrl.startsWith('data:')
    );
    if (needsLoad.length === 0) return;

    addLog(`Slot ${slot} — chargement à la demande...`);
    Promise.all(needsLoad.map(async (track) => {
      try {
        const blob = await studioOfflineDB.getAudio(`rec_${track.id}`);
        if (blob && blob.size > 1000) {
          const safeBlob = (blob.type === '' || blob.type.includes('webm') || blob.type.includes('ogg'))
            ? new Blob([blob], { type: 'audio/mp4' }) : blob;
          const dataUrl = URL.createObjectURL(safeBlob);
          (window as any)[`__trackBlob_${track.id}`] = safeBlob;
          addLog(`Slot ${slot} recharge IDB (${(blob.size/1024).toFixed(0)} KB)`);
          if (track.trackIndex === 0) {
            blob.arrayBuffer().then(ab => {
              const tmp = new (window.AudioContext || (window as any).webkitAudioContext)();
              return tmp.decodeAudioData(ab).then(buf => {
                (window as any).__lastRecDecodedBuf = buf;
                (window as any).__lastRecDecodedId  = track.id;
                tmp.close();
              }).catch(() => { tmp.close(); });
            }).catch(() => {});
          }
          return { id: track.id, dataUrl };
        }
      } catch {}
      return null;
    })).then(results => {
      const updates = results.filter(Boolean) as { id: string; dataUrl: string }[];
      if (updates.length > 0) {
        setProject(prev => prev ? {
          ...prev,
          tracks: prev.tracks.map(t => {
            const u = updates.find(u => u.id === t.id);
            return u ? { ...t, dataUrl: u.dataUrl } : t;
          })
        } : prev);
      }
    }).catch(() => {});
  };

  const handleMix = async (layerIds: string[] = [], instOffsetMsOverride?: number) => {
    const instOffsetMs = instOffsetMsOverride ?? audio.instOffsetMs ?? 0;
    if (!project || project.tracks.length === 0) return;
    setIsMixing(true); setMixProgress(5); setMixLabel('Préparation des pistes…');
    try {
      // FIX : filtrer les pistes voix principale ET harmonies manuelles pour ne garder
      // que le takeSlot actif de chacune. Sans ce filtre, tous les slots jouent en même temps.
      const activeSlot = takeSlot ?? 'A';
      const seenVoiceInMix = new Set<string>();
      const seenHarmonySlotInMix = new Set<string>(); // clé = `${trackIndex}_${slot}`
      const filteredTracks = project.tracks.filter((t: any) => {
        if (t.trackIndex === 0 && !t.isGenerated) {
          const slot = t.takeSlot ?? 'A';
          if (seenVoiceInMix.has(slot)) return false;
          seenVoiceInMix.add(slot);
          return slot === activeSlot;
        }
        if (t.trackIndex >= 2 && t.trackIndex <= 5 && !t.isGenerated) {
          // Harmonie manuelle : ne garder que le slot actif sélectionné dans le mixer
          // (activeManualSlots côté MixerScreen — ici on prend la même règle par défaut 'A'
          // sauf si le projet porte une préférence sauvegardée par trackIndex)
          const slot = t.takeSlot ?? 'A';
          const preferredSlot = (project as any).activeManualSlots?.[t.trackIndex] ?? 'A';
          const key = `${t.trackIndex}_${slot}`;
          if (seenHarmonySlotInMix.has(key)) return false;
          seenHarmonySlotInMix.add(key);
          return slot === preferredSlot;
        }
        return true;
      });
      // Fallback : si aucune voix principale trouvée, prendre la première dispo
      const hasMainVoice = filteredTracks.some((t: any) => t.trackIndex === 0 && !t.isGenerated);
      if (!hasMainVoice) {
        const fallback = project.tracks.find((t: any) => t.trackIndex === 0 && !t.isGenerated);
        if (fallback) filteredTracks.unshift(fallback);
      }
      // Construire un projet temporaire incluant les slots layerisés
      let mixProject = { ...project, tracks: filteredTracks };
      if (layerIds.length > 0) {
        // Les slots layerisés sont déjà dans project.tracks — on les réintroduit
        // avec un pan/gain différent SANS les dupliquer (on garde l'original muted=false)
        const layerTracks = project.tracks
          .filter(t => layerIds.includes(t.id) && t.dataUrl)
          .map((t, i) => ({
            ...t,
            id: t.id + '_layer',                  // id unique pour éviter confusion
            gain: 0.75,                            // blend équilibré
            pan: i % 2 === 0 ? -0.3 : 0.3,        // légère largeur stéréo
            muted: false,
          }));
        mixProject = { ...project, tracks: [...project.tracks, ...layerTracks] };
      }
      // Petit délai pour laisser React render l'overlay avant le traitement
      await new Promise(r => setTimeout(r, 80));
      const mixBlob = await studioService.mixProject(mixProject, (label, pct) => {
        setMixLabel(label);
        setMixProgress(pct);
      }, instOffsetMs);
      // Stocker le blob mix en mémoire et utiliser une URL objet
      // (évite blobToDataUrl qui crash sur iOS pour les gros fichiers ~30MB)
      (window as any).__mixBlob = mixBlob;
      const mixUrl = URL.createObjectURL(mixBlob);
      if ((window as any).__mixUrl) URL.revokeObjectURL((window as any).__mixUrl);
      (window as any).__mixUrl = mixUrl;
      updateProject(p => ({ ...p, mixedDataUrl: mixUrl }));
      setMixDone(true);
      // Pas de navigation automatique — l'utilisateur appuie sur Masteriser quand prêt
      // (évite l'écran noir iOS causé par OfflineAudioContext lancé trop tôt)
      // Persister le mix en IDB pour survive aux redémarrages (masterisation différée)
      if (project) {
        studioOfflineDB.saveAudio(`mix_${project.id}`, mixBlob, {
          type: 'mix', songId: project.songId, savedAt: Date.now()
        }).catch(() => {}); // non bloquant
      }
    } catch (e: any) {
      const isQuota = e?.name === 'QuotaExceededError'
        || (e?.message && e.message.toLowerCase().includes('quota'));
      if (!isQuota) alert('Erreur mixage : ' + e.message);
      else console.warn('[Mix] Quota dépassé:', e.message);
    }
    finally { setIsMixing(false); setMixProgress(0); setMixLabel(''); }
  };

  const handleUploadMix = async () => {
    if (!project?.mixedDataUrl || !selected) return;
    setUploading('mix');
    try {
      // mixedDataUrl peut être une blob: URL (créée par URL.createObjectURL) ou une data: URL legacy
      const mixUrl = project.mixedDataUrl;
      let blob: Blob;
      if (mixUrl.startsWith('blob:') && (window as any).__mixBlob) {
        blob = (window as any).__mixBlob as Blob;
      } else {
        // data: URL legacy ou opfs: éventuel
        const resolved = await studioService.resolveBlobAsync(mixUrl);
        blob = resolved;
      }
      const fakeRec: MobileRecording = { id: `MIX-${project.id}`, songId: selected.id, songTitle: selected.title, artist: selected.artist || '', duration: project.tracks[0]?.duration || 0, recordedAt: Date.now(), dataUrl: project.mixedDataUrl, transferred: false, fileName: `MIX_${selected.title.replace(/\s+/g,'_')}_${Date.now()}.mp4` };
      const ok = await studioService.uploadToServer(fakeRec, blob);
      if (ok) { setUploadDone('mix'); setTimeout(() => setUploadDone(null), 3000); }
      else alert('Échec transfert.');
    } finally { setUploading(null); }
  };

  const handleMasterize = (vocalBlob: Blob, instBlob: Blob | null) => { setMasterVocalBlob(vocalBlob); setMasterInstBlob(instBlob); setScreen('master'); };
  const handleStemReady = async (_blob: Blob, fileName: string) => { if (!selected) return; console.log(`[StudioMobile] Stem vocal transféré : ${fileName}`); };
  const handleRecordingSaved = (rec: MobileRecording, up: TrackProject | null) => {
    if (up) {
      setProject(up);
    } else if (project) {
      // addTrackToProject a retourné null (projet introuvable dans localStorage) — mettre à jour le state manuellement
      const updated = { ...project, tracks: [...project.tracks.filter(t => t.id !== rec.id), rec] };
      setProject(updated);
      studioService.saveProject({ ...updated, tracks: updated.tracks.map(t => ({ ...t, dataUrl: undefined, blob: undefined })) });
    }
    reloadRecordings();
    setScreen('mixer');
  };
  const getInstBlob = async (): Promise<Blob | null> => { if (!audio.instUrl) return null; try { return await studioOfflineDB.getAudio(`inst_${selected?.id}`); } catch { return null; } };
  const pendingCount = recordings.filter(r => !r.transferred).length;

  if (screen === 'master' && masterVocalBlob && selected) return <><DebugPanel debugLog={debugLog} onClear={() => setDebugLog([])} /><MasteringEngine vocalBlob={masterVocalBlob} instBlob={masterInstBlob} instOffsetMs={audio.instOffsetMs} songTitle={selected.title} songId={selected.id} onBack={() => setScreen('mixer')} onStemReady={handleStemReady} isOnline={offline.isOnline} /></>;
  if (screen === 'comp' && selected) return <><DebugPanel debugLog={debugLog} onClear={() => setDebugLog([])} /><ScreenErrorBoundary screenName="Comp Editor" onReset={() => setScreen('mixer')}><CompEditor song={selected} takes={compTakes} onBack={() => setScreen('mixer')} isOnline={offline.isOnline} onTakesChange={(updatedTakes) => {
              // Persister les régions dans les pistes du projet
              if (!project) return;
              const newTracks = project.tracks.map(track => {
                const take = updatedTakes.find(t => t.recording.id === track.id);
                return take ? { ...track, regions: take.regions } : track;
              });
              const updated = { ...project, tracks: newTracks };
              setProject(updated);
              studioService.saveProject(updated);
            }}
            onCompReady={async (blob) => { const dataUrl = await studioService.blobToDataUrl(blob); const rec: MobileRecording = { id: `COMP-${Date.now()}`, songId: selected.id, songTitle: selected.title, artist: selected.artist || '', duration: compTakes.reduce((s,t)=>s+t.regions.reduce((rs,r)=>rs+(r.endSec-r.startSec),0),0), recordedAt: Date.now(), dataUrl, transferred: false, fileName: `COMP_${selected.title.replace(/\s+/g,'_')}_${Date.now()}.mp4`, trackLabel: 'Comp final', trackIndex: 99, projectId: project?.id }; studioService.saveRecordingLocally(rec); reloadRecordings(); if (project) { updateProject(p => ({ ...p, mixedDataUrl: dataUrl })); setMixDone(true); } setScreen('mixer'); }} /></ScreenErrorBoundary></>;
  const [autoSyncing, setAutoSyncing] = useState(false);
  const handleAutoSync = async () => {
    if (!project || autoSyncing) return;
    const mainTrack = project.tracks.find((t: any) => t.trackIndex === 0 && !t.isGenerated);
    if (!mainTrack?.dataUrl) { alert('Voix principale introuvable'); return; }
    setAutoSyncing(true);
    try {
      const blob = await studioService.resolveBlobAsync(mainTrack.dataUrl);
      const url = URL.createObjectURL(blob);
      const detectedMs = await audio.autoDetectOffset(url);
      URL.revokeObjectURL(url);
      if (detectedMs !== null) {
        // Appliquer le décalage détecté (reset puis set)
        const delta = detectedMs - (audio.instOffsetMs ?? 0);
        if (Math.abs(delta) > 10) {
          audio.adjustInstOffset(delta);
          alert(`Sync automatique : ${detectedMs > 0 ? '+' : ''}${detectedMs}ms appliqué`);
        } else {
          alert('Sync déjà optimal (< 10ms de décalage)');
        }
      } else {
        alert('Stem vocal non disponible pour la détection automatique');
      }
    } catch (e: any) {
      alert('Erreur auto-sync : ' + e.message);
    } finally {
      setAutoSyncing(false);
    }
  };

  if (screen === 'mixer' && selected && project) return <><DebugPanel debugLog={debugLog} onClear={() => setDebugLog([])} /><MixerScreen selected={selected} project={project} playingId={audio.playingId} isMixing={isMixing} mixProgress={mixProgress} mixLabel={mixLabel} mixDone={mixDone} isOnline={offline.isOnline} uploading={uploading} uploadDone={uploadDone} playRef={audio.playRef} instBlob={masterInstBlob} takeSlot={takeSlot} previewInstVol={audio.previewInstVol} onPreviewInstVol={audio.setPreviewInstVol} onInstOffset={audio.adjustInstOffset} onAutoSync={handleAutoSync} autoSyncing={autoSyncing} onBack={() => setScreen('record')} onGoSongs={() => setScreen('songs')} onAddTrack={() => setScreen('record')} onPlay={audio.playRecording} onMute={handleMuteTrack} onSolo={handleSoloTrack} onVolume={handleVolumeTrack} onPan={handlePanTrack} onDelete={handleDeleteTrack} onMix={(ids) => handleMix(ids)} onPlayMix={() => project?.mixedDataUrl && audio.playMix(project.mixedDataUrl)} onMasterize={async (vocalBlob, _) => { const ib = await getInstBlob(); handleMasterize(vocalBlob, ib); }} onUploadMix={handleUploadMix} onGoComp={(takes) => { setCompTakes(takes); setScreen('comp'); }} onProjectUpdate={(up) => { setProject(up); studioService.saveProject(up); const needsReload = up.tracks.some(t => !t.dataUrl && !String(t.dataUrl ?? '').startsWith('opfs:')); if (needsReload) reloadRecordings(); }} /></>;
  if (screen === 'record' && selected) return <><DebugPanel debugLog={debugLog} onClear={() => setDebugLog([])} /><RecordScreen selected={selected} project={project} currentPreset={currentPreset} reverb={reverb} isRecording={recorder.isRecording} isSaving={recorder.isSaving} duration={recorder.duration} analyser={recorder.analyser} vuLevel={recorder.vuLevel} monitoring={recorder.monitoring} permError={recorder.permError} httpsUrl={offline.httpsUrl} inputGain={recorder.inputGain} onInputGainChange={recorder.setInputGain} monitorVol={recorder.monitorVol} onMonitorVolChange={recorder.setMonitorVol} instUrl={audio.instUrl} instLoading={audio.instLoading} instCached={audio.instCached} vocalGuideUrl={audio.vocalGuideUrl} vocalLoading={audio.vocalLoading} vocalCached={audio.vocalCached} vocalGuideVol={audio.vocalGuideVol} showLyrics={showLyrics} instRef={audio.instRef} vocalGuideRef={audio.vocalGuideRef} getInstPlaybackTime={audio.getInstPlaybackTime} onRefreshSong={handleRefreshSong} onPreWarmMic={recorder.preWarmMic} onBack={() => { if (isPreviewingRef.current) { audio.instRef.current?.pause(); audio.vocalGuideRef.current?.pause(); try { (window as any).__instBufSrc?.stop(); } catch {} (window as any).__instBufSrc = null; (window as any).__instCtxActive = false; try { (window as any).__vocalBufSrc?.stop(); } catch {} (window as any).__vocalBufSrc = null; isPreviewingRef.current = false; setIsPreviewing(false); } setScreen('songs'); clearSongMemory(); setSelected(null); }} onGoMixer={() => { if (isPreviewingRef.current) { audio.instRef.current?.pause(); audio.vocalGuideRef.current?.pause(); try { (window as any).__instBufSrc?.stop(); } catch {} (window as any).__instBufSrc = null; (window as any).__instCtxActive = false; try { (window as any).__vocalBufSrc?.stop(); } catch {} (window as any).__vocalBufSrc = null; isPreviewingRef.current = false; setIsPreviewing(false); } setScreen('mixer'); }} onPresetChange={setCurrentPreset} onReverbChange={setReverb} takeSlot={takeSlot} onTakeSlotChange={handleTakeSlotChange} slotTakes={slotTakes} onSlotGuide={handleSlotGuide} slotGuideActive={slotGuideActive}
        onStartRecording={() => { if (isPreviewingRef.current) { audio.instRef.current?.pause(); audio.vocalGuideRef.current?.pause(); try { (window as any).__instBufSrc?.stop(); } catch {} (window as any).__instBufSrc = null; (window as any).__instCtxActive = false; try { (window as any).__vocalBufSrc?.stop(); } catch {} (window as any).__vocalBufSrc = null; isPreviewingRef.current = false; setIsPreviewing(false); } if (selected && project) recorder.startRecording(selected, project); }} onStopRecording={() => { if (selected && project) recorder.stopRecording(selected, project, handleRecordingSaved); }} onToggleMonitor={recorder.toggleMonitoring} onVocalVolumeChange={audio.setVocalGuideVol} onToggleLyrics={() => setShowLyrics(v => !v)} onPreviewStems={handlePreviewStems} isPreviewing={isPreviewing} audioDevices={recorder.audioDevices} selectedDevice={recorder.selectedDevice} onSelectDevice={recorder.setSelectedDevice} onRefreshDevices={recorder.refreshDevices} punchIn={recorder.punchIn} punchOut={recorder.punchOut} onSetPunchIn={recorder.setPunchIn} onSetPunchOut={recorder.setPunchOut} stemDuration={audio.instRef.current?.duration || 0} sections={(project?.sections as any[] ?? [])} autoSelectReason={recorder.autoSelectReason} activeDeviceLabel={recorder.activeDeviceLabel} onPlayRaw={audio.playRecording} playingId={audio.playingId} /></>;
  if (screen === 'recordings') return <><DebugPanel debugLog={debugLog} onClear={() => setDebugLog([])} /><RecordingsList recordings={recordings} pendingCount={pendingCount} playingId={audio.playingId} uploading={uploading} uploadDone={uploadDone} isOnline={offline.isOnline} playRef={audio.playRef} onBack={() => setScreen('songs')} onPlay={audio.playRecording} onUpload={handleUploadRecording} onDelete={handleDeleteRecording} /></>;
  return <><DebugPanel debugLog={debugLog} onClear={() => setDebugLog([])} /><SongSelector songs={originals} isOnline={offline.isOnline} isInstalled={offline.isInstalled} httpsUrl={offline.httpsUrl} cachedSongs={offline.cachedSongs} cachingId={offline.cachingId} cacheProgress={offline.cacheProgress} cacheError={offline.cacheError} cachedCount={offline.cachedCount} storage={offline.storage} storageWarning={offline.storageWarning} storageCritical={offline.storageCritical} pendingCount={pendingCount} cacheHealth={offline.cacheHealth} missingModules={offline.missingModules} repairProgress={offline.repairProgress} onSelect={(song) => { clearSongMemory(); setSelected(song); setScreen('record'); audio.stopPlayback(); }} onInstall={offline.installPWA} onCache={(song) => offline.cacheSongForOffline(song, allSongs)} onForceRefresh={(song) => offline.forceRefreshSong(song, allSongs)}
            onImportFile={offline.importFileToCache} onClearCacheError={offline.clearCacheError} onRepairCache={offline.repairCache} onUncache={offline.uncacheSong} onClearAll={offline.clearAllCache} onViewRecordings={() => setScreen('recordings')} /></>;
}
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
const BUILD_VERSION = 'v7.6.150';

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

export default function StudioMobile({ songs: propSongs = [] }: Props) {
  const [screen, setScreen]     = useState<Screen>('songs');
  const [selected, setSelected] = useState<Song | null>(null);
  const [project, setProject]   = useState<TrackProject | null>(null);
  const [apiSongs, setApiSongs] = useState<Song[]>([]);
  const [recordings, setRecordings] = useState<MobileRecording[]>([]);
  const [currentPreset, setCurrentPreset] = useState<TrackPreset>(TRACK_PRESETS[0]);
  const [reverb, setReverb] = useState<ReverbType>('room');
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
    navigator.serviceWorker.ready.then(reg => {
      const activate = (sw: ServiceWorker) => {
        sw.postMessage({ type: 'SKIP_WAITING' });
        navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
      };
      if (reg.waiting) { activate(reg.waiting); return; }
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => { if (sw.state === 'installed') activate(sw); });
      });
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
  });

  const allSongs = propSongs.length > 0 ? propSongs : apiSongs;
  const originals = allSongs.filter(s => s.type === SongType.ORIGINAL || (s as any).type === 'Original');

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
          ? `${macUrl}/api/songs`
          : '/api/songs';
        const res = await fetch(songsUrl, { signal: controller.signal, cache: 'no-store' });
        clearTimeout(timeout);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && data.length > 0) {
            setApiSongs(data);
            studioOfflineDB.saveSongs(data).catch(() => {});
            addLog(`✅ Songs chargés depuis ${macUrl ? 'Mac' : 'Railway'}: ${data.length} chansons`);
          }
        }
      } catch {
        // Si Mac inaccessible, essayer Railway en fallback
        try {
          const res2 = await fetch('/api/songs', { cache: 'no-store' });
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
        const res = await fetch(`${macUrl}/api/songs`, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
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
    if (fresh && JSON.stringify(fresh.versions) !== JSON.stringify(selected.versions)) {
      setSelected(fresh);
      addLog(`🔄 Chanson mise à jour: ${fresh.versions?.length ?? 0} version(s)`);
    }
  }, [apiSongs]);

  const handleRefreshSong = async () => {
    if (!selected) return;
    addLog('🔄 Rechargement des données de la chanson...');
    try {
      const macUrl = (window as any).__CC_MAC_URL as string || '';
      const songsUrl = macUrl.startsWith('http') ? `${macUrl}/api/songs` : '/api/songs';
      const res = await fetch(songsUrl, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setApiSongs(data);
          studioOfflineDB.saveSongs(data).catch(() => {});
          const fresh = data.find((s: any) => s.id === selected.id);
          if (fresh) {
            setSelected(fresh);
            addLog(`✅ Stems rechargés depuis ${macUrl ? 'Mac' : 'Railway'}: ${fresh.versions?.length ?? 0} version(s)`);
          }
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
    setProject(proj);
    setMixDone(!!proj.mixedDataUrl);

    // Restaurer le slot actif depuis IDB (survit aux redémarrages iOS)
    studioOfflineDB.init().then(() =>
      studioOfflineDB.getState<string>(`takeSlot_${selected.id}`, 'A')
    ).then(saved => {
      if (saved && ['A','B','C'].includes(saved)) setTakeSlot(saved as 'A'|'B'|'C');
      else setTakeSlot('A');
    }).catch(() => setTakeSlot('A'));

    // Recharger les dataUrl depuis IndexedDB pour tous les tracks
    // RÈGLE : les blob: URLs sont éphémères (mortes au redémarrage iOS) — toujours les recréer depuis IDB
    // Les data: URLs base64 courtes (<100KB) sont conservées telles quelles
    if (proj.tracks.length > 0) {
      Promise.all(
        proj.tracks.map(async (track) => {
          // Réutiliser seulement les data: URLs base64 valides (pas les blob: qui meurent au redémarrage)
          const isLiveDataUrl = track.dataUrl && track.dataUrl.startsWith('data:') && track.dataUrl.length > 1000;
          if (isLiveDataUrl) return track;
          // Sinon charger depuis IndexedDB (clé principale)
          try {
            const blob = await studioOfflineDB.getAudio(`rec_${track.id}`);
            if (blob && blob.size > 1000) {
              // Utiliser URL.createObjectURL pour éviter l'OOM iOS sur les gros blobs
              // (blobToDataUrl crée une string base64 de 40 MB en mémoire)
              const dataUrl = URL.createObjectURL(blob);
              (window as any)[`__trackBlob_${track.id}`] = blob; // garder le blob vivant
              addLog(`💾 Slot ${track.takeSlot || track.trackIndex} rechargé depuis IndexedDB (${(blob.size/1024).toFixed(0)} KB)`);
              // Décoder en arrière-plan pour le cache harmonies (évite freeze iOS sur decodeAudioData)
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
              return { ...track, dataUrl };
            }
          } catch {}
          // Dernier recours : clé backup
          try {
            const backup = await studioOfflineDB.getAudio(`backup_voice_${track.id}`);
            if (backup && backup.size > 1000) {
              const dataUrl = URL.createObjectURL(backup);
              (window as any)[`__trackBlob_${track.id}`] = backup;
              addLog(`🛡 Slot ${track.takeSlot || track.trackIndex} restauré depuis BACKUP`);
              return { ...track, dataUrl };
            }
          } catch {}
          addLog(`⚠️ Slot ${track.takeSlot || track.trackIndex} — audio introuvable (id: ${track.id.slice(-6)})`);
          return track;
        })
      ).then(tracksWithData => {
        const hasAnyData = tracksWithData.some((t: any) => t.dataUrl);
        if (hasAnyData) {
          setProject(prev => prev ? { ...prev, tracks: tracksWithData } : prev);
        }
      }).catch(() => {});
    }
  }, [selected?.id]);

  // Calculer les prises existantes par slot pour la chanson sélectionnée
  const slotTakes = React.useMemo(() => {
    const takes: { A?: any; B?: any; C?: any } = {};
    if (!project) return takes;
    project.tracks.forEach(t => {
      if (t.trackIndex === 0 && !t.isGenerated && t.takeSlot) {
        takes[t.takeSlot as 'A' | 'B' | 'C'] = t;
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
  const handleDeleteTrack = (i: number) => updateProject(p => ({ ...p, tracks: p.tracks.filter(t => t.trackIndex !== i) }));

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
      bsrc.start(startAt);
      addLog(`inst BufferSource → start @ ctx+80ms`);
    }

    if (vocalBuf) {
      const vGain = ctx.createGain();
      vGain.gain.value = audio.vocalVolRef.current;
      const vsrc = ctx.createBufferSource();
      vsrc.buffer = vocalBuf;
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
      addLog(`vocal BufferSource → start @ ctx+80ms (même timestamp)`);
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
      // Couper le guide — l'ancien slot devient peut-être le slot actif
      const el = audio.vocalGuideRef.current;
      if (el) { el.pause(); el.src = ''; }
      setSlotGuideActive(null);
    }
    setTakeSlot(slot);
    // Persister le slot actif en IDB — survit aux redémarrages et à la pression mémoire iOS
    if (selected?.id) {
      studioOfflineDB.init().then(() =>
        studioOfflineDB.setState(`takeSlot_${selected.id}`, slot)
      ).catch(() => {});
    }
  };

  const handleMix = async (layerIds: string[] = []) => {
    if (!project || project.tracks.length === 0) return;
    setIsMixing(true); setMixProgress(5); setMixLabel('Préparation des pistes…');
    try {
      // Construire un projet temporaire incluant les slots layerisés
      let mixProject = { ...project };
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
      });
      // Stocker le blob mix en mémoire et utiliser une URL objet
      // (évite blobToDataUrl qui crash sur iOS pour les gros fichiers ~30MB)
      (window as any).__mixBlob = mixBlob;
      const mixUrl = URL.createObjectURL(mixBlob);
      if ((window as any).__mixUrl) URL.revokeObjectURL((window as any).__mixUrl);
      (window as any).__mixUrl = mixUrl;
      updateProject(p => ({ ...p, mixedDataUrl: mixUrl }));
      setMixDone(true);
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

  if (screen === 'master' && masterVocalBlob && selected) return <><DebugPanel debugLog={debugLog} onClear={() => setDebugLog([])} /><MasteringEngine vocalBlob={masterVocalBlob} instBlob={masterInstBlob} songTitle={selected.title} songId={selected.id} onBack={() => setScreen('mixer')} onStemReady={handleStemReady} isOnline={offline.isOnline} /></>;
  if (screen === 'comp' && selected) return <><DebugPanel debugLog={debugLog} onClear={() => setDebugLog([])} /><CompEditor song={selected} takes={compTakes} onBack={() => setScreen('mixer')} isOnline={offline.isOnline} onTakesChange={(updatedTakes) => {
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
            onCompReady={async (blob) => { const dataUrl = await studioService.blobToDataUrl(blob); const rec: MobileRecording = { id: `COMP-${Date.now()}`, songId: selected.id, songTitle: selected.title, artist: selected.artist || '', duration: compTakes.reduce((s,t)=>s+t.regions.reduce((rs,r)=>rs+(r.endSec-r.startSec),0),0), recordedAt: Date.now(), dataUrl, transferred: false, fileName: `COMP_${selected.title.replace(/\s+/g,'_')}_${Date.now()}.mp4`, trackLabel: 'Comp final', trackIndex: 99, projectId: project?.id }; studioService.saveRecordingLocally(rec); reloadRecordings(); if (project) { updateProject(p => ({ ...p, mixedDataUrl: dataUrl })); setMixDone(true); } setScreen('mixer'); }} /></>;
  if (screen === 'mixer' && selected && project) return <><DebugPanel debugLog={debugLog} onClear={() => setDebugLog([])} /><MixerScreen selected={selected} project={project} playingId={audio.playingId} isMixing={isMixing} mixProgress={mixProgress} mixLabel={mixLabel} mixDone={mixDone} isOnline={offline.isOnline} uploading={uploading} uploadDone={uploadDone} playRef={audio.playRef} instBlob={masterInstBlob} takeSlot={takeSlot} onBack={() => setScreen('record')} onGoSongs={() => setScreen('songs')} onAddTrack={() => setScreen('record')} onPlay={audio.playRecording} onMute={handleMuteTrack} onSolo={handleSoloTrack} onVolume={handleVolumeTrack} onPan={handlePanTrack} onDelete={handleDeleteTrack} onMix={(ids) => handleMix(ids)} onPlayMix={() => project?.mixedDataUrl && audio.playMix(project.mixedDataUrl)} onMasterize={async (vocalBlob, _) => { const ib = await getInstBlob(); handleMasterize(vocalBlob, ib); }} onUploadMix={handleUploadMix} onGoComp={(takes) => { setCompTakes(takes); setScreen('comp'); }} onProjectUpdate={(up) => { setProject(up); studioService.saveProject(up); reloadRecordings(); }} /></>;
  if (screen === 'record' && selected) return <><DebugPanel debugLog={debugLog} onClear={() => setDebugLog([])} /><RecordScreen selected={selected} project={project} currentPreset={currentPreset} reverb={reverb} isRecording={recorder.isRecording} isSaving={recorder.isSaving} duration={recorder.duration} analyser={recorder.analyser} vuLevel={recorder.vuLevel} monitoring={recorder.monitoring} permError={recorder.permError} httpsUrl={offline.httpsUrl} instUrl={audio.instUrl} instLoading={audio.instLoading} instCached={audio.instCached} vocalGuideUrl={audio.vocalGuideUrl} vocalLoading={audio.vocalLoading} vocalCached={audio.vocalCached} vocalGuideVol={audio.vocalGuideVol} showLyrics={showLyrics} instRef={audio.instRef} vocalGuideRef={audio.vocalGuideRef} getInstPlaybackTime={audio.getInstPlaybackTime} onRefreshSong={handleRefreshSong} onPreWarmMic={recorder.preWarmMic} onBack={() => { if (isPreviewingRef.current) { audio.instRef.current?.pause(); audio.vocalGuideRef.current?.pause(); try { (window as any).__instBufSrc?.stop(); } catch {} (window as any).__instBufSrc = null; (window as any).__instCtxActive = false; try { (window as any).__vocalBufSrc?.stop(); } catch {} (window as any).__vocalBufSrc = null; isPreviewingRef.current = false; setIsPreviewing(false); } setScreen('songs'); setSelected(null); }} onGoMixer={() => { if (isPreviewingRef.current) { audio.instRef.current?.pause(); audio.vocalGuideRef.current?.pause(); try { (window as any).__instBufSrc?.stop(); } catch {} (window as any).__instBufSrc = null; (window as any).__instCtxActive = false; try { (window as any).__vocalBufSrc?.stop(); } catch {} (window as any).__vocalBufSrc = null; isPreviewingRef.current = false; setIsPreviewing(false); } setScreen('mixer'); }} onPresetChange={setCurrentPreset} onReverbChange={setReverb} takeSlot={takeSlot} onTakeSlotChange={handleTakeSlotChange} slotTakes={slotTakes} onSlotGuide={handleSlotGuide} slotGuideActive={slotGuideActive}
        onStartRecording={() => { if (isPreviewingRef.current) { audio.instRef.current?.pause(); audio.vocalGuideRef.current?.pause(); try { (window as any).__instBufSrc?.stop(); } catch {} (window as any).__instBufSrc = null; (window as any).__instCtxActive = false; try { (window as any).__vocalBufSrc?.stop(); } catch {} (window as any).__vocalBufSrc = null; isPreviewingRef.current = false; setIsPreviewing(false); } if (selected && project) recorder.startRecording(selected, project); }} onStopRecording={() => { if (selected && project) recorder.stopRecording(selected, project, handleRecordingSaved); }} onToggleMonitor={recorder.toggleMonitoring} onVocalVolumeChange={audio.setVocalGuideVol} onToggleLyrics={() => setShowLyrics(v => !v)} onPreviewStems={handlePreviewStems} isPreviewing={isPreviewing} audioDevices={recorder.audioDevices} selectedDevice={recorder.selectedDevice} onSelectDevice={recorder.setSelectedDevice} onRefreshDevices={recorder.refreshDevices} punchIn={recorder.punchIn} punchOut={recorder.punchOut} onSetPunchIn={recorder.setPunchIn} onSetPunchOut={recorder.setPunchOut} stemDuration={audio.instRef.current?.duration || 0} sections={(project?.sections as any[] ?? [])} autoSelectReason={recorder.autoSelectReason} activeDeviceLabel={recorder.activeDeviceLabel} /></>;
  if (screen === 'recordings') return <><DebugPanel debugLog={debugLog} onClear={() => setDebugLog([])} /><RecordingsList recordings={recordings} pendingCount={pendingCount} playingId={audio.playingId} uploading={uploading} uploadDone={uploadDone} isOnline={offline.isOnline} playRef={audio.playRef} onBack={() => setScreen('songs')} onPlay={audio.playRecording} onUpload={handleUploadRecording} onDelete={handleDeleteRecording} /></>;
  return <><DebugPanel debugLog={debugLog} onClear={() => setDebugLog([])} /><SongSelector songs={originals} isOnline={offline.isOnline} isInstalled={offline.isInstalled} httpsUrl={offline.httpsUrl} cachedSongs={offline.cachedSongs} cachingId={offline.cachingId} cacheProgress={offline.cacheProgress} cacheError={offline.cacheError} cachedCount={offline.cachedCount} storage={offline.storage} storageWarning={offline.storageWarning} storageCritical={offline.storageCritical} pendingCount={pendingCount} cacheHealth={offline.cacheHealth} missingModules={offline.missingModules} repairProgress={offline.repairProgress} onSelect={(song) => { setSelected(song); setScreen('record'); audio.stopPlayback(); }} onInstall={offline.installPWA} onCache={(song) => offline.cacheSongForOffline(song, allSongs)} onForceRefresh={(song) => offline.forceRefreshSong(song, allSongs)}
            onImportFile={offline.importFileToCache} onClearCacheError={offline.clearCacheError} onRepairCache={offline.repairCache} onUncache={offline.uncacheSong} onClearAll={offline.clearAllCache} onViewRecordings={() => setScreen('recordings')} /></>;
}
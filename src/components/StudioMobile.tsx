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
const BUILD_VERSION = 'v7.6.27';

function ModeToggleButton() {
  const [autonomous, setAutonomous] = React.useState<boolean>(
    () => localStorage.getItem('cc_force_autonomous') === '1'
  );

  const toggle = () => {
    if (!autonomous) {
      // → Mode autonome : bloquer l'auto-détection Mac
      (window as any).__CC_MAC_URL_SAVED = (window as any).__CC_MAC_URL || localStorage.getItem('cc_mac_url') || '';
      (window as any).__CC_MAC_URL = '';
      localStorage.setItem('cc_force_autonomous', '1');
      setAutonomous(true);
      // Recharger pour que tout le code reparte sans URL Mac
      window.location.reload();
    } else {
      // → Mode Mac : enlever le flag, recharger pour que l'auto-détection reparte
      localStorage.removeItem('cc_force_autonomous');
      const saved = (window as any).__CC_MAC_URL_SAVED || localStorage.getItem('cc_mac_url') || '';
      if (saved) localStorage.setItem('cc_mac_url', saved);
      setAutonomous(false);
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
  const [mixDone, setMixDone] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [uploadDone, setUploadDone] = useState<string | null>(null);
  const [compTakes, setCompTakes] = useState<Take[]>([]);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [takeSlot, setTakeSlot] = useState<'A' | 'B' | 'C'>('A');
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [masterVocalBlob, setMasterVocalBlob] = useState<Blob | null>(null);
  const [masterInstBlob, setMasterInstBlob] = useState<Blob | null>(null);

  const addLog = (msg: string) => {
    const t = new Date().toISOString().slice(11,19);
    setDebugLog(prev => [`[${t}] ${msg}`, ...prev].slice(0, 20));
  };
  (window as any).__addLog = addLog;

  // Brancher addLog dans le hook offline dès le premier render
  useEffect(() => { offline.setOfflineLog(addLog); });

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
    studioService.getLocalRecordingsAsync().then(setRecordings).catch(() => setRecordings(studioService.getLocalRecordings()));
  }, []);
  
  useEffect(() => {
    if (!selected) return;
    const proj = studioService.getOrCreateProject(selected.id, selected.title);
    if (selected.key && !(proj as any).suggestedKey) (proj as any).suggestedKey = selected.key;
    setProject(proj);
    setMixDone(false);
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

  const handlePreviewStems = () => {
    const inst  = audio.instRef.current;
    const vocal = audio.vocalGuideRef.current;
    addLog(`PREVIEW tap | instUrl=${audio.instUrl ? audio.instUrl.slice(0,30) : 'NULL'} | instCached=${audio.instCached}`);

    if (isPreviewing) {
      inst?.pause(); vocal?.pause();
      try { (window as any).__instBufSrc?.stop();  } catch {} finally { (window as any).__instBufSrc  = null; (window as any).__instCtxActive = false; (window as any).__instWallStart = null; }
      try { (window as any).__vocalBufSrc?.stop(); } catch {} finally { (window as any).__vocalBufSrc = null; (window as any).__vocalBufGain = null; }
      setIsPreviewing(false);
      return;
    }

    // Résumer AudioContext en fire-and-forget — ne PAS attendre la Promise
    // play() doit rester dans la callstack synchrone du tap
    const ctx = (window as any).__warmContext as AudioContext | undefined;
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});

    const playEl = (el: HTMLAudioElement, label: string) => {
      el.currentTime = 0;
      const p = el.play();
      if (p) {
        p.then(() => addLog(`${label}.play() OK`))
         .catch((e: Error) => {
           addLog(`${label}.play() ERREUR: ${e.name} | src=${el.src.slice(0,40)}`);
           // Fallback AudioContext decodeAudioData (contourne les restrictions iOS sur <audio>)
           if (ctx && (e.name === 'NotSupportedError' || e.name === 'NotAllowedError')) {
             const bufKey = label === 'inst' ? '__instDecodedBuf' : '__vocalDecodedBuf';
             const playDecoded = (buf: AudioBuffer) => {
               const bsrc = ctx.createBufferSource();
               bsrc.buffer = buf;
               if (label === 'inst') {
                 bsrc.connect(ctx.destination);
                 (window as any).__instCtxStartTime = ctx.currentTime;
                 (window as any).__instCtxOffset    = 0;
                 (window as any).__instCtxActive    = true;
                 (window as any).__instWallStart    = Date.now();
                 (window as any).__instBufSrc       = bsrc;
                 bsrc.onended = () => { setIsPreviewing(false); (window as any).__instCtxActive = false; (window as any).__instBufSrc = null; (window as any).__instWallStart = null; };
               } else {
                 const vGain = ctx.createGain();
                 vGain.gain.value = audio.vocalVolRef.current;
                 bsrc.connect(vGain);
                 vGain.connect(ctx.destination);
                 (window as any).__vocalBufGain = vGain;
                 (window as any).__vocalBufSrc  = bsrc;
                 bsrc.onended = () => { (window as any).__vocalBufSrc = null; (window as any).__vocalBufGain = null; };
               }
               bsrc.start(0);
               addLog(label + ' AudioContext OK');
             };
             const tryPlay = (attempts: number) => {
               const decoded: AudioBuffer | null = (window as any)[bufKey] || null;
               if (decoded) { playDecoded(decoded); }
               else if (attempts > 0) { setTimeout(() => tryPlay(attempts - 1), 300); }
               else { fetch(el.src).then(r => r.arrayBuffer()).then(buf => ctx.decodeAudioData(buf)).then(playDecoded).catch(e2 => addLog(label + ' ERREUR: ' + e2.message)); }
             };
             tryPlay(10);
           }
         });
      }
    };

    if (inst && audio.instUrl) {
      if (!inst.src || inst.src !== audio.instUrl) {
        inst.src = audio.instUrl;
        inst.load();
        inst.addEventListener('canplay', () => playEl(inst, 'inst'), { once: true });
      } else {
        playEl(inst, 'inst');
      }
      inst.onended = () => { vocal?.pause(); setIsPreviewing(false); inst.onended = null; };
    } else {
      addLog(`PREVIEW: inst manquant | instUrl=${audio.instUrl} | instRef=${!!inst}`);
    }

    if (vocal && audio.vocalGuideUrl) {
      try { vocal.volume = audio.vocalVolRef.current; } catch {}
      if (!vocal.src || vocal.src !== audio.vocalGuideUrl) {
        vocal.src = audio.vocalGuideUrl;
        vocal.load();
        vocal.addEventListener('canplay', () => {
          playEl(vocal, 'vocal');
          audio.setVocalGuideVol(audio.vocalGuideVol);
        }, { once: true });
      } else {
        playEl(vocal, 'vocal');
        audio.setVocalGuideVol(audio.vocalGuideVol);
      }
    }

    setIsPreviewing(true);
  };

  const handleDeleteRecording = (id: string) => { studioService.deleteLocalRecording(id); reloadRecordings(); };
  const handleUploadRecording = async (rec: MobileRecording) => {
    setUploading(rec.id);
    try {
      let blob: Blob | null = null;
      try { blob = await studioOfflineDB.getAudio(`rec_${rec.id}`); } catch {}
      if (!blob && rec.dataUrl) blob = studioService.dataUrlToBlob(rec.dataUrl);
      if (!blob) { alert('Fichier introuvable.'); return; }
      const ok = await studioService.uploadToServer(rec, blob);
      if (ok) { studioService.markTransferred(rec.id); reloadRecordings(); setUploadDone(rec.id); setTimeout(() => setUploadDone(null), 3000); }
      else alert('Échec transfert.');
    } catch (e: any) { alert('Erreur : ' + e.message); }
    finally { setUploading(null); }
  };

  const handleMix = async () => {
    if (!project || project.tracks.length === 0) return;
    setIsMixing(true);
    try {
      const mixBlob = await studioService.mixProject(project);
      const dataUrl = await studioService.blobToDataUrl(mixBlob);
      updateProject(p => ({ ...p, mixedDataUrl: dataUrl }));
      setMixDone(true);
    } catch (e: any) { alert('Erreur mixage : ' + e.message); }
    finally { setIsMixing(false); }
  };

  const handleUploadMix = async () => {
    if (!project?.mixedDataUrl || !selected) return;
    setUploading('mix');
    try {
      const blob = studioService.dataUrlToBlob(project.mixedDataUrl);
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
  if (screen === 'comp' && selected) return <><DebugPanel debugLog={debugLog} onClear={() => setDebugLog([])} /><CompEditor song={selected} takes={compTakes} onBack={() => setScreen('mixer')} isOnline={offline.isOnline} onCompReady={async (blob) => { const dataUrl = await studioService.blobToDataUrl(blob); const rec: MobileRecording = { id: `COMP-${Date.now()}`, songId: selected.id, songTitle: selected.title, artist: selected.artist || '', duration: compTakes.reduce((s,t)=>s+t.regions.reduce((rs,r)=>rs+(r.endSec-r.startSec),0),0), recordedAt: Date.now(), dataUrl, transferred: false, fileName: `COMP_${selected.title.replace(/\s+/g,'_')}_${Date.now()}.mp4`, trackLabel: 'Comp final', trackIndex: 99, projectId: project?.id }; studioService.saveRecordingLocally(rec); reloadRecordings(); if (project) { updateProject(p => ({ ...p, mixedDataUrl: dataUrl })); setMixDone(true); } setScreen('mixer'); }} /></>;
  if (screen === 'mixer' && selected && project) return <><DebugPanel debugLog={debugLog} onClear={() => setDebugLog([])} /><MixerScreen selected={selected} project={project} playingId={audio.playingId} isMixing={isMixing} mixDone={mixDone} isOnline={offline.isOnline} uploading={uploading} uploadDone={uploadDone} playRef={audio.playRef} instBlob={masterInstBlob} onBack={() => setScreen('record')} onGoSongs={() => setScreen('songs')} onAddTrack={() => setScreen('record')} onPlay={audio.playRecording} onMute={handleMuteTrack} onSolo={handleSoloTrack} onVolume={handleVolumeTrack} onPan={handlePanTrack} onDelete={handleDeleteTrack} onMix={handleMix} onPlayMix={() => project?.mixedDataUrl && audio.playMix(project.mixedDataUrl)} onMasterize={async (vocalBlob, _) => { const ib = await getInstBlob(); handleMasterize(vocalBlob, ib); }} onUploadMix={handleUploadMix} onGoComp={(takes) => { setCompTakes(takes); setScreen('comp'); }} onProjectUpdate={(up) => { setProject(up); studioService.saveProject(up); reloadRecordings(); }} /></>;
  if (screen === 'record' && selected) return <><DebugPanel debugLog={debugLog} onClear={() => setDebugLog([])} /><RecordScreen selected={selected} project={project} currentPreset={currentPreset} reverb={reverb} isRecording={recorder.isRecording} isSaving={recorder.isSaving} duration={recorder.duration} analyser={recorder.analyser} vuLevel={recorder.vuLevel} monitoring={recorder.monitoring} permError={recorder.permError} httpsUrl={offline.httpsUrl} instUrl={audio.instUrl} instLoading={audio.instLoading} instCached={audio.instCached} vocalGuideUrl={audio.vocalGuideUrl} vocalLoading={audio.vocalLoading} vocalCached={audio.vocalCached} vocalGuideVol={audio.vocalGuideVol} showLyrics={showLyrics} instRef={audio.instRef} vocalGuideRef={audio.vocalGuideRef} getInstPlaybackTime={audio.getInstPlaybackTime} onRefreshSong={handleRefreshSong} onPreWarmMic={recorder.preWarmMic} onBack={() => { if (isPreviewing) { audio.instRef.current?.pause(); audio.vocalGuideRef.current?.pause(); setIsPreviewing(false); } setScreen('songs'); setSelected(null); }} onGoMixer={() => { if (isPreviewing) { audio.instRef.current?.pause(); audio.vocalGuideRef.current?.pause(); setIsPreviewing(false); } setScreen('mixer'); }} onPresetChange={setCurrentPreset} onReverbChange={setReverb} takeSlot={takeSlot} onTakeSlotChange={setTakeSlot} slotTakes={slotTakes}
        onStartRecording={() => { if (isPreviewing) { audio.instRef.current?.pause(); audio.vocalGuideRef.current?.pause(); setIsPreviewing(false); } if (selected && project) recorder.startRecording(selected, project); }} onStopRecording={() => { if (selected && project) recorder.stopRecording(selected, project, handleRecordingSaved); }} onToggleMonitor={recorder.toggleMonitoring} onVocalVolumeChange={audio.setVocalGuideVol} onToggleLyrics={() => setShowLyrics(v => !v)} onPreviewStems={handlePreviewStems} isPreviewing={isPreviewing} audioDevices={recorder.audioDevices} selectedDevice={recorder.selectedDevice} onSelectDevice={recorder.setSelectedDevice} onRefreshDevices={recorder.refreshDevices} punchIn={recorder.punchIn} punchOut={recorder.punchOut} onSetPunchIn={recorder.setPunchIn} onSetPunchOut={recorder.setPunchOut} stemDuration={audio.instRef.current?.duration || 0} sections={(project?.sections as any[] ?? [])} autoSelectReason={recorder.autoSelectReason} activeDeviceLabel={recorder.activeDeviceLabel} /></>;
  if (screen === 'recordings') return <><DebugPanel debugLog={debugLog} onClear={() => setDebugLog([])} /><RecordingsList recordings={recordings} pendingCount={pendingCount} playingId={audio.playingId} uploading={uploading} uploadDone={uploadDone} isOnline={offline.isOnline} playRef={audio.playRef} onBack={() => setScreen('songs')} onPlay={audio.playRecording} onUpload={handleUploadRecording} onDelete={handleDeleteRecording} /></>;
  return <><DebugPanel debugLog={debugLog} onClear={() => setDebugLog([])} /><SongSelector songs={originals} isOnline={offline.isOnline} isInstalled={offline.isInstalled} httpsUrl={offline.httpsUrl} cachedSongs={offline.cachedSongs} cachingId={offline.cachingId} cacheProgress={offline.cacheProgress} cacheError={offline.cacheError} cachedCount={offline.cachedCount} storage={offline.storage} storageWarning={offline.storageWarning} pendingCount={pendingCount} cacheHealth={offline.cacheHealth} missingModules={offline.missingModules} repairProgress={offline.repairProgress} onSelect={(song) => { setSelected(song); setScreen('record'); audio.stopPlayback(); }} onInstall={offline.installPWA} onCache={(song) => offline.cacheSongForOffline(song, allSongs)} onForceRefresh={(song) => offline.forceRefreshSong(song, allSongs)}
            onImportFile={offline.importFileToCache} onClearCacheError={offline.clearCacheError} onRepairCache={offline.repairCache} onUncache={offline.uncacheSong} onClearAll={offline.clearAllCache} onViewRecordings={() => setScreen('recordings')} /></>;
}
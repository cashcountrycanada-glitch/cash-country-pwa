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
const BUILD_VERSION = 'v7.6.0';

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
        <span style={{ color:'#f59e0b', fontSize:15, fontWeight:900, letterSpacing:2 }}>
          {BUILD_VERSION}
        </span>
        <div style={{ display:'flex', gap:10, alignItems:'center' }}>
          {ctxRate && (
            <span style={{ color: rateColor, fontSize: 9, fontWeight: 900, fontFamily: 'monospace' }}>
              🎵 {ctxRate}Hz{ctxState === 'suspended' ? ' ⏸' : ''}
            </span>
          )}
          <span style={{ color:'#facc15', fontSize:9, fontWeight:900, textTransform:'uppercase' }}>
            {minimized ? `LOG(${debugLog.length})` : 'DEBUG'}
          </span>
          <button onClick={() => setMinimized(m => !m)} style={{ color:'#a1a1aa', fontSize:9, background:'none', border:'none' }}>
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
          color: l.includes('❌') || l.includes('ERREUR') ? '#ef4444'
            : l.includes('✅') || l.includes('SUCCÈS') ? '#22c55e'
            : l.includes('⚠️') ? '#f59e0b'
            : '#a1a1aa',
          borderBottom:'1px solid #1a1a1a', paddingBottom:2, marginBottom:2,
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
        const res = await fetch('/api/songs', { signal: controller.signal, cache: 'no-store' });
        clearTimeout(timeout);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) {
            setApiSongs(data);
            studioOfflineDB.saveSongs(data).catch(() => {});
          }
        }
      } catch {}
    })();
  }, []);

  // ── WARM-UP AUDIO — iOS + Android/Desktop ─────────────────────────────────
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
    return () => document.removeEventListener('visibilitychange', handleVisibility);
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

  const handlePreviewStems = async () => {
    const inst = audio.instRef.current;
    const vocal = audio.vocalGuideRef.current;
    addLog(`PREVIEW tap | instUrl=${audio.instUrl ? audio.instUrl.slice(0,30) : 'NULL'}`);
    if (isPreviewing) {
      inst?.pause(); vocal?.pause(); setIsPreviewing(false);
    } else {
      const waitReady = (el: HTMLAudioElement): Promise<void> => new Promise(resolve => {
        if (el.readyState >= 3) { resolve(); return; }
        const onReady = () => { el.removeEventListener('canplay', onReady); resolve(); };
        el.addEventListener('canplay', onReady);
        setTimeout(resolve, 3000);
      });
      const toWait: Promise<void>[] = [];
      if (inst && audio.instUrl) toWait.push(waitReady(inst));
      if (vocal && audio.vocalGuideUrl) toWait.push(waitReady(vocal));
      await Promise.all(toWait);
      if (inst && audio.instUrl) inst.currentTime = 0;
      if (vocal && audio.vocalGuideUrl) vocal.currentTime = 0;
      const plays: Promise<void>[] = [];
      if (inst && audio.instUrl) plays.push(inst.play().then(() => addLog('inst.play() SUCCÈS')).catch(e => addLog(`inst.play() ERREUR: ${e.name}`)));
      if (vocal && audio.vocalGuideUrl) {
        // Forcer le volume avant play — GainNode peut être absent si AudioContext pas encore actif
        try { vocal.volume = audio.vocalVolRef.current; } catch {}
        plays.push(vocal.play().then(() => {
          addLog('vocal.play() SUCCÈS');
          // Appliquer GainNode maintenant que l'AudioContext est actif
          audio.setVocalGuideVol(audio.vocalGuideVol);
        }).catch(e => addLog(`vocal.play() ERREUR: ${e.name}`)));
      }
      Promise.all(plays).catch(() => {});
      setIsPreviewing(true);
      if (inst) inst.onended = () => { vocal?.pause(); setIsPreviewing(false); inst.onended = null; };
    }
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
  const handleRecordingSaved = (rec: MobileRecording, up: TrackProject | null) => { if (up) setProject(up); reloadRecordings(); setScreen('mixer'); };
  const getInstBlob = async (): Promise<Blob | null> => { if (!audio.instUrl) return null; try { return await studioOfflineDB.getAudio(`inst_${selected?.id}`); } catch { return null; } };
  const pendingCount = recordings.filter(r => !r.transferred).length;

  if (screen === 'master' && masterVocalBlob && selected) return <MasteringEngine vocalBlob={masterVocalBlob} instBlob={masterInstBlob} songTitle={selected.title} songId={selected.id} onBack={() => setScreen('mixer')} onStemReady={handleStemReady} isOnline={offline.isOnline} />;
  if (screen === 'comp' && selected) return <CompEditor song={selected} takes={compTakes} onBack={() => setScreen('mixer')} isOnline={offline.isOnline} onCompReady={async (blob) => { const dataUrl = await studioService.blobToDataUrl(blob); const rec: MobileRecording = { id: `COMP-${Date.now()}`, songId: selected.id, songTitle: selected.title, artist: selected.artist || '', duration: compTakes.reduce((s,t)=>s+t.regions.reduce((rs,r)=>rs+(r.endSec-r.startSec),0),0), recordedAt: Date.now(), dataUrl, transferred: false, fileName: `COMP_${selected.title.replace(/\s+/g,'_')}_${Date.now()}.mp4`, trackLabel: 'Comp final', trackIndex: 99, projectId: project?.id }; studioService.saveRecordingLocally(rec); reloadRecordings(); if (project) { updateProject(p => ({ ...p, mixedDataUrl: dataUrl })); setMixDone(true); } setScreen('mixer'); }} />;
  if (screen === 'mixer' && selected && project) return <MixerScreen selected={selected} project={project} playingId={audio.playingId} isMixing={isMixing} mixDone={mixDone} isOnline={offline.isOnline} uploading={uploading} uploadDone={uploadDone} playRef={audio.playRef} instBlob={masterInstBlob} onBack={() => setScreen('record')} onGoSongs={() => setScreen('songs')} onAddTrack={() => setScreen('record')} onPlay={audio.playRecording} onMute={handleMuteTrack} onSolo={handleSoloTrack} onVolume={handleVolumeTrack} onPan={handlePanTrack} onDelete={handleDeleteTrack} onMix={handleMix} onPlayMix={() => project?.mixedDataUrl && audio.playMix(project.mixedDataUrl)} onMasterize={async (vocalBlob, _) => { const ib = await getInstBlob(); handleMasterize(vocalBlob, ib); }} onUploadMix={handleUploadMix} onGoComp={(takes) => { setCompTakes(takes); setScreen('comp'); }} onProjectUpdate={(up) => { setProject(up); studioService.saveProject(up); reloadRecordings(); }} />;
  if (screen === 'record' && selected) return <><DebugPanel debugLog={debugLog} onClear={() => setDebugLog([])} /><RecordScreen selected={selected} project={project} currentPreset={currentPreset} reverb={reverb} isRecording={recorder.isRecording} isSaving={recorder.isSaving} duration={recorder.duration} analyser={recorder.analyser} vuLevel={recorder.vuLevel} monitoring={recorder.monitoring} permError={recorder.permError} httpsUrl={offline.httpsUrl} instUrl={audio.instUrl} instLoading={audio.instLoading} vocalGuideUrl={audio.vocalGuideUrl} vocalLoading={audio.vocalLoading} vocalGuideVol={audio.vocalGuideVol} showLyrics={showLyrics} instRef={audio.instRef} vocalGuideRef={audio.vocalGuideRef} onPreWarmMic={recorder.preWarmMic} onBack={() => { if (isPreviewing) { audio.instRef.current?.pause(); audio.vocalGuideRef.current?.pause(); setIsPreviewing(false); } setScreen('songs'); setSelected(null); }} onGoMixer={() => { if (isPreviewing) { audio.instRef.current?.pause(); audio.vocalGuideRef.current?.pause(); setIsPreviewing(false); } setScreen('mixer'); }} onPresetChange={setCurrentPreset} onReverbChange={setReverb} takeSlot={takeSlot} onTakeSlotChange={setTakeSlot} slotTakes={slotTakes}
        onStartRecording={() => { if (isPreviewing) { audio.instRef.current?.pause(); audio.vocalGuideRef.current?.pause(); setIsPreviewing(false); } if (selected && project) recorder.startRecording(selected, project); }} onStopRecording={() => { if (selected && project) recorder.stopRecording(selected, project, handleRecordingSaved); }} onToggleMonitor={recorder.toggleMonitoring} onVocalVolumeChange={audio.setVocalGuideVol} onToggleLyrics={() => setShowLyrics(v => !v)} onPreviewStems={handlePreviewStems} isPreviewing={isPreviewing} audioDevices={recorder.audioDevices} selectedDevice={recorder.selectedDevice} onSelectDevice={recorder.setSelectedDevice} onRefreshDevices={recorder.refreshDevices} punchIn={recorder.punchIn} punchOut={recorder.punchOut} onSetPunchIn={recorder.setPunchIn} onSetPunchOut={recorder.setPunchOut} stemDuration={audio.instRef.current?.duration || 0} sections={(project?.sections as any[] ?? [])} bluetoothMicDetected={recorder.bluetoothMicDetected} forcedBuiltinMic={recorder.forcedBuiltinMic} /></>;
  if (screen === 'recordings') return <RecordingsList recordings={recordings} pendingCount={pendingCount} playingId={audio.playingId} uploading={uploading} uploadDone={uploadDone} isOnline={offline.isOnline} playRef={audio.playRef} onBack={() => setScreen('songs')} onPlay={audio.playRecording} onUpload={handleUploadRecording} onDelete={handleDeleteRecording} />;
  return <><SongSelector songs={originals} isOnline={offline.isOnline} isInstalled={offline.isInstalled} httpsUrl={offline.httpsUrl} cachedSongs={offline.cachedSongs} cachingId={offline.cachingId} cacheProgress={offline.cacheProgress} cacheError={offline.cacheError} cachedCount={offline.cachedCount} storage={offline.storage} storageWarning={offline.storageWarning} pendingCount={pendingCount} cacheHealth={offline.cacheHealth} missingModules={offline.missingModules} repairProgress={offline.repairProgress} onSelect={(song) => { setSelected(song); setScreen('record'); audio.stopPlayback(); }} onInstall={offline.installPWA} onCache={(song) => offline.cacheSongForOffline(song, allSongs)} onForceRefresh={(song) => offline.forceRefreshSong(song, allSongs)}
            onImportFile={offline.importFileToCache} onClearCacheError={offline.clearCacheError} onRepairCache={offline.repairCache} onUncache={offline.uncacheSong} onClearAll={offline.clearAllCache} onViewRecordings={() => setScreen('recordings')} /></>;
}
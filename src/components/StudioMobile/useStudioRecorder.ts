/**
 * useStudioRecorder.ts — v7.8
 *
 * LOGIQUE DE SÉLECTION MICRO — 3 SETUPS RÉELS :
 *
 * Setup 1 — Micro cravate (récepteur dans prise Lightning/USB-C) + écouteurs BT
 *   → iOS voit le récepteur comme "External Microphone" ou "Headset Microphone"
 *   → PRIORITÉ 1 : sélectionné automatiquement en mode Auto
 *   → Les écouteurs BT restent en A2DP (pas de HFP car micro = filaire externe)
 *
 * Setup 2 — Carte son V8 (USB-C) + micro condensateur + écouteurs filaires sur V8
 *   → iOS voit la V8 comme interface USB (label: "USB Audio", "V8", etc.)
 *   → PRIORITÉ 1 : sélectionnée automatiquement
 *   → Zéro HFP, qualité maximale
 *
 * Setup 3 — Aucun externe, écouteurs BT uniquement
 *   → PRIORITÉ 2 : forcer Built-in iPhone pour garder les écouteurs en A2DP
 *
 * Mode Manuel : sélection utilisateur TOUJOURS respectée, aucune surcharge.
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { studioService, ReverbType, MobileRecording, TrackProject } from '../../services/StudioService';
import { studioOfflineDB } from '../../services/StudioOfflineDB';
import { Song } from '../../types';
import { TrackPreset } from './studio.types';

function labelFromDeviceId(deviceId: string): string {
  if (deviceId === 'default') return '🎙 Micro par défaut';
  if (deviceId === 'communications') return '🎙 Micro communications';
  return `🎙 Micro ${deviceId.slice(0, 6)}...`;
}

function classifyDevice(label: string): 'bluetooth' | 'external' | 'builtin' | 'unknown' {
  if (/airpods|bluetooth|buds|jbl|beats|bose|sony|plantronics|jabra|poly|sennheiser|samsung galaxy buds|anker|soundcore/i.test(label)) return 'bluetooth';
  if (/external microphone|headset microphone|usb audio|usb mic|rode|dji|v8|focusrite|scarlett|behringer|zoom|tascam|interface|audio codec/i.test(label)) return 'external';
  if (/built.?in|internal|iphone microphone|microphone intégré/i.test(label)) return 'builtin';
  return 'unknown';
}

export interface AudioDevice {
  deviceId: string;
  label: string;
  category: 'bluetooth' | 'external' | 'builtin' | 'unknown';
}

export type AutoSelectReason = 'external' | 'builtin_hfp' | 'default' | 'manual';

interface RecorderOptions {
  reverb: ReverbType;
  currentPreset: TrackPreset;
  instUrl: string | null;
  vocalGuideUrl: string | null;
  vocalGuideVol: number;
  vocalGuideVolRef: React.RefObject<number>;
  instRef: React.RefObject<HTMLAudioElement>;
  vocalGuideRef: React.RefObject<HTMLAudioElement>;
  backingTracks?: { dataUrl: string; gain: number; pan: number; trackIndex?: number }[];
  sections?: any[];
  onLog?: (msg: string) => void;
  takeSlot?: 'A' | 'B' | 'C';
}

interface RecorderResult {
  isRecording: boolean;
  isSaving: boolean;
  duration: number;
  analyser: AnalyserNode | null;
  vuLevel: number;
  monitoring: boolean;
  permError: boolean;
  audioDevices: AudioDevice[];
  selectedDevice: string | null;
  setSelectedDevice: (id: string | null) => void;
  refreshDevices: () => Promise<void>;
  punchIn: number | null;
  punchOut: number | null;
  setPunchIn: (v: number | null) => void;
  setPunchOut: (v: number | null) => void;
  setPermError: (v: boolean) => void;
  toggleMonitoring: () => void;
  preWarmMic: () => Promise<void>;
  startRecording: (song: Song, project: TrackProject) => Promise<void>;
  stopRecording: (song: Song, project: TrackProject, onSaved: (rec: MobileRecording, updatedProject: TrackProject | null) => void) => void;
  vocalGainNodeRef: React.RefObject<GainNode | null>;
  autoSelectReason: AutoSelectReason;
  activeDeviceLabel: string;
}

function resolveAutoDevice(
  devices: AudioDevice[],
  log: (m: string) => void,
): { deviceId: string | undefined; reason: AutoSelectReason; label: string } {
  const external = devices.find(d => d.category === 'external');
  const builtin  = devices.find(d => d.category === 'builtin');
  const hasBT    = devices.some(d => d.category === 'bluetooth');

  // Priorité 1 : micro externe filaire/USB (cravate, V8)
  if (external) {
    log(`✅ AUTO → Externe : "${external.label}"`);
    return { deviceId: external.deviceId, reason: 'external', label: external.label };
  }

  // Priorité 2 : Bluetooth détecté → forcer builtin pour garder A2DP
  if (hasBT) {
    if (builtin) {
      log(`🛡 AUTO → Builtin forcé (${builtin.label}) — A2DP protégé`);
      return { deviceId: builtin.deviceId, reason: 'builtin_hfp', label: builtin.label };
    }
    // BT sans builtin identifiable → undefined, iOS prend intégré par défaut
    log('🛡 AUTO → Défaut iOS (BT présent — builtin introuvable)');
    return { deviceId: undefined, reason: 'builtin_hfp', label: 'Micro iPhone' };
  }

  // Pas de BT, pas d'externe → défaut iOS
  log('AUTO → Défaut iOS');
  return { deviceId: undefined, reason: 'default', label: 'Micro iPhone' };
}

export function useStudioRecorder(opts: RecorderOptions): RecorderResult {
  const optsRef = useRef(opts);
  useEffect(() => { optsRef.current = opts; }); // sync every render, no deps
  const [isRecording, setIsRecording]   = useState(false);
  const [isSaving, setIsSaving]         = useState(false);
  const [duration, setDuration]         = useState(0);
  const [analyser, setAnalyser]         = useState<AnalyserNode | null>(null);
  const [vuLevel, setVuLevel]           = useState<number>(0);
  const [monitoring, setMonitoring]     = useState(false);
  const [permError, setPermError]       = useState(false);
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null);
  const [punchIn, setPunchIn]   = useState<number | null>(null);
  const [punchOut, setPunchOut] = useState<number | null>(null);
  const [autoSelectReason, setAutoSelectReason] = useState<AutoSelectReason>('default');
  const [activeDeviceLabel, setActiveDeviceLabel] = useState<string>('');

  const punchInRef  = useRef<number | null>(null);
  const punchOutRef = useRef<number | null>(null);
  useEffect(() => { punchInRef.current  = punchIn;  }, [punchIn]);
  useEffect(() => { punchOutRef.current = punchOut; }, [punchOut]);

  const audioDevicesRef = useRef<AudioDevice[]>([]);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const raw = await navigator.mediaDevices.enumerateDevices();
      const mics: AudioDevice[] = raw
        .filter(d => d.kind === 'audioinput')
        .map(d => ({
          deviceId: d.deviceId,
          label: d.label || labelFromDeviceId(d.deviceId),
          category: classifyDevice(d.label || ''),
        }));
      setAudioDevices(mics);
      audioDevicesRef.current = mics;
      const ext = mics.find(m => m.category === 'external');
      const bt  = mics.find(m => m.category === 'bluetooth');
      if (ext) optsRef.current.onLog?.(`🎙 Externe détecté : ${ext.label}`);
      if (bt)  optsRef.current.onLog?.(`🎧 Bluetooth : ${bt.label}`);
    } catch {}
  }, []);

  const backingRefsRef = useRef<HTMLAudioElement[]>([]);
  useEffect(() => {
    return () => { backingRefsRef.current.forEach(el => { el.pause(); el.src = ''; }); backingRefsRef.current = []; };
  }, []);
  useEffect(() => {
    refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
  }, [refreshDevices]);

  const recorderRef         = useRef<MediaRecorder | null>(null);
  const audioCtxRef         = useRef<AudioContext | null>(null);
  const chunksRef           = useRef<Blob[]>([]);
  const streamRef           = useRef<MediaStream | null>(null);
  const timerRef            = useRef<any>(null);
  const monitorGainRef      = useRef<GainNode | null>(null);
  const sourceNodeRef       = useRef<MediaStreamAudioSourceNode | null>(null);
  const monitorConnectedRef = useRef(false);
  const stopWorkletRef      = useRef<(() => Blob) | null>(null);
  const vocalGainNodeRef    = useRef<GainNode | null>(null);
  const durationRef         = useRef(0);
  const syncDuration = (d: number) => { durationRef.current = d; };

  const permissionGrantedRef = useRef(false);
  const preWarmMic = useCallback(async () => {
    if (permissionGrantedRef.current) return;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      let ctx = (window as any).__warmContext as AudioContext | undefined;
      if (!ctx || ctx.state === 'closed') {
        ctx = new AudioCtx({ latencyHint: 'interactive' });
        (window as any).__warmContext = ctx;
        (window as any).__warmWorkletLoaded = null;
      }
      if (ctx.state === 'suspended') await ctx.resume();
      // Buffer silencieux 1 sample → stabilise AVAudioSession
      const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
      const src = ctx.createBufferSource(); src.buffer = buf;
      const mute = ctx.createGain(); mute.gain.value = 0;
      src.connect(mute); mute.connect(ctx.destination); src.start();
      // getUserMedia → acquiert permission + énumère les vrais labels
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
      s.getTracks().forEach(t => t.stop());
      permissionGrantedRef.current = true;
      optsRef.current.onLog?.(`✅ Warm-up OK | ${ctx.sampleRate}Hz`);
      await refreshDevices(); // Maintenant les labels sont disponibles
    } catch (e: any) {
      optsRef.current.onLog?.(`⚠️ Warm-up : ${e.message}`);
      setPermError(true);
    }
  }, [refreshDevices]);

  const startRecording = useCallback(async (song: Song, project: TrackProject) => {
    if (!song) return;
    try {
      optsRef.current.onLog?.('═══ TAP REC ═══');
      const pIn  = punchInRef.current;
      const pOut = punchOutRef.current;

      // 1. Stems de référence — synchronisation sample-accurate via AudioContext
      // On force TOUJOURS le path AudioContext (pas <audio>.play) pour garantir l'alignement
      // C'est le même mécanisme que le PREVIEW qui est parfaitement synchro
      const startStemsSync = async () => {
        const ctx = (window as any).__warmContext as AudioContext | undefined;
        const t = pIn ?? 0;

        // Stopper les sources AudioContext précédentes
        try { (window as any).__instBufSrc?.stop(); }  catch {}
        try { (window as any).__vocalBufSrc?.stop(); } catch {}
        (window as any).__instBufSrc = null;
        (window as any).__vocalBufSrc = null;

        // Aussi couper les éléments <audio> (ils ne serviront pas pendant rec)
        const instEl  = optsRef.current.instRef.current;
        const vocalEl = optsRef.current.vocalGuideRef.current;
        if (instEl)  { instEl.pause();  instEl.currentTime = t; }
        if (vocalEl) { vocalEl.pause(); vocalEl.currentTime = t; }

        if (!ctx) {
          // Fallback ultime : <audio>.play() séquentiel (pas idéal mais fonctionnel)
          if (instEl  && optsRef.current.instUrl)       { instEl.play().catch(()=>{}); }
          if (vocalEl && optsRef.current.vocalGuideUrl) { vocalEl.play().catch(()=>{}); }
          return;
        }

        // Charger les deux buffers (déjà décodés en mémoire si PREVIEW a été fait)
        const instBufRaw:  AudioBuffer | null = (window as any).__instDecodedBuf  || null;
        const vocalBufRaw: AudioBuffer | null = (window as any).__vocalDecodedBuf || null;

        const fetchBuf = async (url: string): Promise<AudioBuffer | null> => {
          try {
            const r = await fetch(url);
            const ab = await r.arrayBuffer();
            return await ctx.decodeAudioData(ab);
          } catch { return null; }
        };

        const [instBuf, vocalBuf] = await Promise.all([
          instBufRaw  ? Promise.resolve(instBufRaw)
            : (optsRef.current.instUrl       ? fetchBuf(optsRef.current.instUrl)       : Promise.resolve(null)),
          vocalBufRaw ? Promise.resolve(vocalBufRaw)
            : (optsRef.current.vocalGuideUrl ? fetchBuf(optsRef.current.vocalGuideUrl) : Promise.resolve(null)),
        ]);

        // Un seul startAt pour les deux — synchronisation sample-accurate garantie
        const startAt = ctx.currentTime + 0.05;

        if (instBuf) {
          const bsrc = ctx.createBufferSource();
          bsrc.buffer = instBuf;
          // iOS réduit le volume AudioContext ~50% quand le micro est actif (Voice Processing)
          // On compense avec un gain de 1.4 (2.0 était trop fort — écrasait la voix)
          const instGain = ctx.createGain();
          instGain.gain.value = 1.4;
          bsrc.connect(instGain);
          instGain.connect(ctx.destination);
          (window as any).__instBufSrc    = bsrc;
          (window as any).__instGainNode  = instGain;
          (window as any).__instCtxActive = true;
          (window as any).__instCtxOffset = t;
          (window as any).__instCtxStartTime = startAt;
          const msUntilStart = (startAt - ctx.currentTime) * 1000;
          (window as any).__instWallStart = performance.now() + msUntilStart - (t * 1000);
          bsrc.onended = () => {
            (window as any).__instCtxActive = false;
            (window as any).__instBufSrc    = null;
            (window as any).__instGainNode  = null;
            (window as any).__instWallStart = null;
          };
          bsrc.start(startAt, t);
        } else if (instEl && optsRef.current.instUrl) {
          // Buffer non dispo → fallback <audio>
          instEl.play().catch(() => {});
        }

        if (vocalBuf && optsRef.current.vocalGuideUrl) {
          const vGain = ctx.createGain();
          vGain.gain.value = optsRef.current.vocalGuideVolRef?.current ?? 0.4;
          const vsrc = ctx.createBufferSource();
          vsrc.buffer = vocalBuf;
          vsrc.connect(vGain);
          vGain.connect(ctx.destination);
          (window as any).__vocalBufSrc  = vsrc;
          (window as any).__vocalBufGain = vGain;
          vsrc.onended = () => {
            (window as any).__vocalBufSrc  = null;
            (window as any).__vocalBufGain = null;
          };
          vsrc.start(startAt, t);  // ← même startAt que inst : synchro parfaite
        } else if (vocalEl && optsRef.current.vocalGuideUrl) {
          vocalEl.play().catch(() => {});
        }
      };

      await startStemsSync();

      if (optsRef.current.backingTracks && optsRef.current.backingTracks.length > 0) {
        backingRefsRef.current.forEach(el => { el.pause(); el.src = ''; });
        backingRefsRef.current = [];
        const sections: any[] = (optsRef.current as any).sections ?? [];
        const activeSec = pIn !== null ? sections.find((s: any) => Math.abs(s.startSec - pIn) < 2) : null;
        for (const bt of optsRef.current.backingTracks) {
          if (activeSec && bt.trackIndex !== undefined && !activeSec.activeHarmonies.includes(bt.trackIndex)) continue;
          let gain = bt.gain ?? 0.4;
          if (activeSec && bt.trackIndex !== undefined) { const sv = activeSec.harmonyVolumes?.[bt.trackIndex]; if (sv !== undefined) gain = sv * 0.6; }
          const el = new Audio(bt.dataUrl); el.playsInline = true; el.currentTime = pIn ?? 0; el.play().catch(() => {});
          backingRefsRef.current.push(el);
        }
      }

      // 2. Résoudre le device micro
      const currentDevices = audioDevicesRef.current;
      let effectiveDeviceId: string | undefined;
      let reason: AutoSelectReason;
      let deviceLabel: string;

      if (selectedDevice !== null) {
        // Sélection manuelle → TOUJOURS respectée, jamais surchargée
        effectiveDeviceId = selectedDevice;
        reason = 'manual';
        const found = currentDevices.find(d => d.deviceId === selectedDevice);
        deviceLabel = found?.label ?? `Device ${selectedDevice.slice(0, 8)}`;
        optsRef.current.onLog?.(`🎙 MANUEL → "${deviceLabel}"`);
        // Avertissement si l'utilisateur a sélectionné un micro BT manuellement
        if (found?.category === 'bluetooth') {
          optsRef.current.onLog?.('⚠️ Micro BT sélectionné manuellement — iOS peut basculer en HFP (son téléphonie). Préférer "Micro int." si qualité dégradée.');
        }
      } else {
        const resolved = resolveAutoDevice(currentDevices, optsRef.current.onLog ?? (() => {}));
        effectiveDeviceId = resolved.deviceId;
        reason = resolved.reason;
        deviceLabel = resolved.label;
      }

      setAutoSelectReason(reason);
      setActiveDeviceLabel(deviceLabel);

      // 3. Capture DRY
      optsRef.current.onLog?.(`🎤 Capture DRY → "${deviceLabel}"`);
      const result = await studioService.startRecordingPro({
        reverb: 'none' as any, saturation: 0, compression: false, gainL: 1.0, gainR: 1.0,
        deviceId: effectiveDeviceId,
      }, (level) => setVuLevel(level), optsRef.current.onLog);

      refreshDevices();
      const { recorder, chunks, context, stream, analyser: an, monitorGain, stopWorklet } = result;

      if (stream) {
        const track = stream.getAudioTracks()[0]; const s = track.getSettings();
        optsRef.current.onLog?.(`🎵 Stream : ${s.sampleRate ?? '?'}Hz · ${s.channelCount ?? '?'}ch`);
      }
      if (context) optsRef.current.onLog?.(`🎵 AudioContext : ${context.sampleRate}Hz ${context.sampleRate >= 44000 ? '✅' : '⚠️'}`);

      stopWorkletRef.current      = stopWorklet ?? null;
      recorderRef.current         = recorder;
      chunksRef.current           = chunks;
      audioCtxRef.current         = context;
      streamRef.current           = stream;
      monitorGainRef.current      = monitorGain;
      sourceNodeRef.current       = (result as any).sourceNode ?? null;
      monitorConnectedRef.current = false;

      setAnalyser(an);
      setIsRecording(true);
      setIsSaving(false);
      setDuration(0);
      durationRef.current = 0;
      setPermError(false);
      optsRef.current.onLog?.(`✅ REC — ${deviceLabel}`);

      timerRef.current = setInterval(() => {
        setDuration(d => {
          const next = d + 1; syncDuration(next);
          if (pOut !== null && next >= (pOut - (pIn ?? 0))) { recorderRef.current?.stop(); clearInterval(timerRef.current!); }
          return next;
        });
      }, 1000);

    } catch (e: any) {
      optsRef.current.onLog?.(`❌ Erreur REC : ${e.message}`);
      if (/Permission|denied|NotAllowed/i.test(e.message)) setPermError(true);
      else alert('Erreur micro : ' + e.message);
    }
  }, [selectedDevice, refreshDevices]);

  const stopRecording = useCallback((
    song: Song, project: TrackProject,
    onSaved: (rec: MobileRecording, updatedProject: TrackProject | null) => void,
  ) => {
    if ((!recorderRef.current && !stopWorkletRef.current) || !song || !project) return;
    clearInterval(timerRef.current);
    optsRef.current.instRef.current?.pause();
    optsRef.current.vocalGuideRef.current?.pause();
    // Stopper les BufferSourceNodes AudioContext (fallback iOS)
    try { (window as any).__instBufSrc?.stop();  } catch {} finally { (window as any).__instBufSrc  = null; (window as any).__instCtxActive = false; (window as any).__instWallStart = null; }
    try { (window as any).__vocalBufSrc?.stop(); } catch {} finally { (window as any).__vocalBufSrc = null; (window as any).__vocalBufGain = null; }
    backingRefsRef.current.forEach(el => { el.pause(); el.currentTime = 0; });
    backingRefsRef.current = [];
    if (monitorConnectedRef.current && monitorGainRef.current && audioCtxRef.current) {
      try { monitorGainRef.current.disconnect(audioCtxRef.current.destination); } catch {}
      monitorConnectedRef.current = false;
    }
    setMonitoring(false);

    // ── LIBÉRATION IMMÉDIATE DES RESSOURCES AUDIO ─────────────────────
    // Déconnecter sourceNode et stopper le stream AVANT handleSave
    // pour libérer iOS de AVAudioSession PlayAndRecord immédiatement.
    // Sans ça, iOS garde la session ouverte pendant tout le traitement
    // du blob, dégradant la lecture des stems pendant plusieurs secondes.
    if (sourceNodeRef.current) {
      try { sourceNodeRef.current.disconnect(); } catch {}
      sourceNodeRef.current = null;
    }
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    const isWarmCtx = audioCtxRef.current === (window as any).__warmContext;
    if (!isWarmCtx && audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    vocalGainNodeRef.current = null;
    setAnalyser(null);
    optsRef.current.onLog?.('🔓 Session micro fermée — stems restaurés');

    const handleSave = async (workletBlob?: Blob) => {
      setIsRecording(false); setIsSaving(true);
      try {
        // iOS coupe IndexedDB DÉFINITIVEMENT pendant AVAudioSession PlayAndRecord
        // Solution : ne pas attendre — sauvegarder en arrière-plan quand iOS le permet
        // ── Construire le blob audio ──────────────────────────────────────
        let blob: Blob;
        if (workletBlob && workletBlob.size > 0) {
          blob = workletBlob;
          optsRef.current.onLog?.(`💾 Blob AudioWorklet: ${(workletBlob.size / 1024).toFixed(0)} Ko WAV`);
        } else if (chunksRef.current.length > 0) {
          blob = new Blob(chunksRef.current, { type: chunksRef.current[0]?.type || 'audio/mp4' });
          optsRef.current.onLog?.(`💾 Blob MediaRecorder: ${(blob.size / 1024).toFixed(0)} Ko | chunks=${chunksRef.current.length}`);
        } else {
          // Aucune donnée — enregistrement trop court ou erreur capture
          optsRef.current.onLog?.('❌ Blob vide — aucune donnée capturée. Durée suffisante?');
          return;
        }

        if (blob.size < 1000) {
          optsRef.current.onLog?.(`⚠️ Blob suspect: ${blob.size} bytes — trop petit, probablement corrompu`);
        }

        // sourceNode et stream déjà libérés ci-dessus (avant handleSave)

        optsRef.current.onLog?.(`💾 Sauvegarde...`);

        // Sur iOS, si l'AudioWorklet a produit un WAV trop gros ET qu'on a des chunks MediaRecorder disponibles,
        // préférer les chunks (mp4 compressé natif iOS)
        let finalBlob = blob;
        if (blob.type.includes('wav') && blob.size > 5 * 1024 * 1024 && chunksRef.current.length > 0) {
          const mpBlob = new Blob(chunksRef.current, { type: chunksRef.current[0]?.type || 'audio/mp4' });
          if (mpBlob.size > 1000) {
            finalBlob = mpBlob;
            optsRef.current.onLog?.(`💾 WAV → mp4 (MediaRecorder): ${(finalBlob.size/1024).toFixed(0)} Ko (était ${(blob.size/1024).toFixed(0)} Ko WAV)`);
          }
        }

        const id = `REC-${Date.now()}`;
        const safeTitle = song.title.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
        const ext = finalBlob.type.includes('mp4') ? 'mp4' : finalBlob.type.includes('wav') ? 'wav' : 'webm';
        const fileName = `${safeTitle}_T${optsRef.current.currentPreset.index}_${Date.now()}.${ext}`;

        const dataUrl = await studioService.blobToDataUrl(finalBlob);
        optsRef.current.onLog?.(`✅ dataUrl: ${(dataUrl.length / 1024).toFixed(0)} Ko`);

        // Vérifier l'espace disponible et libérer les anciennes prises si nécessaire
        try {
          if (navigator.storage && navigator.storage.estimate) {
            const est = await navigator.storage.estimate();
            const usedMB  = ((est.usage  || 0) / 1024 / 1024).toFixed(0);
            const quotaMB = ((est.quota  || 0) / 1024 / 1024).toFixed(0);
            const freeMB  = (((est.quota || 0) - (est.usage || 0)) / 1024 / 1024).toFixed(0);
            optsRef.current.onLog?.(`💾 Stockage: ${usedMB}MB / ${quotaMB}MB — libre: ${freeMB}MB`);
            // Si moins de 10MB libres, supprimer les prises déjà transférées
            if (((est.quota || 0) - (est.usage || 0)) < 10 * 1024 * 1024) {
              optsRef.current.onLog?.('⚠️ Espace faible — nettoyage des prises transférées...');
              const allRecs = await studioService.getLocalRecordingsAsync();
              const transferred = allRecs.filter(r => r.transferred);
              for (const r of transferred) {
                await studioService.deleteLocalRecordingAsync(r.id).catch(() => {});
              }
              optsRef.current.onLog?.(`🗑 ${transferred.length} prise(s) transférée(s) supprimées`);
            }
          }
        } catch {}

        const rec: MobileRecording = {
          id, songId: song.id, songTitle: song.title, artist: song.artist || '',
          duration: durationRef.current, recordedAt: Date.now(), dataUrl, transferred: false,
          fileName, trackIndex: optsRef.current.currentPreset.index, trackLabel: optsRef.current.currentPreset.label,
          takeSlot: optsRef.current.currentPreset.index === 0 ? (optsRef.current.takeSlot ?? 'A') : undefined,
          pitchShift: optsRef.current.currentPreset.pitch, gain: optsRef.current.currentPreset.gain,
          pan: optsRef.current.currentPreset.pan, projectId: project.id,
        };

        // Décoder et mettre en cache l'AudioBuffer en arrière-plan (évite decodeAudioData au moment de générer les harmonies)
        finalBlob.arrayBuffer().then(ab => {
          const tmpCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
          return tmpCtx.decodeAudioData(ab).then(buf => {
            (window as any).__lastRecDecodedBuf = buf;
            (window as any).__lastRecDecodedId  = id;
            tmpCtx.close();
          }).catch(() => { tmpCtx.close(); });
        }).catch(() => {});
        // 1. Ajouter immédiatement au projet (dataUrl en mémoire) — prise disponible instantanément
        const updatedProject = studioService.addTrackToProject(project.id, rec);
        optsRef.current.onLog?.(`✅ Prise en mémoire (${(dataUrl.length/1024).toFixed(0)} KB) | slot=${optsRef.current.takeSlot ?? 'A'}`);
        onSaved(rec, updatedProject); // UI mise à jour tout de suite

        // 2. Sauvegarde via studioOfflineDB.saveAudio() — route vers OPFS Worker (createSyncAccessHandle)
        //    IMPORTANT : NE PAS utiliser createWritable() directement ici.
        //    Safari iOS ne supporte PAS FileSystemFileHandle.createWritable() sur le main thread.
        //    Seul le Worker OPFS (createSyncAccessHandle) fonctionne sur iOS.
        //    studioOfflineDB.saveAudio() route automatiquement vers ce Worker.
        const saveBlob = finalBlob; // capturer pour la closure async
        const saveRec  = rec;

        const saveViaOPFS = async (): Promise<boolean> => {
          try {
            await studioOfflineDB.init();
            await studioOfflineDB.saveAudio(`rec_${saveRec.id}`, saveBlob, {
              songId: saveRec.songId,
              songTitle: saveRec.songTitle,
              type: 'recording',
              savedAt: Date.now(),
            });
            const metaEntry = { ...saveRec, dataUrl: undefined };
            // 1. Métadonnées dans IDB (tentative — peut échouer pendant AVAudioSession)
            try {
              const metas = await studioOfflineDB.getState<any[]>('recordings', []);
              await studioOfflineDB.setState('recordings', [...metas.filter((r: any) => r.id !== saveRec.id), metaEntry]);
            } catch {
              optsRef.current.onLog?.('💾 Audio OK — métadonnées IDB échouées (non bloquant)');
            }
            // 2. Métadonnées dans localStorage — garantie absolue, survit aux crashes iOS
            //    Pas affecté par AVAudioSession. C'est le fallback final de getLocalRecordingsAsync.
            try {
              const lsRecs: any[] = JSON.parse(localStorage.getItem('cash_studio_recordings') || '[]');
              const updated = [...lsRecs.filter((r: any) => r.id !== saveRec.id), metaEntry];
              localStorage.setItem('cash_studio_recordings', JSON.stringify(updated));
              try { localStorage.removeItem(`emergency_${saveRec.id}`); } catch {}
            } catch {}
            const backend = await studioOfflineDB.checkOPFS() ? 'OPFS' : 'IDB';
            optsRef.current.onLog?.(`💾 ✅ Prise sécurisée ${backend} → rec_${saveRec.id} (${(saveBlob.size/1024).toFixed(0)} Ko)`);
            return true;
          } catch (opfsErr: any) {
            optsRef.current.onLog?.(`⚠️ saveAudio échoué: ${opfsErr?.message} — fallback IDB`);
            return false;
          }
        };

        const saveViaIDB = async (): Promise<boolean> => {
          try {
            await studioOfflineDB.init();
            await studioService.saveRecordingLocallyAsync(saveRec);
            const ok = await studioOfflineDB.hasAudio(`rec_${saveRec.id}`);
            if (ok) {
              optsRef.current.onLog?.('💾 ✅ Prise sécurisée IndexedDB');
              try { localStorage.removeItem(`emergency_${saveRec.id}`); } catch {}
              return true;
            }
            return false;
          } catch {
            return false;
          }
        };

        // Ajouter à la file de sauvegarde différée (tentatives OPFS + IDB)
        const pending = (window as any).__pendingSaves as any[] || [];
        pending.push({ rec: saveRec, blob: saveBlob, timestamp: Date.now() });
        (window as any).__pendingSaves = pending;
        optsRef.current.onLog?.('💾 Sauvegarde différée — OPFS prioritaire...');

        // Fonction globale de traitement de la file
        // IMPORTANT : chaque item utilise ses propres rec/blob (pas la closure externe)
        const processPendingQueue = async () => {
          const queue = (window as any).__pendingSaves as any[] || [];
          if (!queue.length) return;
          const saved: any[] = [];
          for (const item of queue) {
            const itemRec  = item.rec  as typeof saveRec;
            const itemBlob = item.blob as typeof saveBlob;

            const saveItemViaOPFS = async (): Promise<boolean> => {
              try {
                await studioOfflineDB.init();
                await studioOfflineDB.saveAudio(`rec_${itemRec.id}`, itemBlob, {
                  songId: itemRec.songId, songTitle: itemRec.songTitle,
                  type: 'recording', savedAt: Date.now(),
                });
                const metaEntry = { ...itemRec, dataUrl: undefined };
                try {
                  const metas = await studioOfflineDB.getState<any[]>('recordings', []);
                  await studioOfflineDB.setState('recordings', [...metas.filter((r: any) => r.id !== itemRec.id), metaEntry]);
                } catch {}
                // localStorage — garantie absolue
                try {
                  const lsRecs: any[] = JSON.parse(localStorage.getItem('cash_studio_recordings') || '[]');
                  localStorage.setItem('cash_studio_recordings', JSON.stringify([...lsRecs.filter((r: any) => r.id !== itemRec.id), metaEntry]));
                  try { localStorage.removeItem(`emergency_${itemRec.id}`); } catch {}
                } catch {}
                const backend = await studioOfflineDB.checkOPFS() ? 'OPFS' : 'IDB';
                optsRef.current.onLog?.(`💾 ✅ Prise différée sauvegardée ${backend} → ${itemRec.id}`);
                return true;
              } catch { return false; }
            };

            const saveItemViaIDB = async (): Promise<boolean> => {
              try {
                await studioOfflineDB.init();
                await studioService.saveRecordingLocallyAsync(itemRec);
                const ok = await studioOfflineDB.hasAudio(`rec_${itemRec.id}`);
                if (ok) {
                  optsRef.current.onLog?.('💾 ✅ Prise différée sauvegardée IDB');
                  try { localStorage.removeItem(`emergency_${itemRec.id}`); } catch {}
                  return true;
                }
                return false;
              } catch { return false; }
            };

            // Tenter OPFS d'abord (Worker createSyncAccessHandle — stable sur iOS)
            const opfsOk = await saveItemViaOPFS().catch(() => false);
            if (opfsOk) { saved.push(item); continue; }
            // Fallback IDB avec 3 tentatives
            for (let attempt = 0; attempt < 3; attempt++) {
              const idbOk = await saveItemViaIDB().catch(() => false);
              if (idbOk) { saved.push(item); break; }
              await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            }
          }
          (window as any).__pendingSaves = queue.filter((q: any) => !saved.includes(q));
          if ((window as any).__pendingSaves.length > 0) {
            optsRef.current.onLog?.(`⚠️ ${(window as any).__pendingSaves.length} prise(s) encore en attente`);
          }
        };

        // Sauvegarder métadonnées d'urgence dans localStorage (survit aux crashes)
        try {
          localStorage.setItem(`emergency_${rec.id}`, JSON.stringify({
            id: rec.id, songId: rec.songId, songTitle: rec.songTitle,
            duration: rec.duration, recordedAt: rec.recordedAt,
            takeSlot: rec.takeSlot, projectId: rec.projectId,
          }));
        } catch {}

        // Tenter immédiatement
        processPendingQueue().catch(() => {});

        // Puis retenter à intervalles croissants sans bloquer l'UI
        [2000, 5000, 12000, 25000, 60000].forEach(delay => {
          setTimeout(() => processPendingQueue().catch(() => {}), delay);
        });

        // Et à chaque fois que l'app revient au premier plan
        const onVisible = () => {
          if (document.visibilityState === 'visible') processPendingQueue().catch(() => {});
        };
        document.addEventListener('visibilitychange', onVisible);
      } catch(e: any) {
        optsRef.current.onLog?.(`❌ Erreur sauvegarde: ${e.message}`);
      } finally { setIsSaving(false); }
    };

    if (stopWorkletRef.current) { const wavBlob = stopWorkletRef.current(); stopWorkletRef.current = null; handleSave(wavBlob); }
    else if (recorderRef.current) { recorderRef.current.onstop = () => handleSave(); recorderRef.current.stop(); }
  }, []);

  const toggleMonitoring = useCallback(() => {
    setMonitoring(v => {
      const next = !v;
      const gain = monitorGainRef.current; const ctx = audioCtxRef.current;
      if (gain && ctx) {
        if (next && !monitorConnectedRef.current) { gain.gain.value = 0.8; try { gain.connect(ctx.destination); } catch {} monitorConnectedRef.current = true; }
        else if (!next && monitorConnectedRef.current) { try { gain.disconnect(ctx.destination); } catch {} monitorConnectedRef.current = false; }
      }
      return next;
    });
  }, []);

  return {
    isRecording, isSaving, duration, analyser, vuLevel, monitoring, permError,
    audioDevices, selectedDevice, setSelectedDevice, refreshDevices,
    punchIn, punchOut, setPunchIn, setPunchOut,
    setPermError, toggleMonitoring, preWarmMic, startRecording, stopRecording,
    vocalGainNodeRef, autoSelectReason, activeDeviceLabel,
  };
}

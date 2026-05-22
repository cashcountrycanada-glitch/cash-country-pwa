import { studioOfflineDB } from './StudioOfflineDB';
/**
 * StudioService.ts — Pipeline d'enregistrement mobile v7.6
 *
 * RÉALITÉ iOS confirmée (WebKit Bugzilla #154538, Apple QA1631, ios-safe-audio-context) :
 *   • sampleRate dicté par AVAudioSession hardware : haut-parleur=48kHz, casque=44.1kHz.
 *   • On ne peut PAS forcer le sampleRate côté JS. On accepte le natif.
 *   • Warm-up : créer AudioContext + jouer 1 buffer silencieux dans un geste user → stable.
 *   • NE PAS stocker __warmStream : cloner un stream arrêté = silence. getUserMedia() direct.
 *   • addModule() UNE SEULE FOIS par contexte (flag __warmWorkletLoaded).
 *   • Nettoyage nodes précédents avant chaque prise (pas d'accumulation).
 *   • Capture SÈCHE (DRY) : config.reverb IGNORÉ — effets = post-prod uniquement.
 */
export type ReverbType = 'none' | 'room' | 'hall' | 'plate';
export interface StudioEffectsConfig {
  reverb: ReverbType;
  saturation: number;
  compression: boolean;
  gainL: number;
  gainR: number;
  deviceId?: string;
}
export interface MobileRecording {
  id: string; songId: string; songTitle: string; artist: string;
  duration: number; recordedAt: number; blob?: Blob; dataUrl?: string;
  transferred: boolean; fileName: string; trackIndex?: number; trackLabel?: string;
  pitchShift?: number; gain?: number; pan?: number; muted?: boolean; projectId?: string;
  isGenerated?: boolean; regions?: Region[];
  takeSlot?: 'A' | 'B' | 'C'; // Slot de prise voix principale
}
export interface Region { id: string; takeId: string; startSec: number; endSec: number; label?: string; color?: string; }
export interface Take { id: string; recording: MobileRecording; waveformData?: number[]; regions: Region[]; }
export interface TrackProject {
  id: string; songId: string; songTitle: string; createdAt: number;
  tracks: MobileRecording[]; takes?: Take[]; compRegions?: Region[];
  mixedDataUrl?: string; sections?: any[]; suggestedKey?: string;
}
const STORAGE_KEY = 'cash_studio_recordings';

function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function getBestMimeType(): string {
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=pcm')) return 'audio/webm;codecs=pcm';
  if (MediaRecorder.isTypeSupported('audio/mp4;codecs=pcm'))  return 'audio/mp4;codecs=pcm';
  if (MediaRecorder.isTypeSupported('audio/mp4;codecs=alac')) return 'audio/mp4;codecs=alac';
  if (isIOS()) return 'audio/mp4';
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
  if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
  if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4';
  return '';
}

async function pitchShiftBuffer(ctx: OfflineAudioContext | AudioContext, buffer: AudioBuffer, semitones: number): Promise<AudioBuffer> {
  if (semitones === 0) return buffer;
  const rate = Math.pow(2, semitones / 12);
  const origLen = buffer.length;
  const origRate = buffer.sampleRate;
  const channels = buffer.numberOfChannels;
  const shiftCtx = new OfflineAudioContext(channels, origLen, origRate);
  const src = shiftCtx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  const eq = shiftCtx.createBiquadFilter();
  if (semitones > 0) { eq.type = 'highshelf'; eq.frequency.value = 4000; eq.gain.value = -Math.min(semitones * 0.4, 4); }
  else { eq.type = 'lowshelf'; eq.frequency.value = 300; eq.gain.value = -Math.min(Math.abs(semitones) * 0.3, 3); }
  const compGain = shiftCtx.createGain();
  compGain.gain.value = semitones > 0 ? 0.95 : 1.05;
  src.connect(eq); eq.connect(compGain); compGain.connect(shiftCtx.destination);
  src.start(0);
  return shiftCtx.startRendering();
}

async function doubleTrackBuffer(buffer: AudioBuffer): Promise<AudioBuffer> {
  const sr = buffer.sampleRate;
  const channels = buffer.numberOfChannels;
  const len = buffer.length;
  const delayMs = 18;
  const delaySamp = Math.floor((delayMs / 1000) * sr);
  const totalLen = len + delaySamp;
  const offline = new OfflineAudioContext(2, totalLen, sr);
  const src1 = offline.createBufferSource(); src1.buffer = buffer;
  const pan1 = offline.createStereoPanner(); pan1.pan.value = -0.25;
  const gain1 = offline.createGain(); gain1.gain.value = 0.85;
  src1.connect(pan1); pan1.connect(gain1); gain1.connect(offline.destination); src1.start(0);
  const src2 = offline.createBufferSource(); src2.buffer = buffer; src2.playbackRate.value = Math.pow(2, 0.15 / 12);
  const pan2 = offline.createStereoPanner(); pan2.pan.value = 0.25;
  const gain2 = offline.createGain(); gain2.gain.value = 0.80;
  src2.connect(pan2); pan2.connect(gain2); gain2.connect(offline.destination); src2.start(delaySamp / sr);
  return offline.startRendering();
}

function getOfflineDB() {
  // studioOfflineDB est déjà chargé via __INLINE_MODULES__ avant StudioService
  return studioOfflineDB;
}

async function audioBufferToBlob(buffer: AudioBuffer): Promise<Blob> {
  const mimeType = getBestMimeType();
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const dest = ctx.createMediaStreamDestination();
  const src = ctx.createBufferSource(); src.buffer = buffer; src.connect(dest);
  const recOpts: MediaRecorderOptions = {};
  if (mimeType) recOpts.mimeType = mimeType;
  const recorder = new MediaRecorder(dest.stream, recOpts);
  const chunks: Blob[] = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  return new Promise(resolve => {
    recorder.onstop = () => { ctx.close(); const type = chunks[0]?.type || mimeType || 'audio/mp4'; resolve(new Blob(chunks, { type })); };
    recorder.start(); src.start();
    setTimeout(() => { recorder.stop(); try { src.stop(); } catch {} }, (buffer.duration + 0.3) * 1000);
  });
}

export const studioService = {
  async saveRecordingLocallyAsync(rec: MobileRecording): Promise<void> {
    const db = getOfflineDB();
    // Demander le stockage persistant si pas encore fait
    StudioOfflineDatabase.requestPersistence().catch(() => {});
    if (rec.dataUrl) { const blob = this.dataUrlToBlob(rec.dataUrl); await db.saveAudio(`rec_${rec.id}`, blob, { songId: rec.songId, songTitle: rec.songTitle, type: 'recording' }); }
    const meta = { ...rec, dataUrl: undefined, blob: undefined };
    const existing = await db.getState<any[]>('recordings', []);
    await db.setState('recordings', [...existing.filter((r: any) => r.id !== rec.id), meta]);
  },
  saveRecordingLocally(rec: MobileRecording): void {
    this.saveRecordingLocallyAsync(rec).catch((e: any) => {
      if (e && (e.name === 'QuotaExceededError' || (e.message && e.message.includes('QUOTA_FULL')))) {
        window.dispatchEvent(new CustomEvent('studio:quotaExceeded', { detail: { message: e.message } }));
      } else {
        console.warn('[StudioService] saveRecordingLocally:', e);
      }
    });
  },
  async getLocalRecordingsAsync(): Promise<MobileRecording[]> {
    try {
      const db = getOfflineDB();
      const metas = await db.getState<any[]>('recordings', []);
      return Promise.all(metas.map(async (meta: any) => {
        try { const blob = await db.getAudio(`rec_${meta.id}`); if (blob) return { ...meta, dataUrl: await studioService.blobToDataUrl(blob) }; } catch {}
        return meta;
      }));
    } catch { return this.getLocalRecordings(); }
  },
  getLocalRecordings(): MobileRecording[] { try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : []; } catch { return []; } },
  async deleteLocalRecordingAsync(id: string): Promise<void> {
    const db = getOfflineDB(); await db.deleteAudio(`rec_${id}`);
    const metas = await db.getState<any[]>('recordings', []);
    await db.setState('recordings', metas.filter((r: any) => r.id !== id));
  },
  deleteLocalRecording(id: string): void { this.deleteLocalRecordingAsync(id).catch(() => {}); },
  markTransferred(id: string): void {
    try { const recs = this.getLocalRecordings().map(r => r.id === id ? { ...r, transferred: true } : r); localStorage.setItem(STORAGE_KEY, JSON.stringify(recs)); } catch {}
  },
  async uploadToServer(rec: MobileRecording, blob: Blob): Promise<boolean> {
    try {
      const formData = new FormData();
      formData.append('audio', blob, rec.fileName);
      formData.append('songId', rec.songId); formData.append('songTitle', rec.songTitle);
      formData.append('artist', rec.artist); formData.append('duration', String(rec.duration));
      formData.append('recordedAt', String(rec.recordedAt)); formData.append('recId', rec.id);
      formData.append('trackIndex', String(rec.trackIndex ?? 0));
      formData.append('trackLabel', rec.trackLabel ?? 'Voix principale');
      if (rec.takeSlot) formData.append('takeSlot', rec.takeSlot);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);
      let res: Response;
      try { res = await fetch('/api/studio/upload', { method: 'POST', body: formData, signal: controller.signal }); } finally { clearTimeout(timeoutId); }
      if (!res.ok) return false;
      try { const data = await res.json(); return data.success === true; } catch { return false; }
    } catch { return false; }
  },
  async getPendingFromServer(): Promise<any[]> { try { const res = await fetch('/api/studio/pending'); if (!res.ok) return []; return await res.json(); } catch { return []; } },
  async deleteFromServer(recId: string): Promise<void> { try { await fetch(`/api/studio/recording/${recId}`, { method: 'DELETE' }); } catch {} },
  makeDistortionCurve(amount: number): Float32Array {
    const k = amount * 100; const n = 44100; const curve = new Float32Array(n); const deg = Math.PI / 180;
    for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x)); }
    return curve;
  },
  // ─── ENREGISTREMENT PRO — Capture STRICTEMENT SÈCHE ────────────────────────
  //
  // iOS (WebKit Bugzilla #154538, Apple QA1631) :
  //   sampleRate = hardware AVAudioSession. Haut-parleur=48kHz, casque=44.1kHz.
  //   On ne force rien — le WAV est encodé au sampleRate natif de l'appareil.
  //   __warmContext gardé ouvert = AVAudioSession stable entre les prises.
  //   getUserMedia() direct à chaque prise (pas de clonage de stream mort).
  //
  // config.reverb IGNORÉ — les effets sont en post-prod uniquement (applyFxToTrack).
  async startRecordingPro(config: StudioEffectsConfig, onVuLevel?: (level: number) => void, onLog?: (msg: string) => void): Promise<{
    recorder: MediaRecorder | null; chunks: Blob[]; context: AudioContext; stream: MediaStream;
    analyser: AnalyserNode; monitorGain: GainNode; stopWorklet?: () => Blob;
    sourceNode: MediaStreamAudioSourceNode | null;
  }> {
    const log = (msg: string) => { console.log(`[AUDIO] ${msg}`); onLog?.(`[AUDIO] ${msg}`); };
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;

    // ✅ Réutiliser le __warmContext — NE PAS créer un nouveau contexte.
    // Un nouveau contexte force AVAudioSession à recalculer la route audio
    // ce qui peut changer le sampleRate entre les prises.
    let audioContext: AudioContext = (window as any).__warmContext;
    if (!audioContext || audioContext.state === 'closed') {
      audioContext = new AudioCtx({ latencyHint: 'interactive' });
      (window as any).__warmContext = audioContext;
      (window as any).__warmWorkletLoaded = null;
      log('AudioContext créé (nouveau)');
    } else {
      log(`AudioContext réutilisé | state=${audioContext.state}`);
    }
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
      log('AudioContext resumed');
    }
    log(`sampleRate=${audioContext.sampleRate}Hz (${audioContext.sampleRate >= 44000 ? '✅ HD' : '⚠️ bas'})`);

    // Vérifier que le contexte n'est pas dans un état irrécupérable
    if (audioContext.state === 'closed') {
      log('⚠️ AudioContext fermé — recréation forcée');
      audioContext = new AudioCtx({ latencyHint: 'interactive' });
      (window as any).__warmContext = audioContext;
      (window as any).__warmWorkletLoaded = null;
      await audioContext.resume();
    }

    // ✅ Nettoyage des nodes du cycle précédent — évite l'accumulation sur le même contexte
    const prevNodes = (window as any).__warmNodes as { source?: AudioNode; analyser?: AudioNode; worklet?: AudioNode } | undefined;
    if (prevNodes) {
      try { prevNodes.worklet?.disconnect(); } catch {}
      try { prevNodes.analyser?.disconnect(); } catch {}
      try { prevNodes.source?.disconnect(); } catch {}
      (window as any).__warmNodes = null;
      log('🔧 Nodes précédents déconnectés');
    }

    // Contraintes micro : DSP désactivé = capture brute haute qualité
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      ...({ googEchoCancellation: false, googNoiseSuppression: false, googAutoGainControl: false, googHighpassFilter: false } as any),
    };
    if (config.deviceId) audioConstraints.deviceId = { exact: config.deviceId };

    // ✅ getUserMedia() direct à chaque prise — stream frais garanti.
    // Le __warmContext est ouvert, ce qui maintient la session AVAudioSession stable.
    // On NE clone PAS __warmStream : un stream dont les tracks sont arrêtées est vide.
    log('getUserMedia() — stream frais');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
    const track = stream.getAudioTracks()[0];
    if (track) {
      const s = track.getSettings();
      log(`Micro: ${s.sampleRate ?? '?'}Hz | echo=${s.echoCancellation} | noise=${s.noiseSuppression}`);
    }

    // Chaîne SÈCHE : source → analyser uniquement. Aucun effet.
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    // MonitorGain à 0, non connecté à destination par défaut.
    // toggleMonitoring() dans useStudioRecorder connecte/déconnecte.
    const monitorGain = audioContext.createGain();
    monitorGain.gain.value = 0;

    // Gestion visibilitychange — utiliser un flag pour éviter les doublons
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && audioContext.state === 'suspended') {
        audioContext.resume().catch(() => {});
      }
    };
    // Retirer l'ancien listener avant d'en ajouter un nouveau (multi-enregistrements)
    document.removeEventListener('visibilitychange', (window as any).__lastVisibilityHandler);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    (window as any).__lastVisibilityHandler = handleVisibilityChange;
    // NE PAS override close() — ça corrompt le warmContext entre les prises

    const pcmChunks: Float32Array[] = [];
    const chunks: Blob[] = [];
    let workletNode: AudioWorkletNode | null = null;
    let useWorklet = false;

    try {
      // ✅ addModule UNE SEULE FOIS par contexte.
      // Rappeler addModule sur un contexte actif peut déclencher un recalcul
      // AVAudioSession sur iOS → changement de sampleRate indésirable.
      const workletAlreadyLoaded = (window as any).__warmWorkletLoaded === audioContext;
      if (!workletAlreadyLoaded) {
        await audioContext.audioWorklet.addModule('/recorder-worklet.js');
        (window as any).__warmWorkletLoaded = audioContext;
        log('AudioWorklet chargé');
      } else {
        log('AudioWorklet réutilisé (déjà chargé)');
      }
      workletNode = new AudioWorkletNode(audioContext, 'recorder-processor');
      analyser.connect(workletNode);
      workletNode.port.onmessage = (e: MessageEvent<ArrayBuffer>) => { pcmChunks.push(new Float32Array(e.data)); };
      useWorklet = true;
      log(`✅ AudioWorklet PCM brut | ${audioContext.sampleRate}Hz`);
    } catch (err) {
      log(`⚠️ AudioWorklet ÉCHEC (${err}) → fallback MediaRecorder`);
    }

    // Sauvegarder refs pour nettoyage à la prochaine prise
    (window as any).__warmNodes = { source, analyser, worklet: workletNode };

    let recorder: MediaRecorder | null = null;
    if (!useWorklet) {
      const mimeType = getBestMimeType();
      const recOpts: MediaRecorderOptions = {}; if (mimeType) recOpts.mimeType = mimeType; recOpts.audioBitsPerSecond = 256000;
      recorder = new MediaRecorder(stream, recOpts);
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.start(100);
      log(`MediaRecorder | ${mimeType || 'défaut'} | 256kbps`);
    }

    // Encodeur WAV PCM 16-bit au sampleRate natif du hardware
    const stopWorklet = (): Blob => {
      if (workletNode) { workletNode.port.postMessage('stop'); workletNode.disconnect(); }
      const sr = audioContext.sampleRate;
      const total = pcmChunks.reduce((a, b) => a + b.length, 0);
      const dv = new DataView(new ArrayBuffer(44 + total * 2));
      let off = 0;
      const ws = (s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(off++, s.charCodeAt(i)); };
      const w32 = (v: number) => { dv.setUint32(off, v, true); off += 4; };
      const w16 = (v: number) => { dv.setUint16(off, v, true); off += 2; };
      ws('RIFF'); w32(36 + total * 2); ws('WAVE'); ws('fmt '); w32(16); w16(1); w16(1);
      w32(sr); w32(sr * 2); w16(2); w16(16); ws('data'); w32(total * 2);
      for (const chunk of pcmChunks) {
        for (let i = 0; i < chunk.length; i++) {
          const s = Math.max(-1, Math.min(1, chunk[i]));
          dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true); off += 2;
        }
      }
      return new Blob([dv], { type: 'audio/wav' });
    };

    return { recorder, chunks, context: audioContext, stream, analyser, monitorGain, stopWorklet, sourceNode: source ?? null };
  },
  blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((res, rej) => {
      const reader = new FileReader(); reader.onload = () => res(reader.result as string); reader.onerror = rej; reader.readAsDataURL(blob);
    });
  },
  dataUrlToBlob(dataUrl: string): Blob {
    const [header, data] = dataUrl.split(',');
    const mime = header.match(/:(.*?);/)?.[1] ?? 'audio/mp4';
    const binary = atob(data); const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  },
  getProjects(): TrackProject[] { try { const data = localStorage.getItem('cash_studio_projects'); return data ? JSON.parse(data) : []; } catch { return []; } },
  saveProject(project: TrackProject): void { const projects = this.getProjects().filter(p => p.id !== project.id); projects.unshift(project); localStorage.setItem('cash_studio_projects', JSON.stringify(projects.slice(0, 20))); },
  deleteProject(projectId: string): void { const projects = this.getProjects().filter(p => p.id !== projectId); localStorage.setItem('cash_studio_projects', JSON.stringify(projects)); },
  getOrCreateProject(songId: string, songTitle: string): TrackProject {
    const existing = this.getProjects().find(p => p.songId === songId);
    if (existing) return existing;
    const project: TrackProject = { id: `PROJ-${Date.now()}`, songId, songTitle, createdAt: Date.now(), tracks: [] };
    this.saveProject(project); return project;
  },
  addTrackToProject(projectId: string, track: MobileRecording): TrackProject | null {
    const projects = this.getProjects(); const project = projects.find(p => p.id === projectId);
    if (!project) return null;
    // Stocker seulement les métadonnées dans localStorage (dataUrl est dans IndexedDB)
    const trackMeta = { ...track, dataUrl: undefined, blob: undefined };
    if (track.takeSlot && track.trackIndex === 0) {
      project.tracks = project.tracks.filter(t =>
        !(t.trackIndex === 0 && !t.isGenerated && t.takeSlot === track.takeSlot)
      );
    } else {
      project.tracks = project.tracks.filter(t => t.trackIndex !== track.trackIndex);
    }
    project.tracks.push(trackMeta as MobileRecording); this.saveProject(project);
    // Retourner le projet avec le vrai track (dataUrl inclus) pour le state React en mémoire
    const projectWithData = { ...project, tracks: [...project.tracks.filter(t => t.id !== track.id), track] };
    return projectWithData;
  },
  async analyzeWaveform(dataUrl: string, points = 200): Promise<number[]> {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    try {
      const blob = this.dataUrlToBlob(dataUrl); const arrayBuffer = await blob.arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer); const data = audioBuffer.getChannelData(0);
      const blockSize = Math.floor(data.length / points); const waveform: number[] = [];
      for (let i = 0; i < points; i++) { let sum = 0; for (let j = 0; j < blockSize; j++) sum += Math.abs(data[i * blockSize + j] || 0); waveform.push(sum / blockSize); }
      const max = Math.max(...waveform, 0.001); return waveform.map(v => v / max);
    } finally { ctx.close(); }
  },
  async mixProject(project: TrackProject): Promise<Blob> {
    const activeTracks = project.tracks.filter(t => !t.muted && t.dataUrl);
    if (activeTracks.length === 0) throw new Error('Aucune piste valide à mixer');
    const tmpCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const decoded: { track: MobileRecording; buffer: AudioBuffer }[] = [];
    for (const track of activeTracks) {
      try { const blob = this.dataUrlToBlob(track.dataUrl!); const arrayBuffer = await blob.arrayBuffer(); const buffer = await tmpCtx.decodeAudioData(arrayBuffer); decoded.push({ track, buffer }); } catch (e) { console.warn(`[Studio] Erreur décodage piste "${track.trackLabel}":`, e); }
    }
    await tmpCtx.close(); if (decoded.length === 0) throw new Error('Aucune piste décodable');
    const shifted: { track: MobileRecording; buffer: AudioBuffer }[] = [];
    for (const { track, buffer } of decoded) {
      const semitones = track.pitchShift ?? 0;
      if (semitones !== 0) {
        try { const shiftedBuf = await pitchShiftBuffer(new (window.AudioContext || (window as any).webkitAudioContext)(), buffer, semitones); shifted.push({ track, buffer: shiftedBuf }); } catch { shifted.push({ track, buffer }); }
      } else { shifted.push({ track, buffer }); }
    }
    const maxDuration = Math.max(...shifted.map(s => s.buffer.duration)); const sampleRate = shifted[0].buffer.sampleRate;
    const offline = new OfflineAudioContext(2, Math.ceil(maxDuration * sampleRate) + 4096, sampleRate);
    for (const { track, buffer } of shifted) {
      const src = offline.createBufferSource(); src.buffer = buffer;
      const gainNode = offline.createGain(); gainNode.gain.value = track.gain ?? 1.0;
      const panner = offline.createStereoPanner(); panner.pan.value = track.pan ?? 0;
      src.connect(gainNode); gainNode.connect(panner); panner.connect(offline.destination); src.start(0);
    }
    const rendered = await offline.startRendering(); return audioBufferToBlob(rendered);
  },
  async mixComp(takes: Take[], gain = 1.0): Promise<Blob> {
    const allRegions = takes.flatMap(take => take.regions.map(r => ({ ...r, recording: take.recording }))).sort((a, b) => a.startSec - b.startSec);
    if (allRegions.length === 0) throw new Error('Aucune région sélectionnée');
    const tmpCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const bufferMap = new Map<string, AudioBuffer>();
    for (const take of takes) {
      if (!take.recording.dataUrl || bufferMap.has(take.recording.id)) continue;
      try { const blob = this.dataUrlToBlob(take.recording.dataUrl); const ab = await blob.arrayBuffer(); const buf = await tmpCtx.decodeAudioData(ab); bufferMap.set(take.recording.id, buf); } catch (e) { console.warn(`[Comp] Erreur décodage prise ${take.recording.id}:`, e); }
    }
    await tmpCtx.close();
    const totalDuration = allRegions.reduce((sum, r) => sum + (r.endSec - r.startSec), 0); const sampleRate = 44100;
    const offline = new OfflineAudioContext(2, Math.ceil(totalDuration * sampleRate), sampleRate);
    let cursor = 0;
    for (const region of allRegions) {
      const buf = bufferMap.get(region.takeId); if (!buf) continue;
      const regionDuration = region.endSec - region.startSec; if (regionDuration <= 0) continue;
      const source = offline.createBufferSource(); source.buffer = buf;
      const gainNode = offline.createGain(); gainNode.gain.value = gain;
      const fadeTime = Math.min(0.02, regionDuration / 4);
      gainNode.gain.setValueAtTime(0, cursor); gainNode.gain.linearRampToValueAtTime(gain, cursor + fadeTime);
      gainNode.gain.setValueAtTime(gain, cursor + regionDuration - fadeTime); gainNode.gain.linearRampToValueAtTime(0, cursor + regionDuration);
      source.connect(gainNode); gainNode.connect(offline.destination); source.start(cursor, region.startSec, regionDuration);
      cursor += regionDuration;
    }
    const rendered = await offline.startRendering(); return audioBufferToBlob(rendered);
  },
  async generateLayersFromVoice(mainVoice: MobileRecording, project: TrackProject, onProgress?: (label: string, pct: number) => void): Promise<MobileRecording[]> {
    const progress = (label: string, pct: number) => onProgress?.(label, pct);
    progress('Décodage voix principale', 5);

    // Récupérer le blob : priorité dataUrl en mémoire, sinon IndexedDB
    let srcBlob: Blob | null = null;
    if (mainVoice.dataUrl) {
      srcBlob = this.dataUrlToBlob(mainVoice.dataUrl);
    } else {
      try {
        const db = getOfflineDB();
        srcBlob = await db.getAudio(`rec_${mainVoice.id}`);
      } catch {}
    }
    if (!srcBlob || srcBlob.size === 0) throw new Error('Voix principale sans données audio (ni dataUrl ni IndexedDB)');

    const srcAb = await srcBlob.arrayBuffer();
    const tmpCtx = new (window.AudioContext || (window as any).webkitAudioContext());
    let srcBuffer: AudioBuffer;
    try { srcBuffer = await tmpCtx.decodeAudioData(srcAb); } finally { tmpCtx.close(); }
    const layers = [
      { trackIndex: 1, trackLabel: 'Double tracking', pitch: 0, gain: 0.85, pan: -0.3, emoji: '🎵', isDouble: true, suggestedFxId: 'double_epic' },
      { trackIndex: 2, trackLabel: 'Harmonie +3', pitch: 3, gain: 0.75, pan: 0.4, emoji: '🎶', isDouble: false, suggestedFxId: 'harmony' },
      { trackIndex: 3, trackLabel: 'Harmonie +7', pitch: 7, gain: 0.70, pan: -0.4, emoji: '🎼', isDouble: false, suggestedFxId: 'harmony' },
      { trackIndex: 4, trackLabel: 'Octave bas', pitch: -12, gain: 0.80, pan: 0.0, emoji: '🔉', isDouble: false, suggestedFxId: 'octave_deep' },
      { trackIndex: 5, trackLabel: 'Harmonie +5', pitch: 5, gain: 0.72, pan: 0.3, emoji: '✨', isDouble: false, suggestedFxId: 'harmony' },
    ];
    const generated: MobileRecording[] = []; const mimeType = getBestMimeType();
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i]; const pct = 10 + (i / layers.length) * 75;
      progress(`${layer.emoji} ${layer.trackLabel}...`, pct);
      let rendered: AudioBuffer;
      if (layer.isDouble) rendered = await doubleTrackBuffer(srcBuffer);
      else rendered = await pitchShiftBuffer(new (window.AudioContext || (window as any).webkitAudioContext)(), srcBuffer, layer.pitch);
      const finalCtx = new OfflineAudioContext(2, rendered.length, rendered.sampleRate);
      const finalSrc = finalCtx.createBufferSource(); finalSrc.buffer = rendered;
      const finalGain = finalCtx.createGain(); finalGain.gain.value = layer.gain;
      const finalPan = finalCtx.createStereoPanner(); finalPan.pan.value = layer.isDouble ? 0 : layer.pan;
      finalSrc.connect(finalGain); finalGain.connect(finalPan); finalPan.connect(finalCtx.destination); finalSrc.start(0);
      const finalRendered = await finalCtx.startRendering();
      const blob = await (async (buffer: AudioBuffer): Promise<Blob> => {
        const ctx2 = new (window.AudioContext || (window as any).webkitAudioContext)();
        const dest2 = ctx2.createMediaStreamDestination(); const src2 = ctx2.createBufferSource(); src2.buffer = buffer; src2.connect(dest2);
        const recOpts: MediaRecorderOptions = {}; if (mimeType) recOpts.mimeType = mimeType;
        const recorder2 = new MediaRecorder(dest2.stream, recOpts); const chunks2: Blob[] = [];
        recorder2.ondataavailable = e => { if (e.data.size > 0) chunks2.push(e.data); };
        return new Promise(resolve => {
          recorder2.onstop = () => { ctx2.close(); resolve(new Blob(chunks2, { type: chunks2[0]?.type || 'audio/mp4' })); };
          recorder2.start(); src2.start(); setTimeout(() => { recorder2.stop(); try { src2.stop(); } catch {} }, (buffer.duration + 0.3) * 1000);
        });
      })(finalRendered);
      const dataUrl = await this.blobToDataUrl(blob);
      const safeTitle = (mainVoice.songTitle || 'song').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
      const ext = blob.type.includes('codecs=pcm') || blob.type.includes('codecs=alac') ? 'wav' : blob.type.includes('mp4') ? 'mp4' : 'webm';
      const fileName = `${safeTitle}_T${layer.trackIndex}_GEN_${Date.now()}.${ext}`;
      const rec: MobileRecording = {
        id: `GEN-${layer.trackIndex}-${Date.now()}`, songId: mainVoice.songId, songTitle: mainVoice.songTitle, artist: mainVoice.artist,
        duration: mainVoice.duration, recordedAt: Date.now(), dataUrl, transferred: false, fileName,
        trackIndex: layer.trackIndex, trackLabel: layer.trackLabel, pitchShift: layer.isDouble ? 0 : layer.pitch,
        gain: layer.gain, pan: layer.pan, projectId: project.id, isGenerated: true, fxPresetId: layer.suggestedFxId
      } as any;
      this.saveRecordingLocally(rec); generated.push(rec as any);
    }
    progress('Terminé', 100); return generated;
  },
  async applyFxToTrack(dataUrl: string, fx: { lowGain: number; midGain: number; highGain: number; compThreshold: number; compRatio: number; compAttack: number; compRelease: number; compKnee: number; saturation: number; reverb: string; reverbMix: number; }, onProgress?: (pct: number) => void): Promise<string> {
    onProgress?.(5); const blob = this.dataUrlToBlob(dataUrl); const ab = await blob.arrayBuffer();
    const tmpCtx = new (window.AudioContext || (window as any).webkitAudioContext());
    let srcBuf: AudioBuffer; try { srcBuf = await tmpCtx.decodeAudioData(ab); } finally { tmpCtx.close(); }
    onProgress?.(20); const sr = srcBuf.sampleRate; const len = srcBuf.length;
    const offline = new OfflineAudioContext(2, len, sr);
    const src = offline.createBufferSource(); src.buffer = srcBuf;
    const low = offline.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 250; low.gain.value = fx.lowGain;
    const mid = offline.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 2500; mid.Q.value = 0.8; mid.gain.value = fx.midGain;
    const high = offline.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = 8000; high.gain.value = fx.highGain;
    const comp = offline.createDynamicsCompressor(); comp.threshold.value = fx.compThreshold; comp.ratio.value = fx.compRatio; comp.attack.value = fx.compAttack / 1000; comp.release.value = fx.compRelease / 1000; comp.knee.value = fx.compKnee;
    const satNode = offline.createWaveShaper();
    if (fx.saturation > 0) { const k = fx.saturation * 100; const n = 44100; const curve = new Float32Array(n); const deg = Math.PI / 180; for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x)); } satNode.curve = curve; }
    onProgress?.(40);
    let reverbNode: ConvolverNode | null = null; let reverbGainNode: GainNode | null = null; let dryGainNode: GainNode | null = null;
    if (fx.reverb !== 'none' && fx.reverbMix > 0) {
      const reverbParams: Record<string, { dur: number; decay: number; preDelay: number; diffusion: number; modDepth: number; }> = { room: { dur: 1.5, decay: 2.5, preDelay: 0.010, diffusion: 0.65, modDepth: 0.0003 }, hall: { dur: 3.5, decay: 1.6, preDelay: 0.028, diffusion: 0.50, modDepth: 0.0002 }, plate: { dur: 2.0, decay: 2.0, preDelay: 0.004, diffusion: 0.82, modDepth: 0.0005 } };
      const p = reverbParams[fx.reverb] ?? reverbParams.room; const rLen = Math.floor(sr * p.dur); const preDel = Math.floor(sr * p.preDelay); const impulse = offline.createBuffer(2, rLen, sr);
      for (let ch = 0; ch < 2; ch++) {
        const data = impulse.getChannelData(ch); const isSide = ch === 1;
        for (let j = 0; j < preDel && j < rLen; j++) data[j] = 0;
        const erDelays = [0.007, 0.015, 0.023, 0.031, 0.041, 0.055].map(t => Math.floor(t * sr)); const erGains = [0.82, 0.70, 0.60, 0.50, 0.40, 0.30];
        for (let e = 0; e < erDelays.length; e++) { const pos = preDel + erDelays[e] + (isSide ? Math.floor(sr * 0.0007) : 0); if (pos < rLen) data[pos] += erGains[e] * (isSide ? 0.92 : 1.0); }
      }
      reverbNode = offline.createConvolver(); reverbNode.buffer = impulse;
      reverbGainNode = offline.createGain(); reverbGainNode.gain.value = fx.reverbMix;
      dryGainNode = offline.createGain(); dryGainNode.gain.value = 1.0 - fx.reverbMix;
    }
    onProgress?.(60);
    const outGain = offline.createGain(); outGain.gain.value = 0.95;
    src.connect(low); low.connect(mid); mid.connect(high); high.connect(comp); comp.connect(satNode);
    if (reverbNode && reverbGainNode && dryGainNode) { satNode.connect(dryGainNode); dryGainNode.connect(outGain); satNode.connect(reverbNode); reverbNode.connect(reverbGainNode); reverbGainNode.connect(outGain); }
    else { satNode.connect(outGain); }
    outGain.connect(offline.destination); src.start(0); onProgress?.(70);
    const rendered = await offline.startRendering(); onProgress?.(85);
    const resultBlob = await (async (buffer: AudioBuffer): Promise<Blob> => {
      const ctx2 = new (window.AudioContext || (window as any).webkitAudioContext)(); const dest2 = ctx2.createMediaStreamDestination(); const src2 = ctx2.createBufferSource(); src2.buffer = buffer; src2.connect(dest2);
      const mimeType = getBestMimeType(); const recOpts: MediaRecorderOptions = {}; if (mimeType) recOpts.mimeType = mimeType;
      const recorder2 = new MediaRecorder(dest2.stream, recOpts); const chunks2: Blob[] = [];
      recorder2.ondataavailable = e => { if (e.data.size > 0) chunks2.push(e.data); };
      return new Promise(resolve => { recorder2.onstop = () => { ctx2.close(); resolve(new Blob(chunks2, { type: chunks2[0]?.type || 'audio/mp4' })); }; recorder2.start(); src2.start(); setTimeout(() => { recorder2.stop(); try { src2.stop(); } catch {} }, (buffer.duration + 0.3) * 1000); });
    })(rendered);
    onProgress?.(98); const resultDataUrl = await this.blobToDataUrl(resultBlob); onProgress?.(100); return resultDataUrl;
  },
};
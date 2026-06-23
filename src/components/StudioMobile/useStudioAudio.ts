/**
useStudioAudio.ts v7.4 — STABLE iOS
CORRECTIF MAJEUR : Suppression totale de AudioContext/GainNode pour le guide vocal.
Ces éléments entraient en conflit avec la session d'enregistrement sur iOS,
forçant le basculement en mode 16kHz.
Le volume est maintenant géré via l'élément <audio> natif (.volume).
Sur iPhone, le volume physique prévaut, mais cela garantit une compatibilité totale
sans casser la qualité du micro.
*/
import { useState, useRef, useEffect, useCallback } from 'react';
import { MobileRecording } from '../../services/StudioService';
import { studioOfflineDB } from '../../services/StudioOfflineDB';
import { Song, TrackType } from '../../types';

function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
// Teste une fois si iOS peut lire audio/flac nativement (iOS 11+)
let _iosFlacSupported: boolean | null = null;
function iosSupportsFlac(): boolean {
  if (_iosFlacSupported !== null) return _iosFlacSupported;
  try {
    const a = document.createElement('audio');
    _iosFlacSupported = a.canPlayType('audio/flac') !== '';
  } catch { _iosFlacSupported = false; }
  return _iosFlacSupported;
}

function fixBlobType(blob: Blob): Blob {
  if (isIOS()) {
    const t = blob.type.toLowerCase();
    // iOS supporte nativement : mp4/aac, mp3, flac, WAV, aiff
    if (t.includes('mp4') || t.includes('mpeg') || t.includes('aac') || 
        t.includes('mp3') || t.includes('flac') || t.includes('wav') || 
        t.includes('wave') || t.includes('aiff')) return blob;
    // Types non supportés (WebM, OGG, Opus) → forcer audio/mp4
    if (t.includes('webm') || t.includes('ogg') || t.includes('opus')) {
      return new Blob([blob], { type: 'audio/mp4' });
    }
    // Type vide → forcer audio/mp4 sur iOS (type inconnu = lecture impossible)
    if (t === '') return new Blob([blob], { type: 'audio/mp4' });
  }
  return blob;
}
function getMediaUrl(fileName: string): string {
  const _macUrl = ((window as any).__CC_MAC_URL as string) || '';
  const _base = _macUrl.startsWith('http') ? _macUrl : '';
  if (!_base && isIOS() && fileName.toLowerCase().endsWith('.flac')) return `/api/media-transcode/${encodeURIComponent(fileName)}`;
  return `${_base}/api/media/${encodeURIComponent(fileName)}`;
}
function makeAudioEl(): HTMLAudioElement {
  const el = document.createElement('audio');
  el.setAttribute('playsinline', '');
  el.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;top:-9999px;';
  document.body.appendChild(el);
  return el;
}

interface AudioResult {
  instUrl:          string | null;
  vocalGuideUrl:    string | null;
  vocalGuideVol:    number;
  playingId:        string | null;
  instLoading:      boolean;
  vocalLoading:     boolean;
  instCached:       boolean;   // true = blob URL depuis IndexedDB
  vocalCached:      boolean;   // true = blob URL depuis IndexedDB
  instRef:          React.RefObject<HTMLAudioElement>;
  vocalGuideRef:    React.RefObject<HTMLAudioElement>;
  playRef:          React.RefObject<HTMLAudioElement>;
  vocalVolRef:      React.RefObject<number>;
  setVocalGuideVol: (v: number) => void;
  previewInstVol:   number;
  setPreviewInstVol: (v: number) => void;
  adjustInstOffset: (ms: number) => void;
  instOffsetMs: number;
  autoDetectOffset: (voiceDataUrl: string) => Promise<number | null>;
  playRecording:    (rec: MobileRecording) => Promise<void>;
  stopPlayback:     () => void;
  playMix:          (dataUrl: string) => void;
  getInstPlaybackTime: () => number; // temps de lecture actuel du stem inst (sec)
}

// Convertir AudioBuffer en WAV pour l'élément <audio>
function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
  const numCh = buffer.numberOfChannels;
  const sr    = buffer.sampleRate;
  const len   = buffer.length;
  const wavLen = 44 + len * numCh * 2;
  const buf   = new ArrayBuffer(wavLen);
  const view  = new DataView(buf);
  const ws = (o: number, s: string) => { for (let i=0;i<s.length;i++) view.setUint8(o+i, s.charCodeAt(i)); };
  ws(0,'RIFF'); view.setUint32(4,36+len*numCh*2,true); ws(8,'WAVE'); ws(12,'fmt ');
  view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,numCh,true);
  view.setUint32(24,sr,true); view.setUint32(28,sr*numCh*2,true);
  view.setUint16(32,numCh*2,true); view.setUint16(34,16,true);
  ws(36,'data'); view.setUint32(40,len*numCh*2,true);
  let off = 44;
  const ch0 = buffer.getChannelData(0);
  const ch1 = numCh > 1 ? buffer.getChannelData(1) : ch0;
  for (let i=0;i<len;i++) {
    const sL = Math.max(-1,Math.min(1,ch0[i]));
    const sR = Math.max(-1,Math.min(1,ch1[i]));
    view.setInt16(off, sL<0?sL*0x8000:sL*0x7FFF, true); off+=2;
    if (numCh > 1) { view.setInt16(off, sR<0?sR*0x8000:sR*0x7FFF, true); off+=2; }
  }
  return buf;
}

export function useStudioAudio(selected: Song | null): AudioResult {
  const [instUrl, setInstUrl] = useState<string | null>(null);
  const [vocalGuideUrl, setVocalGuideUrl] = useState<string | null>(null);
  const [vocalGuideVol, setVocalGuideVol] = useState(0.4);
  const [previewInstVol, setPreviewInstVolRaw] = useState(0.25);
  const setPreviewInstVol = useCallback((v: number) => {
    setPreviewInstVolRaw(v);
    try { if (previewInstRef.current) previewInstRef.current.volume = Math.max(0, Math.min(1, v)); } catch {}
  }, []);

  // Décaler la position de l'inst pendant l'écoute (+ms = avancer, -ms = reculer)
  const [instOffsetMs, setInstOffsetMs] = useState<number>(0);
  const adjustInstOffset = useCallback((ms: number) => {
    setInstOffsetMs(prev => prev + ms);
    const pInst = previewInstRef.current;
    if (!pInst || pInst.paused) return;
    const newTime = Math.max(0, pInst.currentTime + ms / 1000);
    pInst.currentTime = newTime;
  }, []);
  // Auto-détection du décalage voix/stem — corrélation croisée à deux passes
  // Passe 1 (grossière) : blocs 50ms, ±5s → trouve la zone
  // Passe 2 (fine)      : blocs 5ms,  ±300ms autour du résultat → précision ±5ms
  const autoDetectOffset = useCallback(async (voiceDataUrl: string): Promise<number | null> => {
    const vocalUrl = vocalGuideUrl;
    if (!vocalUrl) return null;
    try {
      // Résoudre les blobs correctement (supporte data:, opfs:, blob:, http:)
      let voiceBlob: Blob;
      if (voiceDataUrl.startsWith('data:') || voiceDataUrl.startsWith('opfs:') || voiceDataUrl.startsWith('blob:')) {
        voiceBlob = await studioService.resolveBlobAsync(voiceDataUrl);
      } else {
        voiceBlob = await fetch(voiceDataUrl).then(r => r.blob());
      }
      const stemBlob = await fetch(vocalUrl).then(r => r.blob());

      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const [voiceAb, stemAb] = await Promise.all([
        voiceBlob.arrayBuffer(),
        stemBlob.arrayBuffer(),
      ]);
      const [voiceBuf, stemBuf] = await Promise.all([
        ctx.decodeAudioData(voiceAb),
        ctx.decodeAudioData(stemAb),
      ]);
      ctx.close();

      const sr = voiceBuf.sampleRate;

      // Extraction enveloppe RMS avec résolution variable
      const extractEnv = (buf: AudioBuffer, blockMs: number): Float32Array => {
        const blockSize = Math.floor(buf.sampleRate * blockMs / 1000);
        const ch = buf.getChannelData(0);
        const numBlocks = Math.floor(ch.length / blockSize);
        const env = new Float32Array(numBlocks);
        for (let b = 0; b < numBlocks; b++) {
          let sum = 0;
          for (let i = 0; i < blockSize; i++) { const s = ch[b*blockSize+i]||0; sum += s*s; }
          env[b] = Math.sqrt(sum / blockSize);
        }
        return env;
      };

      // Corrélation normalisée
      const crossCorr = (envA: Float32Array, envB: Float32Array, minLag: number, maxLag: number): number => {
        let bestLag = minLag, bestCorr = -Infinity;
        // Normalisation des enveloppes
        const meanA = envA.reduce((a,b)=>a+b,0)/envA.length;
        const meanB = envB.reduce((a,b)=>a+b,0)/envB.length;
        const stdA  = Math.sqrt(envA.reduce((a,b)=>a+(b-meanA)**2,0)/envA.length) || 1;
        const stdB  = Math.sqrt(envB.reduce((a,b)=>a+(b-meanB)**2,0)/envB.length) || 1;
        for (let lag = minLag; lag <= maxLag; lag++) {
          let corr = 0, n = 0;
          for (let i = 0; i < envA.length; i++) {
            const j = i - lag;
            if (j >= 0 && j < envB.length) {
              corr += ((envA[i]-meanA)/stdA) * ((envB[j]-meanB)/stdB);
              n++;
            }
          }
          if (n > 0) corr /= n;
          if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
        }
        return bestLag;
      };

      // PASSE 1 : grossière — blocs 50ms, ±5s
      const env50_voice = extractEnv(voiceBuf, 50);
      const env50_stem  = extractEnv(stemBuf,  50);
      const maxLag50    = Math.min(100, Math.floor(Math.min(env50_voice.length, env50_stem.length) / 2));
      const bestLag50   = crossCorr(env50_voice, env50_stem, -maxLag50, maxLag50);
      const coarseMs    = bestLag50 * 50; // ms

      // PASSE 2 : fine — blocs 5ms, ±300ms autour du résultat grossier
      const env5_voice  = extractEnv(voiceBuf, 5);
      const env5_stem   = extractEnv(stemBuf,  5);
      const fineCenter  = Math.round(coarseMs / 5); // en blocs 5ms
      const fineRange   = 60; // ±300ms en blocs 5ms
      const minLag5     = Math.max(-env5_voice.length>>1, fineCenter - fineRange);
      const maxLag5     = Math.min( env5_voice.length>>1, fineCenter + fineRange);
      const bestLag5    = crossCorr(env5_voice, env5_stem, minLag5, maxLag5);
      const fineMs      = bestLag5 * 5; // ms

      console.log('[autoDetectOffset] grossier:', coarseMs, 'ms → fin:', fineMs, 'ms');
      return fineMs;
    } catch (e) {
      console.warn('[autoDetectOffset]', e);
      return null;
    }
  }, [vocalGuideUrl]);

  const [playingId, setPlayingId] = useState<string | null>(null);
  const [instLoading, setInstLoading] = useState(false);
  const [vocalLoading, setVocalLoading] = useState(false);
  const [instCached, setInstCached] = useState(false);
  const [vocalCached, setVocalCached] = useState(false);

  const instRef = useRef(null as unknown as HTMLAudioElement);
  const vocalGuideRef = useRef(null as unknown as HTMLAudioElement);
  const playRef = useRef(null as unknown as HTMLAudioElement);
  const previewInstRef = useRef(null as unknown as HTMLAudioElement);
  const vocalVolRef = useRef(0.4);
  const createdRef = useRef(false);

  // Tracking du temps de lecture via AudioContext (pour sync paroles quand <audio>.play() échoue sur iOS)
  const ctxPlaybackStartTimeRef = useRef<number>(0);  // ctx.currentTime au moment du start
  const ctxPlaybackOffsetRef    = useRef<number>(0);  // offset dans le fichier (punchIn)
  const ctxPlaybackActiveRef    = useRef<boolean>(false);
  const instBufSrcRef           = useRef<AudioBufferSourceNode | null>(null);
  const instDecodedBufRef       = useRef<AudioBuffer | null>(null);
  const vocalDecodedBufRef      = useRef<AudioBuffer | null>(null);

  const getInstPlaybackTime = (): number => {
    const ctx = (window as any).__warmContext as AudioContext | undefined;
    // Priorité 1 : tracker AudioContext global (preview ou REC via BufferSourceNode)
    if (ctx && (window as any).__instCtxActive) {
      const elapsed = ctx.currentTime - ((window as any).__instCtxStartTime || ctx.currentTime);
      const t = ((window as any).__instCtxOffset || 0) + elapsed;
      return Math.max(0, t); // pendant les ~50ms de buffer, retourner 0 plutôt que négatif
    }
    // Priorité 2 : tracker performance.now() (fallback si AudioContext suspendu)
    if ((window as any).__instWallStart) {
      const elapsed = (performance.now() - (window as any).__instWallStart) / 1000;
      return Math.max(0, elapsed);
    }
    // Priorité 3 : <audio> element joue normalement
    if (instRef.current && !isNaN(instRef.current.currentTime) && instRef.current.currentTime > 0) {
      return instRef.current.currentTime;
    }
    return 0;
  };
  
  if (!createdRef.current && typeof document !== 'undefined') {
    createdRef.current = true;
    (instRef as React.MutableRefObject<HTMLAudioElement>).current = makeAudioEl();
    const vgEl = makeAudioEl();
    vgEl.setAttribute('data-role', 'vocal-guide');
    // Appliquer la transposition sauvegardée dès la création
    try { vgEl.playbackRate = (window as any).__vocalGuidePlaybackRate ?? Math.pow(2, parseFloat(localStorage.getItem('guide_transpose_st') || '-5') / 12); } catch {}
    (vocalGuideRef as React.MutableRefObject<HTMLAudioElement>).current = vgEl;
    (playRef as React.MutableRefObject<HTMLAudioElement>).current = makeAudioEl();
    // 4e élément dédié au preview inst — complètement séparé de instRef
    (previewInstRef as React.MutableRefObject<HTMLAudioElement>).current = makeAudioEl();
  }

  useEffect(() => {
    return () => {
      instRef.current?.pause(); instRef.current?.remove();
      vocalGuideRef.current?.pause(); vocalGuideRef.current?.remove();
      playRef.current?.pause(); playRef.current?.remove();
      previewInstRef.current?.pause(); previewInstRef.current?.remove();
    };
  }, []);

  // Contrôle du volume guide vocal — iOS : .volume est read-only, utiliser un GainNode
  const vocalGainNodeRef = useRef<GainNode | null>(null);
  const vocalAudioCtxRef = useRef<AudioContext | null>(null);
  const vocalSourceRef   = useRef<MediaElementAudioSourceNode | null>(null);

  const setVolumeIOS = useCallback((v: number) => {
    // Sur iOS, HTMLAudioElement.volume est read-only — on passe par GainNode.
    // IMPORTANT: ctx.resume() est async — on doit attendre avant de jouer.
    if (!vocalGuideRef.current) return;
    // Fallback immédiat .volume pour Desktop/Android
    try { vocalGuideRef.current.volume = v; } catch {}
    // GainNode async pour iOS
    (async () => {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      if (!vocalAudioCtxRef.current || vocalAudioCtxRef.current.state === 'closed') {
        vocalAudioCtxRef.current = new AudioCtx({ latencyHint: 'playback' });
      }
      const ctx = vocalAudioCtxRef.current;
      // Attendre que le contexte soit actif avant de brancher les noeuds
      if (ctx.state === 'suspended') await ctx.resume();
      if (!vocalSourceRef.current) {
        vocalSourceRef.current = ctx.createMediaElementSource(vocalGuideRef.current);
      }
      if (!vocalGainNodeRef.current) {
        vocalGainNodeRef.current = ctx.createGain();
        vocalSourceRef.current.connect(vocalGainNodeRef.current);
        vocalGainNodeRef.current.connect(ctx.destination);
      }
      vocalGainNodeRef.current.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
    } catch {
      // Fallback : tenter .volume directement (Desktop / contexte non-iOS)
      try { vocalGuideRef.current.volume = v; } catch {}
    }
    })(); // end async IIFE
  }, []);

  const updateVocalVol = useCallback((v: number) => {
    vocalVolRef.current = v;
    setVocalGuideVol(v);
    setVolumeIOS(v);
    // Contrôler aussi le GainNode du BufferSourceNode vocal (mode AudioContext)
    const gain: GainNode | null = (window as any).__vocalBufGain || null;
    if (gain) {
      try { gain.gain.setTargetAtTime(v, gain.context.currentTime, 0.01); } catch {}
    }
  }, [setVolumeIOS]);

  useEffect(() => {
    const el = instRef.current;
    if (!el) return;
    if (instUrl) { el.src = instUrl; el.load(); }
    else { el.removeAttribute('src'); el.load(); }
  }, [instUrl]);

  useEffect(() => {
    const el = vocalGuideRef.current;
    if (!el) return;
    if (vocalGuideUrl) {
      el.src = vocalGuideUrl;
      el.oncanplay = () => {
        try { el.volume = vocalVolRef.current; } catch {}
        setVolumeIOS(vocalVolRef.current);
      };
      try { el.volume = vocalVolRef.current; } catch {}
      // Appliquer la transposition du guide vocal si définie
      try { el.playbackRate = (window as any).__vocalGuidePlaybackRate ?? 1.0; } catch {}
      el.load();
    } else {
      el.removeAttribute('src'); el.load();
    }
  }, [vocalGuideUrl, setVolumeIOS]);

  const instBlobUrlRef  = useRef<string | null>(null);
  const vocalBlobUrlRef = useRef<string | null>(null);

  // ─── Chargement instrumental ─────────────────────────────────────────────
  // NOUVELLE RÈGLE : stems servis directement depuis Railway/GitHub Releases.
  // IndexedDB N'EST PLUS utilisée pour les stems — réservée aux enregistrements vocaux.
  // Priorité : Mac local (si connecté) → Railway /api/media/ (GitHub Releases)
  useEffect(() => {
    if (!selected) {
      setInstUrl(null); setInstCached(false);
      return;
    }
    let cancelled = false;
    setInstLoading(true);

    const dbLog = (msg: string) => { console.log(msg); (window as any).__addLog?.(msg); };

    const inst = selected.versions?.find((v: any) =>
      v.trackType === TrackType.STEM_INSTRUMENTAL ||
      v.trackType === 'Instrumental Stem (Export ZIP)'
    ) || selected.versions?.find((v: any) =>
      v.trackType === 'Instrumentale Pure (Copie IA)'
    );

    if (!inst?.fileName) {
      setInstUrl(null); setInstCached(false); setInstLoading(false);
      return;
    }

    const macUrl = ((window as any).__CC_MAC_URL as string) || '';
    if (macUrl.startsWith('http')) {
      // Mac configuré → tester si disponible
      fetch(`${macUrl}/api/songs`, { method: 'HEAD', signal: AbortSignal.timeout(2500) })
        .then(r => {
          if (cancelled) return;
          if (r.ok) {
            dbLog(`[Audio] ✅ inst depuis Mac`);
            setInstUrl(getMediaUrl(inst.fileName!)); setInstCached(false);
          } else {
            dbLog(`[Audio] Mac KO → Railway pour inst`);
            setInstUrl(`/api/media/${encodeURIComponent(inst.fileName!)}`); setInstCached(false);
          }
        })
        .catch(() => {
          if (!cancelled) {
            dbLog(`[Audio] Mac timeout → Railway pour inst`);
            setInstUrl(`/api/media/${encodeURIComponent(inst.fileName!)}`); setInstCached(false);
          }
        })
        .finally(() => { if (!cancelled) setInstLoading(false); });
    } else {
      // Pas de Mac → Railway directement (GitHub Releases)
      dbLog(`[Audio] inst → Railway /api/media/`);
      setInstUrl(`/api/media/${encodeURIComponent(inst.fileName!)}`); setInstCached(false);
      setInstLoading(false);
    }

    return () => { cancelled = true; };
  }, [selected?.id]);

  // ─── Chargement vocal guide ───────────────────────────────────────────────
  // NOUVELLE RÈGLE : stems servis directement depuis Railway/GitHub Releases.
  // IndexedDB N'EST PLUS utilisée pour les stems — réservée aux enregistrements vocaux.
  // Priorité : Mac local (si connecté) → Railway /api/media/ (GitHub Releases)
  useEffect(() => {
    if (!selected) {
      setVocalGuideUrl(null); setVocalCached(false);
      return;
    }
    let cancelled = false;
    setVocalLoading(true);

    const dbLog = (msg: string) => { console.log(msg); (window as any).__addLog?.(msg); };

    const vocal = selected.versions?.find((v: any) => v.trackType === TrackType.STEM_VOCAL);

    if (!vocal?.fileName) {
      setVocalGuideUrl(null); setVocalCached(false); setVocalLoading(false);
      return;
    }

    const macUrlV = ((window as any).__CC_MAC_URL as string) || '';
    if (macUrlV.startsWith('http')) {
      // Mac configuré → tester si disponible
      fetch(`${macUrlV}/api/songs`, { method: 'HEAD', signal: AbortSignal.timeout(2500) })
        .then(r => {
          if (cancelled) return;
          if (r.ok) {
            dbLog(`[Audio] ✅ vocal depuis Mac`);
            setVocalGuideUrl(getMediaUrl(vocal.fileName!)); setVocalCached(false);
          } else {
            dbLog(`[Audio] Mac KO → Railway pour vocal`);
            setVocalGuideUrl(`/api/media/${encodeURIComponent(vocal.fileName!)}`); setVocalCached(false);
          }
        })
        .catch(() => {
          if (!cancelled) {
            dbLog(`[Audio] Mac timeout → Railway pour vocal`);
            setVocalGuideUrl(`/api/media/${encodeURIComponent(vocal.fileName!)}`); setVocalCached(false);
          }
        })
        .finally(() => { if (!cancelled) setVocalLoading(false); });
    } else {
      // Pas de Mac → Railway directement (GitHub Releases)
      dbLog(`[Audio] vocal → Railway /api/media/`);
      setVocalGuideUrl(`/api/media/${encodeURIComponent(vocal.fileName!)}`); setVocalCached(false);
      setVocalLoading(false);
    }

    return () => { cancelled = true; };
  }, [selected?.id]);

  // Précharger l'inst dans previewInstRef dès que instUrl change
  // → quand on appuie Play, l'inst est déjà bufferisé = sync immédiate
  useEffect(() => {
    const pInst = previewInstRef.current;
    if (!pInst) return;
    if (instUrl) {
      pInst.src = instUrl;
      pInst.volume = 0; // silencieux pendant le préchargement
      pInst.load();
    } else {
      pInst.src = '';
    }
  }, [instUrl]);

  const playRecording = useCallback(async (rec: MobileRecording) => {
    if (!playRef.current) return;
    if (playingId === rec.id) {
      playRef.current.pause();
      try { const p = previewInstRef.current; if (p) { p.pause(); p.currentTime = 0; } } catch {}
      setPlayingId(null);
      return;
    }

    // ── Chercher le blob audio ────────────────────────────────────────────
    let blob: Blob | null = null;

    // 1. PRIORITÉ ABSOLUE : data: URL déjà en mémoire dans rec.dataUrl.
    // C'est TOUJOURS la version la plus à jour (ex: juste après un FX/reverb
    // appliqué). AVANT ce correctif, IndexedDB était interrogé en premier,
    // mais sa sauvegarde après un FX est asynchrone et non-bloquante — si
    // l'utilisateur cliquait Play juste après "✓ Appliqué", l'écriture
    // IndexedDB pouvait ne pas être terminée et l'ANCIENNE version (sans
    // l'effet) était lue à la place, donnant l'impression que le FX/reverb
    // ne s'appliquait pas du tout.
    if (rec.dataUrl && rec.dataUrl.startsWith('data:')) {
      try {
        const [header, data] = rec.dataUrl.split(',');
        const mime = header.match(/:(.*?);/)?.[1] ?? 'audio/mp4';
        const binary = atob(data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        blob = new Blob([bytes], { type: mime });
        console.log(`[Play] dataUrl mémoire (priorité): ${(blob.size/1024).toFixed(0)} Ko | type=${mime}`);
      } catch (e) {
        console.warn('[Play] Erreur décodage dataUrl mémoire:', e);
      }
    }

    // 2. IndexedDB (stocké par saveRecordingLocallyAsync) — fallback
    if (!blob) {
      try {
        blob = await studioOfflineDB.getAudio(`rec_${rec.id}`);
        if (blob) console.log(`[Play] IndexedDB: ${(blob.size/1024).toFixed(0)} Ko`);
      } catch(e) {
        console.warn('[Play] IndexedDB erreur:', e);
      }
    }

    // 3. dataUrl en mémoire (blob: ou sentinelle opfs:) — autres formats
    if (!blob && rec.dataUrl) {
      try {
        if (rec.dataUrl.startsWith('blob:')) {
          // blob: URL — peut être morte après redémarrage iOS
          // Essayer d'abord le blob vivant en mémoire (mis là par reloadRecordings)
          const memBlob = (window as any)[`__trackBlob_${rec.id}`] as Blob | undefined;
          if (memBlob && memBlob.size > 0) {
            blob = memBlob;
          } else {
            // Tenter le fetch — si ça échoue (URL morte), on passera au fallback IDB dessous
            try { blob = await fetch(rec.dataUrl).then(r => r.blob()); } catch {}
          }
          // Si toujours rien → retenter IDB avec clé backup
          if (!blob || blob.size === 0) {
            try {
              const bk = await studioOfflineDB.getAudio(`backup_voice_${rec.id}`);
              if (bk && bk.size > 0) { blob = bk; console.log(`[Play] blob: mort → backup IDB`); }
            } catch {}
          }
        } else if (rec.dataUrl.startsWith('opfs:')) {
          // Sentinelle — chercher dans les caches mémoire (FX ou harmony)
          const key = rec.dataUrl.slice(5);
          const fxBlob = (window as any).__lastFxBlob as Blob | undefined;
          const fxKey  = (window as any).__lastFxKey  as string | undefined;
          const harmBlobs = (window as any).__harmonyBlobs as Record<string,Blob> | undefined;
          if (fxBlob && fxKey === key) {
            blob = fxBlob;
          } else if (harmBlobs && harmBlobs[key]) {
            blob = harmBlobs[key];
          } else {
            // Fallback OPFS
            try { blob = await studioOfflineDB.getAudio(key); } catch {}
          }
        }
      } catch(e) {
        console.error('[Play] Erreur décodage dataUrl:', e);
      }
    }

    if (!blob || blob.size === 0) {
      console.error('[Play] Aucun blob disponible pour', rec.id);
      alert('Fichier audio introuvable. La prise a peut-être été perdue.');
      return;
    }

    // Révoquer l'URL précédente si elle existe
    const prevUrl = (playRef.current as any).__blobUrl as string | undefined;
    if (prevUrl) { URL.revokeObjectURL(prevUrl); }

    const fixedBlob = fixBlobType(blob);
    const src = URL.createObjectURL(fixedBlob);
    (playRef.current as any).__blobUrl = src;

    const pInst = previewInstRef.current;
    const useInst = previewInstVol > 0 && !!instUrl && !!pInst;

    // Si pInst n'a pas encore la bonne URL, la charger maintenant
    // (normalement déjà fait par preloadPreviewInst au changement de chanson)
    if (useInst && pInst && pInst.src !== instUrl) {
      pInst.src = instUrl!;
      pInst.load();
    }

    playRef.current.src = src;
    playRef.current.load();

    // Attendre canplay de la VOIX seulement — l'inst doit déjà être prêt (préchargé)
    // Si l'inst n'est pas prêt dans 500ms, on joue quand même sans inst plutôt que d'attendre
    const waitVoice = (el: HTMLAudioElement): Promise<void> =>
      el.readyState >= 3
        ? Promise.resolve()
        : new Promise(res => {
            const h = () => { el.removeEventListener('canplay', h); res(); };
            el.addEventListener('canplay', h, { once: true });
            setTimeout(res, 5000);
          });

    try {
      await waitVoice(playRef.current);

      if (useInst && pInst) {
        // Normaliser le blob voix avant preview pour qu'elle soit à même niveau que le stem
        // On mesure le peak et on booste jusqu'à -1dBFS via OfflineAudioContext
        let normalizedSrc = src;
        try {
          const normCtx = new OfflineAudioContext(1, 1, 44100); // juste pour décoder
          const ab = await fixedBlob.arrayBuffer();
          const actx = new (window.AudioContext || (window as any).webkitAudioContext)();
          const decoded = await actx.decodeAudioData(ab);
          actx.close();
          // Trouver le peak
          let peak = 0;
          for (let c = 0; c < decoded.numberOfChannels; c++) {
            const ch = decoded.getChannelData(c);
            for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
          }
          // Si la voix est plus de 6dB sous le maximum → booster
          if (peak > 0.001 && peak < 0.5) {
            const targetGain = 0.89 / peak; // -1dBFS target
            const offCtx = new OfflineAudioContext(
              decoded.numberOfChannels, decoded.length, decoded.sampleRate
            );
            const src2 = offCtx.createBufferSource(); src2.buffer = decoded;
            const gainN = offCtx.createGain(); gainN.gain.value = targetGain;
            src2.connect(gainN); gainN.connect(offCtx.destination); src2.start(0);
            const normBuf = await offCtx.startRendering();
            // Convertir en Blob WAV pour l'élément audio
            const wavData = audioBufferToWav(normBuf);
            const normBlob = new Blob([wavData], { type: 'audio/wav' });
            const prevNorm = (playRef.current as any).__normUrl as string | undefined;
            if (prevNorm) URL.revokeObjectURL(prevNorm);
            normalizedSrc = URL.createObjectURL(normBlob);
            (playRef.current as any).__normUrl = normalizedSrc;
            playRef.current.src = normalizedSrc;
            playRef.current.load();
            await waitVoice(playRef.current);
          }
        } catch (e) {
          console.warn('[Preview] Normalisation échouée, lecture directe', e);
        }
        pInst.volume = previewInstVol * 0.4;
        pInst.currentTime = 0;
        playRef.current.volume = 1.0;
        const p1 = playRef.current.play();
        pInst.play().catch(() => {});
        await p1;
      } else {
        playRef.current.volume = 1.0;
        await playRef.current.play();
      }
    } catch(e: any) {
      URL.revokeObjectURL(src);
      (playRef.current as any).__blobUrl = undefined;
      if (pInst) { try { pInst.pause(); pInst.currentTime = 0; } catch {} }
      if (e.name !== 'AbortError') alert(`Erreur lecture: ${e.message}`);
      return;
    }

    setPlayingId(rec.id);
    playRef.current.onended = () => {
      setPlayingId(null);
      URL.revokeObjectURL(src);
      if (playRef.current) (playRef.current as any).__blobUrl = undefined;
      try { if (pInst) { pInst.pause(); pInst.currentTime = 0; } } catch {}
    };
  }, [playingId, previewInstVol, instUrl]);

  const playMix = useCallback((dataUrl: string) => {
    if (!playRef.current) return;
    if (playingId === 'mix') { playRef.current.pause(); setPlayingId(null); return; }
    playRef.current.src = dataUrl; playRef.current.load(); playRef.current.play().catch(() => {});
    setPlayingId('mix'); playRef.current.onended = () => setPlayingId(null);
  }, [playingId]);

  const stopPlayback = useCallback(() => {
    if (!playRef.current) return;
    playRef.current.pause();
    try { previewInstRef.current?.pause(); } catch {}
    const prevUrl = (playRef.current as any).__blobUrl as string | undefined;
    if (prevUrl) { URL.revokeObjectURL(prevUrl); (playRef.current as any).__blobUrl = undefined; }
    setPlayingId(null);
  }, []);

  return {
    instUrl, vocalGuideUrl, vocalGuideVol, playingId,
    instLoading, vocalLoading,
    instCached, vocalCached,
    instRef, vocalGuideRef, playRef, vocalVolRef,
    setVocalGuideVol: updateVocalVol,
    previewInstVol, setPreviewInstVol, adjustInstOffset, instOffsetMs, autoDetectOffset,
    playRecording, stopPlayback, playMix,
    getInstPlaybackTime,
  };
}
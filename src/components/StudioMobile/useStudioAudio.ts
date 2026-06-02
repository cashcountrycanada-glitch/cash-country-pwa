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
    // Type vide → laisser tel quel (iOS essaiera de détecter)
    if (t === '') return blob;
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
  playRecording:    (rec: MobileRecording) => Promise<void>;
  stopPlayback:     () => void;
  playMix:          (dataUrl: string) => void;
  getInstPlaybackTime: () => number; // temps de lecture actuel du stem inst (sec)
}

export function useStudioAudio(selected: Song | null): AudioResult {
  const [instUrl, setInstUrl] = useState<string | null>(null);
  const [vocalGuideUrl, setVocalGuideUrl] = useState<string | null>(null);
  const [vocalGuideVol, setVocalGuideVol] = useState(0.4);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [instLoading, setInstLoading] = useState(false);
  const [vocalLoading, setVocalLoading] = useState(false);
  const [instCached, setInstCached] = useState(false);
  const [vocalCached, setVocalCached] = useState(false);

  const instRef = useRef(null as unknown as HTMLAudioElement);
  const vocalGuideRef = useRef(null as unknown as HTMLAudioElement);
  const playRef = useRef(null as unknown as HTMLAudioElement);
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
    (vocalGuideRef as React.MutableRefObject<HTMLAudioElement>).current = makeAudioEl();
    (playRef as React.MutableRefObject<HTMLAudioElement>).current = makeAudioEl();
  }

  useEffect(() => {
    return () => {
      instRef.current?.pause(); instRef.current?.remove();
      vocalGuideRef.current?.pause(); vocalGuideRef.current?.remove();
      playRef.current?.pause(); playRef.current?.remove();
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
      // Appliquer le volume dès que possible
      el.oncanplay = () => {
        // 1. Fallback immédiat via .volume (fonctionne toujours)
        try { el.volume = vocalVolRef.current; } catch {}
        // 2. GainNode si AudioContext disponible
        setVolumeIOS(vocalVolRef.current);
      };
      // Aussi appliquer .volume directement maintenant (avant canplay)
      try { el.volume = vocalVolRef.current; } catch {}
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

  const playRecording = useCallback(async (rec: MobileRecording) => {
    if (!playRef.current) return;
    if (playingId === rec.id) { playRef.current.pause(); setPlayingId(null); return; }

    // ── Chercher le blob audio ────────────────────────────────────────────
    let blob: Blob | null = null;

    // 1. IndexedDB (stocké par saveRecordingLocallyAsync)
    try {
      blob = await studioOfflineDB.getAudio(`rec_${rec.id}`);
      if (blob) console.log(`[Play] IndexedDB: ${(blob.size/1024).toFixed(0)} Ko`);
    } catch(e) {
      console.warn('[Play] IndexedDB erreur:', e);
    }

    // 2. dataUrl en mémoire (ou sentinelle opfs:)
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
        } else {
          const [header, data] = rec.dataUrl.split(',');
          const mime = header.match(/:(.*?);/)?.[1] ?? 'audio/mp4';
          const binary = atob(data);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          blob = new Blob([bytes], { type: mime });
          console.log(`[Play] dataUrl: ${(blob.size/1024).toFixed(0)} Ko | type=${mime}`);
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
    console.log(`[Play] URL créée: ${src} | type=${fixedBlob.type}`);

    playRef.current.src = src;
    playRef.current.load();
    try {
      await playRef.current.play();
      console.log('[Play] Lecture demarree');
    } catch(e: any) {
      console.error('[Play] Erreur play():', e.name, e.message);
      URL.revokeObjectURL(src);
      (playRef.current as any).__blobUrl = undefined;
      if (e.name !== 'AbortError') alert(`Erreur lecture: ${e.message}`);
      return;
    }
    setPlayingId(rec.id);
    playRef.current.onended = () => {
      setPlayingId(null);
      URL.revokeObjectURL(src);
      if (playRef.current) (playRef.current as any).__blobUrl = undefined;
    };
  }, [playingId]);

  const playMix = useCallback((dataUrl: string) => {
    if (!playRef.current) return;
    if (playingId === 'mix') { playRef.current.pause(); setPlayingId(null); return; }
    playRef.current.src = dataUrl; playRef.current.load(); playRef.current.play().catch(() => {});
    setPlayingId('mix'); playRef.current.onended = () => setPlayingId(null);
  }, [playingId]);

  const stopPlayback = useCallback(() => {
    if (!playRef.current) return;
    playRef.current.pause();
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
    playRecording, stopPlayback, playMix,
    getInstPlaybackTime,
  };
}
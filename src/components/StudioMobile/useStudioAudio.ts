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
function fixBlobType(blob: Blob): Blob {
  if (isIOS()) {
    // iOS Safari ne supporte que audio/mp4, audio/mpeg, audio/aac
    // FLAC, WebM, OGG, et '' sont tous invalides → forcer audio/mp4
    const t = blob.type.toLowerCase();
    if (!t.includes('mp4') && !t.includes('mpeg') && !t.includes('aac') && !t.includes('mp3')) {
      return new Blob([blob], { type: 'audio/mp4' });
    }
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
      if (t >= 0) return t;
    }
    // Priorité 2 : tracker Date.now() (fallback si AudioContext suspendu)
    if ((window as any).__instWallStart) {
      const elapsed = (Date.now() - (window as any).__instWallStart) / 1000;
      return ((window as any).__instCtxOffset || 0) + elapsed;
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

  useEffect(() => {
    if (!selected) { setInstUrl(null); setInstCached(false); return; }
    const inst = selected.versions?.find(v =>
      v.trackType === TrackType.STEM_INSTRUMENTAL ||
      v.trackType === 'Instrumental Stem (Export ZIP)' ||
      v.trackType === 'Instrumentale Pure (Copie IA)'
    );
    if (!inst?.fileName) { setInstUrl(null); setInstCached(false); return; }
    setInstLoading(true);
    // iOS et Desktop : IndexedDB en priorité, réseau en fallback
    studioOfflineDB.getAudio(`inst_${selected.id}`).then(blob => {
      if (blob) {
        // Révoquer l'ancien blob URL avant d'en créer un nouveau (évite memory leak → crash iOS)
        if (instBlobUrlRef.current) { URL.revokeObjectURL(instBlobUrlRef.current); }
        const url = URL.createObjectURL(fixBlobType(blob));
        instBlobUrlRef.current = url;
        setInstUrl(url);
        // Vérifier que le blob est valide (pas vide ni corrompu)
        if (blob.size < 1000) {
          console.error(`[Audio] ❌ inst blob trop petit (${blob.size} bytes) — corrompu ou vide`);
          setInstUrl(null); setInstCached(false);
        } else {
          setInstCached(true);
          console.log(`[Audio] ✅ inst CACHE: ${(blob.size/1024/1024).toFixed(1)} MB | type=${blob.type} | key=inst_${selected.id}`);
        }
        // Pré-décoder pour un play instantané (évite le délai fetch+decode au tap)
        blob.arrayBuffer().then(buf => {
          const ctx = (window as any).__warmContext as AudioContext | undefined;
          if (ctx) ctx.decodeAudioData(buf).then(decoded => {
            instDecodedBufRef.current = decoded;
            (window as any).__instDecodedBuf = decoded;
          }).catch(() => {});
        }).catch(() => {});
      } else {
        // Pas en cache — vérifier si Mac joignable avant de streamer
        const macUrl = ((window as any).__CC_MAC_URL as string) || '';
        if (macUrl.startsWith('http')) {
          fetch(`${macUrl}/api/songs`, { method: 'HEAD', signal: AbortSignal.timeout(2500) })
            .then(r => {
              if (r.ok) { setInstUrl(getMediaUrl(inst.fileName!)); }
              else { setInstUrl(null); console.error('[Audio] ❌ Mac injoignable — mets la chanson en cache via ☁️'); }
              setInstCached(false);
            })
            .catch(() => { setInstUrl(null); setInstCached(false); console.error('[Audio] ❌ Mac hors ligne — mets la chanson en cache via ☁️'); });
        } else {
          setInstUrl(null); setInstCached(false);
          console.error('[Audio] ❌ Mac non configuré — mets la chanson en cache via ☁️');
        }
      }
    }).catch(() => {
      setInstUrl(null);
      setInstCached(false);
      console.error('[Audio] ❌ Erreur chargement inst depuis cache');
    }).finally(() => setInstLoading(false));
  }, [selected?.id, selected?.versions?.length]);


  useEffect(() => {
    if (!selected) { setVocalGuideUrl(null); setVocalCached(false); return; }
    const vocal = selected.versions?.find(v => v.trackType === TrackType.STEM_VOCAL);
    if (!vocal?.fileName) { setVocalGuideUrl(null); setVocalCached(false); return; }
    setVocalLoading(true);
    // iOS et Desktop : IndexedDB en priorité, réseau en fallback
    studioOfflineDB.getAudio(`vocal_${selected.id}`).then(blob => {
      if (blob) {
        // Révoquer l'ancien blob URL avant d'en créer un nouveau
        if (vocalBlobUrlRef.current) { URL.revokeObjectURL(vocalBlobUrlRef.current); }
        const vurl = URL.createObjectURL(fixBlobType(blob));
        vocalBlobUrlRef.current = vurl;
        setVocalGuideUrl(vurl);
        setVocalCached(true);
        // Pré-décoder vocal aussi
        blob.arrayBuffer().then(buf => {
          const ctx = (window as any).__warmContext as AudioContext | undefined;
          if (ctx) ctx.decodeAudioData(buf).then(decoded => {
            vocalDecodedBufRef.current = decoded;
            (window as any).__vocalDecodedBuf = decoded;
          }).catch(() => {});
        }).catch(() => {});
        if (blob.size < 1000) {
          console.error(`[Audio] ❌ vocal blob trop petit (${blob.size} bytes) — corrompu ou vide`);
          setVocalGuideUrl(null); setVocalCached(false);
        } else {
          setVocalCached(true);
          console.log(`[Audio] ✅ vocal CACHE: ${(blob.size/1024/1024).toFixed(1)} MB | type=${blob.type} | key=vocal_${selected.id}`);
        }
      } else {
        // Pas en cache — vérifier si Mac joignable avant de streamer
        const macUrlV = ((window as any).__CC_MAC_URL as string) || '';
        if (macUrlV.startsWith('http')) {
          fetch(`${macUrlV}/api/songs`, { method: 'HEAD', signal: AbortSignal.timeout(2500) })
            .then(r => {
              if (r.ok) { setVocalGuideUrl(getMediaUrl(vocal.fileName!)); }
              else { setVocalGuideUrl(null); }
              setVocalCached(false);
            })
            .catch(() => { setVocalGuideUrl(null); setVocalCached(false); });
        } else {
          setVocalGuideUrl(null); setVocalCached(false);
        }
      }
    }).catch(() => {
      setVocalGuideUrl(null);
      setVocalCached(false);
    }).finally(() => setVocalLoading(false));
  }, [selected?.id, selected?.versions?.length]);

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

    // 2. dataUrl en mémoire
    if (!blob && rec.dataUrl) {
      try {
        const [header, data] = rec.dataUrl.split(',');
        const mime = header.match(/:(.*?);/)?.[1] ?? 'audio/mp4';
        const binary = atob(data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        blob = new Blob([bytes], { type: mime });
        console.log(`[Play] dataUrl: ${(blob.size/1024).toFixed(0)} Ko | type=${mime}`);
      } catch(e) {
        console.error('[Play] Erreur décodage dataUrl:', e);
      }
    }

    if (!blob || blob.size === 0) {
      console.error('[Play] Aucun blob disponible pour', rec.id);
      alert('Fichier audio introuvable. La prise a peut-être été perdue.');
      return;
    }

    const fixedBlob = fixBlobType(blob);
    const src = URL.createObjectURL(fixedBlob);
    console.log(`[Play] URL créée: ${src} | type=${fixedBlob.type}`);

    playRef.current.src = src;
    playRef.current.load();
    try {
      await playRef.current.play();
      console.log('[Play] Lecture demarree');
    } catch(e: any) {
      console.error('[Play] Erreur play():', e.name, e.message);
      alert(`Erreur lecture: ${e.message}`);
    }
    setPlayingId(rec.id);
    playRef.current.onended = () => { setPlayingId(null); URL.revokeObjectURL(src); };
  }, [playingId]);

  const playMix = useCallback((dataUrl: string) => {
    if (!playRef.current) return;
    if (playingId === 'mix') { playRef.current.pause(); setPlayingId(null); return; }
    playRef.current.src = dataUrl; playRef.current.load(); playRef.current.play().catch(() => {});
    setPlayingId('mix'); playRef.current.onended = () => setPlayingId(null);
  }, [playingId]);

  const stopPlayback = useCallback(() => { playRef.current?.pause(); setPlayingId(null); }, []);

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
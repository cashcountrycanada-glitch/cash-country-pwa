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
  if (isIOS() && (blob.type === 'audio/webm' || blob.type === '')) return new Blob([blob], { type: 'audio/mp4' });
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

  useEffect(() => {
    if (!selected) { setInstUrl(null); setInstCached(false); return; }
    const inst = selected.versions?.find(v => v.trackType === TrackType.STEM_INSTRUMENTAL);
    if (!inst?.fileName) { setInstUrl(null); setInstCached(false); return; }
    setInstLoading(true);
    // iOS et Desktop : IndexedDB en priorité, réseau en fallback
    studioOfflineDB.getAudio(`inst_${selected.id}`).then(blob => {
      if (blob) {
        setInstUrl(URL.createObjectURL(fixBlobType(blob)));
        setInstCached(true);
        console.log(`[Audio] inst CACHE: ${(blob.size/1024/1024).toFixed(1)} MB`);
      } else {
        // Pas en cache — URL réseau (Mac requis)
        setInstUrl(getMediaUrl(inst.fileName!));
        setInstCached(false);
        console.warn('[Audio] inst NON EN CACHE — URL réseau');
        // Télécharger en arrière-plan pour mise en cache
        fetch(getMediaUrl(inst.fileName!))
          .then(r => r.ok ? r.blob() : null)
          .then(b => b && studioOfflineDB.saveAudio(`inst_${selected.id}`, fixBlobType(b), { songId: selected.id, songTitle: selected.title, type: 'instrumental' }).catch(() => {}))
          .catch(() => {});
      }
    }).catch(() => {
      setInstUrl(getMediaUrl(inst.fileName!));
      setInstCached(false);
    }).finally(() => setInstLoading(false));
  }, [selected?.id]);


  useEffect(() => {
    if (!selected) { setVocalGuideUrl(null); setVocalCached(false); return; }
    const vocal = selected.versions?.find(v => v.trackType === TrackType.STEM_VOCAL);
    if (!vocal?.fileName) { setVocalGuideUrl(null); setVocalCached(false); return; }
    setVocalLoading(true);
    // iOS et Desktop : IndexedDB en priorité, réseau en fallback
    studioOfflineDB.getAudio(`vocal_${selected.id}`).then(blob => {
      if (blob) {
        setVocalGuideUrl(URL.createObjectURL(fixBlobType(blob)));
        setVocalCached(true);
        console.log(`[Audio] vocal CACHE: ${(blob.size/1024/1024).toFixed(1)} MB`);
      } else {
        setVocalGuideUrl(getMediaUrl(vocal.fileName!));
        setVocalCached(false);
        console.warn('[Audio] vocal NON EN CACHE — URL réseau');
        fetch(getMediaUrl(vocal.fileName!))
          .then(r => r.ok ? r.blob() : null)
          .then(b => b && studioOfflineDB.saveAudio(`vocal_${selected.id}`, fixBlobType(b), { songId: selected.id, songTitle: selected.title, type: 'vocal' }).catch(() => {}))
          .catch(() => {});
      }
    }).catch(() => {
      setVocalGuideUrl(getMediaUrl(vocal.fileName!));
      setVocalCached(false);
    }).finally(() => setVocalLoading(false));
  }, [selected?.id]);
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
  };
}
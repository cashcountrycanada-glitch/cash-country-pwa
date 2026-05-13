/**
 * CompEditor.tsx — Éditeur de comping multi-prise v2
 *
 * CORRECTIFS :
 * - audio playsInline (obligatoire iOS)
 * - playTake() cherche le blob dans IndexedDB si dataUrl absent
 * - Waveform chargée même si dataUrl absent (via IndexedDB)
 * - Sélection de région : min 0.3s au lieu de 0.5s
 * - "Tout sélectionner" par prise (bouton pratique)
 * - Indicateur de durée en temps réel pendant la sélection
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  ChevronLeft, Play, Pause, Trash2, Loader2,
  CheckCircle2, Scissors, Music, PlusCircle,
} from 'lucide-react';
import { studioService, MobileRecording, Take, Region } from '../../services/StudioService';
import { studioOfflineDB } from '../../services/StudioOfflineDB';
import { Song } from '../../types';

interface Props {
  song:         Song;
  takes:        Take[];
  onBack:       () => void;
  onCompReady:  (blob: Blob) => void;
  isOnline:     boolean;
}

const TAKE_COLORS = ['#ef4444','#f97316','#eab308','#22c55e','#3b82f6','#a855f7','#ec4899'];

function fmt(s: number) {
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

// Récupérer le dataUrl d'un enregistrement (mémoire ou IndexedDB)
async function getRecordingDataUrl(rec: MobileRecording): Promise<string | null> {
  if (rec.dataUrl) return rec.dataUrl;
  try {
    const blob = await studioOfflineDB.getAudio(`rec_${rec.id}`);
    if (blob) return studioService.blobToDataUrl(blob);
  } catch {}
  return null;
}

// ── WaveformTrack ─────────────────────────────────────────────────────────────
function WaveformTrack({
  take, color, onAddRegion, onRemoveRegion, isPlaying, onPlayPause,
}: {
  take:           Take;
  color:          string;
  onAddRegion:    (region: Region) => void;
  onRemoveRegion: (regionId: string) => void;
  isPlaying:      boolean;
  onPlayPause:    () => void;
}) {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const duration   = Math.max(take.recording.duration || 1, 1);
  const [selecting, setSelecting] = useState(false);
  const [selStart, setSelStart]   = useState(0);
  const [selEnd, setSelEnd]       = useState(0);

  // Dessin canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width, H = canvas.height;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, W, H);

    // Waveform
    if (take.waveformData && take.waveformData.length > 0) {
      const pts = take.waveformData;
      const barW = W / pts.length;
      pts.forEach((amp, i) => {
        const h = Math.max(2, amp * H * 0.85);
        ctx.fillStyle = color + '60';
        ctx.fillRect(i * barW, (H - h) / 2, Math.max(barW - 0.5, 1), h);
      });
    } else {
      // Placeholder
      ctx.fillStyle = color + '20';
      ctx.fillRect(0, H * 0.25, W, H * 0.5);
    }

    // Régions existantes
    take.regions.forEach(r => {
      const x1 = (r.startSec / duration) * W;
      const x2 = (r.endSec   / duration) * W;
      ctx.fillStyle = color + '45';
      ctx.fillRect(x1, 0, x2 - x1, H);
      // Bords de région
      ctx.fillStyle = color;
      ctx.fillRect(x1, 0, 3, H);
      ctx.fillRect(Math.max(x2 - 3, x1 + 3), 0, 3, H);
    });

    // Sélection en cours
    if (selecting && Math.abs(selEnd - selStart) > 0.01) {
      const x1 = (Math.min(selStart, selEnd) / duration) * W;
      const x2 = (Math.max(selStart, selEnd) / duration) * W;
      ctx.fillStyle = '#ffffff20';
      ctx.fillRect(x1, 0, x2 - x1, H);
      ctx.strokeStyle = '#ffffff80';
      ctx.lineWidth = 2;
      ctx.strokeRect(x1, 0, x2 - x1, H);
    }
  }, [take.waveformData, take.regions, selecting, selStart, selEnd, color, duration]);

  const xToSec = useCallback((x: number, canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect();
    const relX  = Math.max(0, Math.min(x - rect.left, rect.width));
    return (relX / rect.width) * duration;
  }, [duration]);

  const onTouchStart = (e: React.TouchEvent) => {
    e.preventDefault();
    const sec = xToSec(e.touches[0].clientX, canvasRef.current!);
    setSelecting(true); setSelStart(sec); setSelEnd(sec);
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (!selecting) return;
    e.preventDefault();
    setSelEnd(xToSec(e.touches[0].clientX, canvasRef.current!));
  };
  const onTouchEnd = () => {
    if (!selecting) return;
    setSelecting(false);
    const start = Math.min(selStart, selEnd);
    const end   = Math.max(selStart, selEnd);
    if (end - start < 0.3) { setSelStart(0); setSelEnd(0); return; }
    onAddRegion({
      id:       `REG-${Date.now()}`,
      takeId:   take.recording.id,
      startSec: parseFloat(start.toFixed(2)),
      endSec:   parseFloat(end.toFixed(2)),
      label:    take.recording.trackLabel || `Prise`,
      color,
    });
    setSelStart(0); setSelEnd(0);
  };

  const selectAll = () => {
    onAddRegion({
      id: `REG-${Date.now()}`,
      takeId: take.recording.id,
      startSec: 0,
      endSec: duration,
      label: take.recording.trackLabel || 'Tout',
      color,
    });
  };

  const selDuration = Math.abs(selEnd - selStart);

  return (
    <div className="bg-zinc-950 border border-white/8 rounded-2xl overflow-hidden">
      {/* En-tête */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-white/5">
        <div className="w-2 h-8 rounded-full shrink-0" style={{ background: color }}/>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-black text-white truncate">
            {take.recording.trackLabel || `Prise ${take.recording.id.slice(-4)}`}
          </p>
          <p className="text-[10px] text-zinc-500">
            {fmt(duration)} · {take.regions.length} région{take.regions.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button
          onClick={selectAll}
          title="Tout sélectionner"
          className="px-2.5 py-1.5 bg-zinc-800 rounded-xl text-[10px] font-black text-zinc-400 uppercase active:scale-90 shrink-0">
          Tout
        </button>
        <button onClick={onPlayPause}
          className="w-9 h-9 rounded-xl bg-zinc-800 flex items-center justify-center active:scale-90 shrink-0">
          {isPlaying ? <Pause size={14} className="text-white"/> : <Play size={14} className="text-white"/>}
        </button>
      </div>

      {/* Canvas waveform */}
      <div className="relative px-2 py-2">
        <canvas
          ref={canvasRef}
          width={640} height={80}
          className="w-full rounded-xl touch-none"
          style={{ display: 'block', cursor: 'crosshair' }}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        />
        <p className="text-[9px] text-zinc-700 text-center mt-1 font-black uppercase tracking-widest">
          {selecting && selDuration > 0.1
            ? `Sélection : ${selDuration.toFixed(1)}s`
            : 'Glisse pour sélectionner · "Tout" pour tout prendre'}
        </p>
      </div>

      {/* Régions */}
      {take.regions.length > 0 && (
        <div className="px-4 pb-3 space-y-1.5">
          {take.regions.map(r => (
            <div key={r.id} className="flex items-center gap-2 bg-zinc-900 rounded-xl px-3 py-2">
              <div className="w-2 h-2 rounded-full shrink-0" style={{ background: color }}/>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-black text-white">
                  {fmt(r.startSec)} → {fmt(r.endSec)}
                  <span className="text-zinc-500 font-normal ml-2">{(r.endSec - r.startSec).toFixed(1)}s</span>
                </p>
              </div>
              <button onClick={() => onRemoveRegion(r.id)} className="text-zinc-700 hover:text-red-500 active:scale-90">
                <Trash2 size={13}/>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── CompEditor principal ───────────────────────────────────────────────────────
export default function CompEditor({ song, takes: initialTakes, onBack, onCompReady, isOnline }: Props) {
  const [takes, setTakes]             = useState<Take[]>(initialTakes);
  const [playingId, setPlayingId]     = useState<string | null>(null);
  const [isMixing, setIsMixing]       = useState(false);
  const [compBlob, setCompBlob]       = useState<Blob | null>(null);
  const [compUrl,  setCompUrl]        = useState<string | null>(null);
  const [playingComp, setPlayingComp] = useState(false);
  const [loadingWave, setLoadingWave] = useState<Set<string>>(new Set());
  const audioRef = useRef<HTMLAudioElement>(null);

  // Charger waveforms — essayer IndexedDB si dataUrl absent
  useEffect(() => {
    takes.forEach(take => {
      if (take.waveformData) return;
      setLoadingWave(prev => new Set([...prev, take.recording.id]));

      getRecordingDataUrl(take.recording).then(dataUrl => {
        if (!dataUrl) {
          setLoadingWave(prev => { const s = new Set(prev); s.delete(take.recording.id); return s; });
          return;
        }
        return studioService.analyzeWaveform(dataUrl, 160).then(wf => {
          setTakes(prev => prev.map(t =>
            t.recording.id === take.recording.id ? { ...t, waveformData: wf } : t
          ));
        });
      }).catch(() => {}).finally(() => {
        setLoadingWave(prev => { const s = new Set(prev); s.delete(take.recording.id); return s; });
      });
    });
  }, []);

  const addRegion = (takeId: string, region: Region) =>
    setTakes(prev => prev.map(t =>
      t.recording.id === takeId ? { ...t, regions: [...t.regions, region] } : t
    ));

  const removeRegion = (takeId: string, regionId: string) =>
    setTakes(prev => prev.map(t =>
      t.recording.id === takeId ? { ...t, regions: t.regions.filter(r => r.id !== regionId) } : t
    ));

  const playTake = async (take: Take) => {
    if (!audioRef.current) return;
    if (playingId === take.recording.id) {
      audioRef.current.pause(); setPlayingId(null); return;
    }
    const dataUrl = await getRecordingDataUrl(take.recording);
    if (!dataUrl) return;
    audioRef.current.src = dataUrl;
    audioRef.current.load();
    audioRef.current.play().catch(() => {});
    setPlayingId(take.recording.id);
    audioRef.current.onended = () => setPlayingId(null);
  };

  const totalRegions  = takes.reduce((s, t) => s + t.regions.length, 0);
  const totalDuration = takes.reduce((s, t) => s + t.regions.reduce((rs, r) => rs + (r.endSec - r.startSec), 0), 0);

  const doComp = async () => {
    if (totalRegions === 0) return;
    setIsMixing(true);
    try {
      // Enrichir les takes avec les dataUrls depuis IndexedDB si nécessaire
      const enrichedTakes = await Promise.all(takes.map(async t => {
        if (t.recording.dataUrl) return t;
        const dataUrl = await getRecordingDataUrl(t.recording);
        return dataUrl ? { ...t, recording: { ...t.recording, dataUrl } } : t;
      }));
      const blob = await studioService.mixComp(enrichedTakes);
      if (compUrl) URL.revokeObjectURL(compUrl);
      const url = URL.createObjectURL(blob);
      setCompBlob(blob); setCompUrl(url);
    } catch (e: any) {
      alert('Erreur comp : ' + e.message);
    } finally {
      setIsMixing(false);
    }
  };

  const playComp = () => {
    if (!audioRef.current || !compUrl) return;
    if (playingComp) { audioRef.current.pause(); setPlayingComp(false); return; }
    audioRef.current.src = compUrl;
    audioRef.current.load();
    audioRef.current.play().catch(() => {});
    setPlayingComp(true);
    audioRef.current.onended = () => setPlayingComp(false);
    setPlayingId(null);
  };

  // Ordre des régions pour l'aperçu final
  const orderedRegions = takes
    .flatMap((take, i) => take.regions.map(r => ({ ...r, color: TAKE_COLORS[i % TAKE_COLORS.length] })))
    .sort((a, b) => a.startSec - b.startSec);

  return (
    <div className="min-h-screen bg-[#020202] text-white flex flex-col">

      {/* Header */}
      <div className="shrink-0 flex items-center gap-3 px-5 pt-6 pb-4 border-b border-zinc-900">
        <button onClick={onBack} className="w-10 h-10 rounded-xl bg-zinc-900 flex items-center justify-center active:scale-90">
          <ChevronLeft size={20}/>
        </button>
        <div className="flex-1 min-w-0">
          <p className="font-bebas text-xl text-white tracking-widest leading-none">COMP EDITOR</p>
          <p className="text-[10px] text-zinc-500 font-black uppercase truncate">
            {song.title} · {takes.length} prise{takes.length > 1 ? 's' : ''}
          </p>
        </div>
        {totalRegions > 0 && (
          <div className="bg-zinc-900 rounded-xl px-3 py-1.5 text-right shrink-0">
            <p className="text-[11px] font-black text-white">{totalRegions} rég.</p>
            <p className="text-[10px] text-zinc-500">{totalDuration.toFixed(1)}s</p>
          </div>
        )}
      </div>

      {/* Instructions */}
      <div className="mx-5 mt-4 bg-zinc-900/60 border border-white/5 rounded-2xl px-4 py-3">
        <p className="text-[11px] font-black text-white mb-0.5">Comment ça marche</p>
        <p className="text-[10px] text-zinc-400 leading-relaxed">
          Glisse sur la waveform pour choisir les meilleures parties de chaque prise. Le comp assemble tout dans l'ordre. Utilise "Tout" pour prendre une prise complète.
        </p>
      </div>

      {/* Prises */}
      <div className="flex-1 overflow-y-auto px-5 pt-4 pb-4 space-y-4" style={{ WebkitOverflowScrolling: 'touch' }}>

        {takes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3 opacity-30">
            <Scissors size={40} className="text-zinc-700"/>
            <p className="text-[12px] text-zinc-600 font-black uppercase text-center">Aucune prise disponible</p>
          </div>
        ) : takes.map((take, i) => (
          <div key={take.recording.id}>
            {loadingWave.has(take.recording.id) ? (
              <div className="bg-zinc-950 border border-white/8 rounded-2xl p-4 flex items-center gap-3">
                <Loader2 size={16} className="animate-spin text-zinc-600"/>
                <p className="text-[12px] text-zinc-500 font-black uppercase">Analyse waveform...</p>
              </div>
            ) : (
              <WaveformTrack
                take={take}
                color={TAKE_COLORS[i % TAKE_COLORS.length]}
                onAddRegion={region => addRegion(take.recording.id, region)}
                onRemoveRegion={regionId => removeRegion(take.recording.id, regionId)}
                isPlaying={playingId === take.recording.id}
                onPlayPause={() => playTake(take)}
              />
            )}
          </div>
        ))}

        {/* Aperçu ordre final */}
        {orderedRegions.length > 0 && (
          <div className="bg-zinc-900/60 border border-white/5 rounded-2xl p-4">
            <p className="text-[11px] font-black text-zinc-400 uppercase tracking-widest mb-3">Ordre du comp</p>
            {orderedRegions.map((r, i) => (
              <div key={r.id} className="flex items-center gap-2 mb-2">
                <span className="text-[11px] font-black text-zinc-600 w-5 shrink-0">{i + 1}</span>
                <div className="w-2 h-2 rounded-full shrink-0" style={{ background: r.color }}/>
                <p className="text-[12px] font-black text-white flex-1">
                  {fmt(r.startSec)} → {fmt(r.endSec)}
                </p>
                <p className="text-[10px] text-zinc-500">{(r.endSec - r.startSec).toFixed(1)}s</p>
              </div>
            ))}
            <div className="mt-2 pt-2 border-t border-white/5 flex justify-between">
              <p className="text-[11px] text-zinc-600 font-black uppercase">Durée</p>
              <p className="text-[12px] font-black text-white">{totalDuration.toFixed(1)}s</p>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="space-y-3 pt-2">
          <button onClick={doComp}
            disabled={totalRegions === 0 || isMixing}
            className="w-full py-4 bg-red-600 rounded-2xl font-black text-[14px] uppercase tracking-widest flex items-center justify-center gap-3 active:scale-95 transition-all disabled:opacity-40">
            {isMixing
              ? <><Loader2 size={18} className="animate-spin"/> Génération...</>
              : <><Scissors size={18}/> Générer le comp ({totalRegions} région{totalRegions !== 1 ? 's' : ''})</>}
          </button>

          {compUrl && (
            <>
              <button onClick={playComp}
                className="w-full py-4 bg-zinc-900 border border-zinc-700 rounded-2xl font-black text-[14px] uppercase tracking-widest flex items-center justify-center gap-3 active:scale-95 transition-all">
                {playingComp ? <><Pause size={18}/> Arrêter</> : <><Play size={18}/> Écouter le comp</>}
              </button>
              <button onClick={() => compBlob && onCompReady(compBlob)}
                className="w-full py-4 bg-emerald-700 rounded-2xl font-black text-[14px] uppercase tracking-widest flex items-center justify-center gap-3 active:scale-95 transition-all">
                <CheckCircle2 size={18}/> Utiliser ce comp
              </button>
            </>
          )}
        </div>
      </div>

      <audio ref={audioRef} playsInline className="hidden"/>
    </div>
  );
}

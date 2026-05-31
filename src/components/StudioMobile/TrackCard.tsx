/**
 * TrackCard.tsx — Carte piste mixer v3
 *
 * NOUVEAUTÉS :
 * - Bouton FX par piste qui ouvre un panneau de presets style BandLab
 * - Application du preset FX non-destructif via applyFxToTrack
 * - Waveform SVG avec progression lecture
 * - Badge pitch, badge Auto, indicateur clipping
 * - Preset FX actif affiché sur la carte
 */
import React, { useState, useEffect, useRef } from 'react';
import { Play, Pause, Trash2, VolumeX, Volume2, Zap, Loader2, CheckCircle2 } from 'lucide-react';
import { MobileRecording, studioService } from '../../services/StudioService';
import { TRACK_PRESETS, FX_PRESETS, FX_PRESET_DEFAULT, TRACK_FX_SUGGESTIONS, FxPreset, formatTime, formatDate } from './studio.types';
import WaveformBar from './WaveformBar';

interface Props {
  track:     MobileRecording;
  allTracks: MobileRecording[];
  playingId: string | null;
  onPlay:    (rec: MobileRecording) => void;
  onMute:    (trackIndex: number, muted: boolean) => void;
  onSolo:    (trackIndex: number) => void;
  onVolume:  (trackIndex: number, gain: number) => void;
  onPan:     (trackIndex: number, pan: number) => void;
  onDelete:  (trackIndex: number) => void;
  onTrackUpdate?: (updated: MobileRecording) => void;
}

export default function TrackCard({ track, allTracks, playingId, onPlay, onMute, onSolo, onVolume, onPan, onDelete, onTrackUpdate }: Props) {
  const preset     = TRACK_PRESETS.find(p => p.index === track.trackIndex) || TRACK_PRESETS[0];
  const gain       = track.gain ?? 1;
  const pan        = track.pan  ?? 0;
  const isPlaying  = playingId === track.id;
  const isClipping = gain > 1.0;
  // Solo : cette piste est en solo si toutes les autres sont mutées
  const isSolo = allTracks.length > 1 &&
    allTracks.every(t => t.trackIndex === track.trackIndex ? !t.muted : t.muted);

  // FX state
  const activeFxId = (track as any).fxPresetId as string | undefined;
  const activeFx   = FX_PRESETS.find(f => f.id === activeFxId) ?? null;
  const [showFxPanel, setShowFxPanel]   = useState(false);
  const [applyingFx, setApplyingFx]     = useState(false);
  const [applyPct, setApplyPct]         = useState(0);
  const [applyDone, setApplyDone]       = useState(false);
  const [showFxDetail, setShowFxDetail] = useState<FxPreset | null>(null);

  // Progression lecture
  const [playPct, setPlayPct] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (!isPlaying) { setPlayPct(undefined); return; }
    const handler = (e: Event) => {
      const el = e.target as HTMLAudioElement;
      if (el.duration > 0) setPlayPct((el.currentTime / el.duration) * 100);
    };
    document.querySelectorAll('audio').forEach(el => el.addEventListener('timeupdate', handler));
    return () => document.querySelectorAll('audio').forEach(el => el.removeEventListener('timeupdate', handler));
  }, [isPlaying]);

  const handleApplyFx = async (fx: FxPreset) => {
    if (!track.dataUrl) return;
    setApplyingFx(true); setApplyPct(0); setApplyDone(false);
    try {
      // Toujours appliquer depuis l'original — évite le double-application
      const sourceDataUrl = (track as any).originalDataUrl || track.dataUrl;
      const newDataUrl = await studioService.applyFxToTrack(
        sourceDataUrl, fx,
        (pct) => setApplyPct(pct),
      );
      const updated = {
        ...track,
        dataUrl: newDataUrl,
        originalDataUrl: sourceDataUrl, // conserver l'original pour les prochaines applications
        fxPresetId: fx.id,
      } as any;
      studioService.saveRecordingLocally(updated);
      onTrackUpdate?.(updated);
      setApplyDone(true);
      setTimeout(() => { setApplyDone(false); setShowFxPanel(false); }, 1500);
    } catch (e: any) {
      const isQuota = e?.name === 'QuotaExceededError'
        || (e?.message && e.message.toLowerCase().includes('quota'));
      if (isQuota) {
        // Erreur de stockage non-fatale : le FX est appliqué en mémoire.
        // L'événement studio:quotaExceeded sera émis par saveRecordingLocally.
        console.warn('[FX] Quota OPFS/IDB dépassé — FX conservé en mémoire:', e.message);
      } else {
        alert('Erreur FX : ' + e.message);
      }
    } finally {
      setApplyingFx(false); setApplyPct(0);
    }
  };

  const panLabel = pan === 0 ? 'C' : pan > 0 ? `R${Math.round(pan*100)}` : `L${Math.round(Math.abs(pan)*100)}`;
  const suggestedFxId = TRACK_FX_SUGGESTIONS[track.trackIndex ?? 0];

  return (
    <div className="rounded-2xl overflow-hidden transition-all"
      style={{
        background: '#0f0f0f',
        borderLeft: `3px solid ${track.muted ? '#27272a' : preset.color}`,
        border: `1px solid #1e1e1e`,
        borderLeftWidth: 3,
        borderLeftColor: track.muted ? '#27272a' : preset.color,
        opacity: track.muted ? 0.55 : 1,
      }}>

      {/* ── En-tête ── */}
      <div className="flex items-center gap-2.5 px-3 pt-3 pb-2">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 text-base"
          style={{ background: preset.color + '20' }}>
          {preset.emoji}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className="text-[13px] font-black text-white">{track.trackLabel}</p>
            {(track.pitchShift !== undefined && track.pitchShift !== 0) && (
              <span className="text-[8px] font-black px-1.5 py-0.5 rounded-full"
                style={{ background: preset.color + '25', color: preset.color }}>
                {track.pitchShift > 0 ? `+${track.pitchShift}` : track.pitchShift} ST
              </span>
            )}
            {(track as any).isGenerated && (
              <span className="text-[8px] font-black px-1.5 py-0.5 rounded-full bg-purple-900/40 text-purple-400">✨ Auto</span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <p className="text-[9px] text-zinc-600">{formatTime(track.duration)} · {formatDate(track.recordedAt)}</p>
            {activeFx && (
              <span className="text-[8px] font-black px-1.5 py-0.5 rounded-full"
                style={{ background: activeFx.color + '20', color: activeFx.color }}>
                {activeFx.emoji} {activeFx.label}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {/* FX button */}
          <button onClick={() => setShowFxPanel(v => !v)}
            className="flex items-center gap-1 px-2 py-1.5 rounded-lg active:scale-90 transition-all"
            style={{
              background: showFxPanel ? preset.color + '30' : activeFx ? activeFx.color + '20' : '#1a1a1a',
              border: `1px solid ${showFxPanel ? preset.color + '60' : activeFx ? activeFx.color + '40' : '#2a2a2a'}`,
            }}>
            <Zap size={11} style={{ color: activeFx ? activeFx.color : '#52525b' }}/>
            <span className="text-[9px] font-black" style={{ color: activeFx ? activeFx.color : '#52525b' }}>
              FX
            </span>
          </button>

          {/* Play */}
          <button onClick={() => onPlay(track)}
            className="w-8 h-8 rounded-xl flex items-center justify-center active:scale-90"
            style={{ background: isPlaying ? preset.color + '30' : '#1a1a1a' }}>
            {isPlaying ? <Pause size={13} style={{ color: preset.color }}/> : <Play size={13} className="text-white"/>}
          </button>

          {/* Solo */}
          <button onClick={() => onSolo(track.trackIndex!)}
            className="w-8 h-8 rounded-xl flex items-center justify-center active:scale-90 font-black text-[10px]"
            style={{
              background: isSolo ? preset.color + '30' : '#1a1a1a',
              border: `1px solid ${isSolo ? preset.color : '#2a2a2a'}`,
              color: isSolo ? preset.color : '#52525b',
            }}>
            S
          </button>

          {/* Mute */}
          <button onClick={() => onMute(track.trackIndex!, !track.muted)}
            className="w-8 h-8 rounded-xl flex items-center justify-center active:scale-90"
            style={{ background: track.muted ? '#1a1a1a' : '#222' }}>
            {track.muted ? <VolumeX size={13} className="text-zinc-600"/> : <Volume2 size={13} className="text-zinc-300"/>}
          </button>

          {/* Delete */}
          <button onClick={() => onDelete(track.trackIndex!)}
            className="w-8 h-8 rounded-xl bg-red-950/60 flex items-center justify-center text-red-700 active:text-red-400 active:scale-90 active:bg-red-900/60 transition-all">
            <Trash2 size={13}/>
          </button>
        </div>
      </div>

      {/* ── Waveform ── */}
      <div className="px-3 pb-2">
        {applyingFx ? (
          <div>
            <div className="flex justify-between mb-1">
              <p className="text-[9px] font-black text-zinc-500 uppercase">Application FX...</p>
              <p className="text-[9px] text-zinc-600">{applyPct}%</p>
            </div>
            <div className="h-2 bg-zinc-900 rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all duration-200"
                style={{ width: `${applyPct}%`, background: preset.color }}/>
            </div>
          </div>
        ) : (
          <WaveformBar dataUrl={track.dataUrl} color={preset.color} height={28} points={80}
            playbackPct={isPlaying ? playPct : undefined} isPlaying={isPlaying} dimmed={track.muted}/>
        )}
      </div>

      {/* ── Faders ── */}
      <div className="px-3 pb-3 space-y-1.5" style={{ borderTop: '1px solid #1a1a1a', paddingTop: 8 }}>
        {/* VOL */}
        <div className="flex items-center gap-2">
          <span className="text-[9px] text-zinc-700 font-black uppercase w-7 shrink-0">VOL</span>
          <input type="range" min="0" max="2" step="0.05" value={gain}
            onChange={e => onVolume(track.trackIndex!, parseFloat(e.target.value))}
            className="flex-1 h-1 rounded-full appearance-none cursor-pointer"
            style={{
              accentColor: isClipping ? '#ef4444' : preset.color,
              background: `linear-gradient(to right, ${isClipping ? '#ef4444' : preset.color} ${(gain/2)*100}%, #1e1e1e ${(gain/2)*100}%)`,
            }}/>
          <div className="flex items-center gap-1 w-12 justify-end">
            {isClipping && <span className="text-[7px] font-black text-red-500 uppercase animate-pulse">CLIP</span>}
            <span className={`text-[9px] font-black ${isClipping ? 'text-red-400' : 'text-zinc-600'}`}>{Math.round(gain*100)}%</span>
          </div>
        </div>
        {/* PAN */}
        <div className="flex items-center gap-2">
          <span className="text-[9px] text-zinc-700 font-black uppercase w-7 shrink-0">PAN</span>
          <div className="flex-1 relative">
            <input type="range" min="-1" max="1" step="0.05" value={pan}
              onChange={e => onPan(track.trackIndex!, parseFloat(e.target.value))}
              className="w-full h-1 rounded-full appearance-none cursor-pointer accent-zinc-400"
              style={{
                background: pan === 0 ? '#1e1e1e'
                  : pan > 0
                  ? `linear-gradient(to right, #1e1e1e 50%, ${preset.color}60 50%, ${preset.color}60 ${50+pan*50}%, #1e1e1e ${50+pan*50}%)`
                  : `linear-gradient(to right, #1e1e1e ${50+pan*50}%, ${preset.color}60 ${50+pan*50}%, ${preset.color}60 50%, #1e1e1e 50%)`,
              }}/>
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-px h-3 bg-zinc-700 pointer-events-none"/>
          </div>
          <span className="text-[9px] text-zinc-600 font-black w-12 text-right">{panLabel}</span>
        </div>
      </div>

      {/* ── Panneau FX ── */}
      {showFxPanel && (
        <div style={{ borderTop: '1px solid #1e1e1e', background: '#0a0a0a' }}>
          <div className="px-3 py-2 flex items-center justify-between">
            <p className="text-[10px] font-black text-white uppercase tracking-widest flex items-center gap-1.5">
              <Zap size={11} style={{ color: preset.color }}/> Presets FX
            </p>
            <p className="text-[9px] text-zinc-600">Appuie pour appliquer</p>
          </div>

          {applyDone && (
            <div className="mx-3 mb-2 flex items-center gap-2 px-3 py-2 rounded-xl bg-emerald-900/30">
              <CheckCircle2 size={13} className="text-emerald-400"/>
              <p className="text-[11px] font-black text-emerald-400">FX appliqué !</p>
            </div>
          )}

          <div className="px-3 pb-3 space-y-1.5 max-h-72 overflow-y-auto" style={{ WebkitOverflowScrolling: 'touch' }}>
            {FX_PRESETS.map(fx => {
              const isActive  = activeFxId === fx.id;
              const isSuggested = fx.id === suggestedFxId && !activeFxId;

              return (
                <div key={fx.id}>
                  <button
                    onClick={() => setShowFxDetail(showFxDetail?.id === fx.id ? null : fx)}
                    disabled={applyingFx}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl active:scale-[0.98] transition-all text-left"
                    style={{
                      background: isActive ? fx.color + '20' : '#141414',
                      border: `1px solid ${isActive ? fx.color + '50' : isSuggested ? fx.color + '30' : '#1e1e1e'}`,
                    }}>
                    <span className="text-base leading-none shrink-0">{fx.emoji}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-[12px] font-black" style={{ color: isActive ? fx.color : '#e4e4e7' }}>{fx.label}</p>
                        {isSuggested && !isActive && (
                          <span className="text-[7px] font-black px-1 py-0.5 rounded" style={{ background: fx.color + '20', color: fx.color }}>
                            Suggéré
                          </span>
                        )}
                        {isActive && <span className="text-[7px] font-black text-emerald-400">✓ Actif</span>}
                      </div>
                      <p className="text-[9px] text-zinc-600 truncate">{fx.description}</p>
                    </div>

                    {/* Apply button */}
                    <button
                      onClick={e => { e.stopPropagation(); handleApplyFx(fx); }}
                      disabled={applyingFx || isActive}
                      className="shrink-0 px-2.5 py-1.5 rounded-lg font-black text-[9px] uppercase active:scale-90 disabled:opacity-40 transition-all"
                      style={{
                        background: isActive ? '#1a1a1a' : fx.color + '25',
                        color: isActive ? '#52525b' : fx.color,
                        border: `1px solid ${isActive ? '#2a2a2a' : fx.color + '40'}`,
                      }}>
                      {isActive ? '✓' : 'Appliquer'}
                    </button>
                  </button>

                  {/* Détail FX expandable */}
                  {showFxDetail?.id === fx.id && (
                    <div className="mx-1 mb-1 px-3 py-2 rounded-xl space-y-2"
                      style={{ background: '#0d0d0d', border: `1px solid ${fx.color}20` }}>
                      <p className="text-[8px] font-black text-zinc-600 uppercase tracking-widest mb-2">Paramètres</p>
                      {[
                        { label: 'Graves', value: `${fx.lowGain > 0 ? '+' : ''}${fx.lowGain} dB` },
                        { label: 'Mids', value: `${fx.midGain > 0 ? '+' : ''}${fx.midGain} dB` },
                        { label: 'Aigus', value: `${fx.highGain > 0 ? '+' : ''}${fx.highGain} dB` },
                        { label: 'Threshold', value: `${fx.compThreshold} dB` },
                        { label: 'Ratio', value: `${fx.compRatio}:1` },
                        { label: 'Attack', value: `${fx.compAttack} ms` },
                        { label: 'Release', value: `${fx.compRelease} ms` },
                        { label: 'Knee', value: `${fx.compKnee} dB` },
                        { label: 'Reverb', value: fx.reverb === 'none' ? 'Sec' : `${fx.reverb} ${Math.round(fx.reverbMix * 100)}%` },
                      ].map(({ label, value }) => (
                        <div key={label} className="flex justify-between">
                          <span className="text-[9px] text-zinc-600 font-black uppercase">{label}</span>
                          <span className="text-[9px] font-black" style={{ color: fx.color }}>{value}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

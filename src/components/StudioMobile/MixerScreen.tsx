/**
 * MixerScreen.tsx — v3 : Mixer visuel complet
 *
 * NOUVEAUTÉS :
 * - Section harmonies refaite : clavier visuel des 5 couches avec relation musicale
 * - Génération individuelle par harmonie (pas juste "tout régénérer")
 * - Waveform sur chaque piste générée
 * - Stack visuel des pistes empilées (vue timeline)
 * - Durée totale du projet dans le header
 * - Waveform du mix final après mixage
 * - Indicateur de niveau par piste dans la vue stack
 */
import React, { useState, useEffect } from 'react';
import {
  ChevronLeft, Plus, Layers, Scissors, Loader2, CheckCircle2,
  Send, Pause, Play, Sparkles, Music2, RefreshCw, BarChart2,
} from 'lucide-react';
import { MobileRecording, TrackProject, Take, studioService } from '../../services/StudioService';
import { Song } from '../../types';
import { TRACK_PRESETS, formatTime, SectionMarker, SectionLabel, SECTION_LABELS, SECTION_COLORS } from './studio.types';
import TrackCard from './TrackCard';
import WaveformBar from './WaveformBar';

interface Props {
  selected:    Song;
  project:     TrackProject;
  playingId:   string | null;
  isMixing:    boolean;
  mixDone:     boolean;
  isOnline:    boolean;
  uploading:   string | null;
  uploadDone:  string | null;
  playRef:     React.RefObject<HTMLAudioElement>;
  onBack:          () => void;
  onGoSongs:       () => void;
  onAddTrack:      () => void;
  onPlay:          (rec: MobileRecording) => void;
  onMute:          (trackIndex: number, muted: boolean) => void;
  onSolo:          (trackIndex: number) => void;
  onVolume:        (trackIndex: number, gain: number) => void;
  onPan:           (trackIndex: number, pan: number) => void;
  onDelete:        (trackIndex: number) => void;
  onMix:           () => void;
  onPlayMix:       () => void;
  onMasterize:     (vocalBlob: Blob, instBlob: Blob | null) => void;
  onUploadMix:     () => void;
  onGoComp:        (takes: Take[]) => void;
  onProjectUpdate: (project: TrackProject) => void;
  instBlob:        Blob | null;
}

// Définition des harmonies avec info musicale
const HARMONY_DEFS = [
  { trackIndex: 1, label: 'Double',    pitch:  0,  color: '#f97316', emoji: '\ud83c\udfb5', musicNote: 'Unisson',   desc: 'Épaissit la voix' },
  { trackIndex: 2, label: '+3',        pitch:  3,  color: '#eab308', emoji: '\ud83c\udfb6', musicNote: 'Tierce m.', desc: 'Harmonie douce' },
  { trackIndex: 3, label: '+7',        pitch:  7,  color: '#22c55e', emoji: '\ud83c\udfbc', musicNote: 'Quinte',    desc: 'Harmonie forte' },
  { trackIndex: 4, label: 'Oct ↓',    pitch: -12, color: '#3b82f6', emoji: '\ud83d\udd09', musicNote: 'Octave -1', desc: 'Voix grave' },
  { trackIndex: 5, label: '+5',        pitch:  5,  color: '#a855f7', emoji: '✨', musicNote: 'Quarte',    desc: 'Harmonie riche' },
];

export default function MixerScreen({
  selected, project, playingId, isMixing, mixDone, isOnline,
  uploading, uploadDone, playRef,
  onBack, onGoSongs, onAddTrack, onPlay, onMute, onSolo, onVolume, onPan,
  onDelete, onMix, onPlayMix, onMasterize, onUploadMix, onGoComp,
  onProjectUpdate, instBlob,
}: Props) {
  const [generatingIndex, setGeneratingIndex] = useState<number | null>(null);
  const [generateLabel, setGenerateLabel]     = useState('');
  const [generatePct, setGeneratePct]         = useState(0);
  const [generatedDone, setGeneratedDone]     = useState<Set<number>>(new Set());
  const [mixWaveform, setMixWaveform]         = useState<number[]>([]);
  const [showStack, setShowStack]             = useState(false);
  const [showSections, setShowSections]       = useState(false);
  const [sections, setSections]               = useState<SectionMarker[]>(
    (project as any).sections || []
  );

  const tracks    = project?.tracks || [];
  const mainVoice = tracks.find(t => t.trackIndex === 0 && !(t as any).isGenerated);
  const totalDuration = mainVoice?.duration || Math.max(...tracks.map(t => t.duration), 0);

  // Charger la waveform du mix dès qu'il est prêt
  useEffect(() => {
    if (mixDone && project.mixedDataUrl && mixWaveform.length === 0) {
      studioService.analyzeWaveform(project.mixedDataUrl, 100)
        .then(setMixWaveform)
        .catch(() => {});
    }
  }, [mixDone, project.mixedDataUrl]);

  // Callback quand un FX est appliqué sur une piste → mettre à jour le projet
  const handleTrackUpdate = (updated: MobileRecording) => {
    const newTracks = project.tracks.map(t =>
      t.trackIndex === updated.trackIndex ? updated : t
    );
    onProjectUpdate({ ...project, tracks: newTracks });
  };

  const handleGoComp = () => {
    const takes: Take[] = tracks.map(t => ({ id: t.id, recording: t, regions: t.regions || [] }));
    onGoComp(takes);
  };

  // Générer une harmonie individuelle
  const generateOne = async (harmonyDef: typeof HARMONY_DEFS[0]) => {
    if (!mainVoice || generatingIndex !== null) return;
    setGeneratingIndex(harmonyDef.trackIndex);
    setGeneratePct(0);
    setGenerateLabel(`${harmonyDef.emoji} ${harmonyDef.label}...`);

    try {
      // Passer un projet "fantôme" qui ne contient que la couche voulue
      // generateLayersFromVoice génère toutes les couches définies dans LAYERS_DEF
      // puis on filtre — mais au moins le FX est appliqué individuellement
      const generated = await studioService.generateLayersFromVoice(
        mainVoice,
        { ...project, tracks: [mainVoice] },
        (label, pct) => {
          setGenerateLabel(label);
          setGeneratePct(Math.round(pct));
        },
      );

      // Récupérer uniquement la couche demandée
      const wanted = generated.find(r => r.trackIndex === harmonyDef.trackIndex);
      if (wanted) {
        const u = studioService.addTrackToProject(project.id, wanted);
        if (u) onProjectUpdate(u);
        setGeneratedDone(prev => new Set([...prev, harmonyDef.trackIndex]));
        setTimeout(() => setGeneratedDone(prev => {
          const s = new Set(prev); s.delete(harmonyDef.trackIndex); return s;
        }), 3000);
      }
    } catch (e: any) {
      alert('Erreur génération : ' + e.message);
    } finally {
      setGeneratingIndex(null);
      setGenerateLabel('');
      setGeneratePct(0);
    }
  };

  // Générer toutes les harmonies
  const generateAll = async () => {
    if (!mainVoice || generatingIndex !== null) return;
    setGeneratingIndex(-1); // -1 = toutes
    setGeneratePct(0);
    try {
      const generated = await studioService.generateLayersFromVoice(
        mainVoice, project,
        (label, pct) => { setGenerateLabel(label); setGeneratePct(Math.round(pct)); },
      );
      if (generated.length > 0) {
        let up = { ...project };
        for (const rec of generated) {
          const u = studioService.addTrackToProject(project.id, rec);
          if (u) up = u;
        }
        onProjectUpdate(up);
      }
    } catch (e: any) {
      alert('Erreur génération : ' + e.message);
    } finally {
      setGeneratingIndex(null);
      setGenerateLabel('');
      setGeneratePct(0);
    }
  };

  const handleMasterize = () => {
    if (!project?.mixedDataUrl) return;
    const vocalBlob = studioService.dataUrlToBlob(project.mixedDataUrl);
    onMasterize(vocalBlob, instBlob);
  };

  const hasAnyHarmony = HARMONY_DEFS.some(h => tracks.some(t => t.trackIndex === h.trackIndex));

  return (
    <div className="min-h-screen bg-[#020202] text-white flex flex-col">

      {/* ── Header ── */}
      <div className="shrink-0 flex items-center gap-3 px-5 pt-6 pb-4 border-b border-zinc-900">
        <button onClick={onBack} className="w-10 h-10 rounded-xl bg-zinc-900 flex items-center justify-center active:scale-90">
          <ChevronLeft size={20}/>
        </button>
        <div className="min-w-0 flex-1">
          <p className="font-bebas text-xl text-white tracking-widest leading-none">MIXER</p>
          <p className="text-[10px] text-zinc-500 font-black uppercase">
            {selected.title}
            {' · '}
            <span className="text-zinc-400">{tracks.length} piste{tracks.length > 1 ? 's' : ''}</span>
            {totalDuration > 0 && (
              <span className="text-zinc-600"> · {formatTime(totalDuration)}</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {tracks.length >= 2 && (
            <button onClick={handleGoComp}
              className="flex items-center gap-1.5 px-3 py-2 bg-red-900/30 border border-red-600/30 rounded-xl text-[11px] font-black text-red-400 active:scale-90">
              <Scissors size={13}/> Comp
            </button>
          )}
          {tracks.length > 0 && (
            <button
              onClick={() => setShowStack(v => !v)}
              className={`w-9 h-9 rounded-xl flex items-center justify-center active:scale-90 transition-all ${
                showStack ? 'bg-blue-600 text-white' : 'bg-zinc-900 text-zinc-500'
              }`}>
              <BarChart2 size={15}/>
            </button>
          )}
          <button onClick={onGoSongs} className="text-[11px] text-zinc-600 font-black uppercase px-3 py-2 active:scale-90">
            Chansons
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pt-4 pb-6 space-y-4" style={{ WebkitOverflowScrolling: 'touch' }}>

        {/* ── Vue Stack Timeline ── */}
        {showStack && tracks.length > 0 && (
          <div className="bg-zinc-950 border border-white/8 rounded-2xl p-4">
            <p className="text-[10px] text-zinc-500 font-black uppercase tracking-widest mb-3">
              Timeline — {tracks.length} piste{tracks.length > 1 ? 's' : ''}
            </p>
            <div className="space-y-2">
              {[...tracks].sort((a, b) => (a.trackIndex ?? 0) - (b.trackIndex ?? 0)).map(track => {
                const preset = TRACK_PRESETS.find(p => p.index === track.trackIndex) || TRACK_PRESETS[0];
                return (
                  <div key={track.id} className="flex items-center gap-2">
                    <div
                      className="w-20 shrink-0 flex items-center gap-1"
                      style={{ opacity: track.muted ? 0.3 : 1 }}>
                      <span className="text-base leading-none">{preset.emoji}</span>
                      <span className="text-[9px] font-black truncate" style={{ color: preset.color }}>
                        {track.trackLabel}
                      </span>
                    </div>
                    <div className="flex-1">
                      <WaveformBar
                        dataUrl={track.dataUrl}
                        color={preset.color}
                        height={22}
                        points={60}
                        playbackPct={playingId === track.id ? undefined : undefined}
                        dimmed={track.muted}
                      />
                    </div>
                    <div className="w-10 shrink-0 text-right">
                      <span className="text-[9px] text-zinc-600 font-black">
                        {Math.round((track.gain ?? 1) * 100)}%
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Ajouter une piste ── */}
        <button onClick={onAddTrack}
          className="w-full py-3 border border-dashed border-zinc-700 rounded-2xl flex items-center justify-center gap-2 text-zinc-600 font-black text-[12px] uppercase active:scale-95 transition-all">
          <Plus size={16}/> Enregistrer une piste
        </button>

        {/* ── Section Harmonies & Layers ── */}
        {mainVoice && (
          <div className="bg-zinc-950 border border-purple-600/20 rounded-2xl overflow-hidden">
            <div className="px-4 pt-4 pb-3">
              <div className="flex items-center gap-2 mb-1">
                <Sparkles size={14} className="text-purple-400"/>
                <p className="text-[12px] font-black text-white">Harmonies & Layers</p>
                <span className="ml-auto text-[9px] text-purple-500 font-black uppercase">
                  {HARMONY_DEFS.filter(h => tracks.some(t => t.trackIndex === h.trackIndex)).length}/{HARMONY_DEFS.length}
                </span>
              </div>
              <p className="text-[10px] text-zinc-500 leading-relaxed mb-4">
                Génère individuellement chaque harmonie ou toutes d'un coup.
              </p>

              {/* ── Tonalité suggérée (depuis métadonnées chanson) ── */}
              {(project as any).suggestedKey && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-xl mb-3"
                  style={{ background: '#a855f720', border: '1px solid #a855f730' }}>
                  <span className="text-base">\ud83c\udfb5</span>
                  <div className="flex-1">
                    <p className="text-[10px] font-black text-purple-300">Tonalité détectée : {(project as any).suggestedKey}</p>
                    <p className="text-[9px] text-zinc-500">Les harmonies sont optimisées pour cette clé</p>
                  </div>
                </div>
              )}

              {/* ── Sections — activer harmonies par section ── */}
              {mainVoice && (
                <div className="mb-4">
                  <button
                    onClick={() => setShowSections(v => !v)}
                    className="w-full flex items-center justify-between px-3 py-2 rounded-xl mb-2 active:scale-[0.98] transition-all"
                    style={{ background: showSections ? '#1e1e2e' : '#0f0f0f', border: '1px solid #2a2a2a' }}>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px]">\ud83d\uddfa</span>
                      <span className="text-[10px] font-black text-zinc-300 uppercase tracking-wider">Harmonies par section</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {sections.length > 0 && (
                        <span className="text-[9px] font-black text-purple-400">{sections.length} section{sections.length > 1 ? 's' : ''}</span>
                      )}
                      <span className="text-zinc-600 text-[10px]">{showSections ? '▲' : '▼'}</span>
                    </div>
                  </button>

                  {showSections && (
                    <div className="space-y-2 px-1">
                      {/* Ajouter une section */}
                      <div className="flex gap-1.5 flex-wrap mb-2">
                        {SECTION_LABELS.filter(l => !sections.find(s => s.label === l)).map(label => (
                          <button
                            key={label}
                            onClick={() => {
                              const lastEnd = sections.length > 0
                                ? Math.max(...sections.map(s => s.endSec))
                                : 0;
                              const dur = totalDuration || 180;
                              const newSec: SectionMarker = {
                                id: `sec_${Date.now()}`,
                                label: label as SectionLabel,
                                startSec: lastEnd,
                                endSec: Math.min(lastEnd + 30, dur),
                                activeHarmonies: [1, 2, 3, 4, 5], // tout actif par défaut
                              };
                              const updated = [...sections, newSec].sort((a, b) => a.startSec - b.startSec);
                              setSections(updated);
                              onProjectUpdate({ ...project, sections: updated } as any);
                            }}
                            className="px-2 py-1 rounded-lg text-[9px] font-black uppercase active:scale-90 transition-all"
                            style={{ background: SECTION_COLORS[label as SectionLabel] + '20', color: SECTION_COLORS[label as SectionLabel], border: `1px solid ${SECTION_COLORS[label as SectionLabel]}40` }}>
                            + {label}
                          </button>
                        ))}
                      </div>

                      {sections.length === 0 && (
                        <p className="text-[9px] text-zinc-600 text-center py-2">Ajoute des sections pour activer les harmonies sélectivement</p>
                      )}

                      {sections.map(sec => (
                        <div key={sec.id} className="rounded-xl overflow-hidden"
                          style={{ background: '#0d0d0d', border: `1px solid ${SECTION_COLORS[sec.label]}30` }}>
                          <div className="flex items-center gap-2 px-3 py-2">
                            <span className="text-[10px] font-black" style={{ color: SECTION_COLORS[sec.label] }}>{sec.label}</span>
                            {/* Temps start/end */}
                            <div className="flex items-center gap-1 flex-1">
                              <input type="number" min="0" max={totalDuration} step="1"
                                value={Math.round(sec.startSec)}
                                onChange={e => {
                                  const updated = sections.map(s => s.id === sec.id ? { ...s, startSec: parseFloat(e.target.value) } : s);
                                  setSections(updated); onProjectUpdate({ ...project, sections: updated } as any);
                                }}
                                className="w-12 text-[9px] font-black text-center rounded-lg px-1 py-0.5 bg-zinc-900 text-zinc-300 border border-zinc-800"/>
                              <span className="text-zinc-700 text-[9px]">→</span>
                              <input type="number" min="0" max={totalDuration} step="1"
                                value={Math.round(sec.endSec)}
                                onChange={e => {
                                  const updated = sections.map(s => s.id === sec.id ? { ...s, endSec: parseFloat(e.target.value) } : s);
                                  setSections(updated); onProjectUpdate({ ...project, sections: updated } as any);
                                }}
                                className="w-12 text-[9px] font-black text-center rounded-lg px-1 py-0.5 bg-zinc-900 text-zinc-300 border border-zinc-800"/>
                              <span className="text-[8px] text-zinc-600">s</span>
                            </div>
                            <button onClick={() => {
                              const updated = sections.filter(s => s.id !== sec.id);
                              setSections(updated); onProjectUpdate({ ...project, sections: updated } as any);
                            }} className="text-zinc-700 active:text-red-500 text-[10px] px-1">✕</button>
                          </div>
                          {/* Harmonies actives pour cette section */}
                          <div className="flex gap-1.5 px-3 pb-2.5 flex-wrap">
                            {HARMONY_DEFS.map(h => {
                              const active = sec.activeHarmonies.includes(h.trackIndex);
                              return (
                                <button key={h.trackIndex}
                                  onClick={() => {
                                    const newActive = active
                                      ? sec.activeHarmonies.filter(i => i !== h.trackIndex)
                                      : [...sec.activeHarmonies, h.trackIndex];
                                    const updated = sections.map(s => s.id === sec.id ? { ...s, activeHarmonies: newActive } : s);
                                    setSections(updated); onProjectUpdate({ ...project, sections: updated } as any);
                                  }}
                                  className="px-2 py-1 rounded-lg text-[8px] font-black uppercase active:scale-90 transition-all"
                                  style={{
                                    background: active ? h.color + '25' : '#1a1a1a',
                                    color: active ? h.color : '#3f3f46',
                                    border: `1px solid ${active ? h.color + '50' : '#2a2a2a'}`,
                                  }}>
                                  {h.label}
                                </button>
                              );
                            })}
                          </div>

                          {/* ── Volumes par harmonie pour cette section ── */}
                          {sec.activeHarmonies.length > 0 && (
                            <div className="px-3 pb-3 space-y-1.5">
                              <span className="text-[7px] font-black text-zinc-700 uppercase tracking-widest">Volume par harmonie</span>
                              {HARMONY_DEFS.filter(h => sec.activeHarmonies.includes(h.trackIndex)).map(h => {
                                const vol = (sec as any).harmonyVolumes?.[h.trackIndex] ?? 0.75;
                                return (
                                  <div key={h.trackIndex} className="flex items-center gap-2">
                                    <span className="text-[8px] font-black w-16 shrink-0" style={{ color: h.color }}>
                                      {h.emoji} {h.label}
                                    </span>
                                    <input
                                      type="range" min="0" max="1" step="0.05"
                                      value={vol}
                                      onChange={e => {
                                        const newVol = parseFloat(e.target.value);
                                        const updated = sections.map(s => s.id === sec.id ? {
                                          ...s,
                                          harmonyVolumes: { ...((s as any).harmonyVolumes ?? {}), [h.trackIndex]: newVol }
                                        } : s);
                                        setSections(updated); onProjectUpdate({ ...project, sections: updated } as any);
                                      }}
                                      className="flex-1 h-1 rounded-full appearance-none cursor-pointer"
                                      style={{ accentColor: h.color }}
                                    />
                                    <span className="text-[7px] font-black tabular-nums w-6 text-right" style={{ color: h.color + 'cc' }}>
                                      {Math.round(vol * 100)}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ── Clavier visuel des harmonies ── */}
              <div className="space-y-2 mb-4">
                {HARMONY_DEFS.map(h => {
                  const hasTrack      = tracks.some(t => t.trackIndex === h.trackIndex);
                  const existingTrack = tracks.find(t => t.trackIndex === h.trackIndex);
                  const isGen         = generatingIndex === h.trackIndex;
                  const isDone        = generatedDone.has(h.trackIndex);
                  const appliedFxId   = (existingTrack as any)?.fxPresetId as string | undefined;

                  return (
                    <div
                      key={h.trackIndex}
                      className={`rounded-xl border overflow-hidden transition-all ${
                        hasTrack
                          ? 'border-opacity-40'
                          : 'border-zinc-800'
                      }`}
                      style={{
                        borderColor: hasTrack ? h.color + '50' : undefined,
                        background: hasTrack ? h.color + '08' : '#0a0a0a',
                      }}>

                      <div className="flex items-center gap-3 px-3 py-2.5">
                        {/* Info harmonie */}
                        <div className="text-xl leading-none w-8 text-center shrink-0">{h.emoji}</div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-[12px] font-black text-white">{h.label}</p>
                            <span
                              className="text-[9px] font-black px-1.5 py-0.5 rounded-full"
                              style={{ background: h.color + '25', color: h.color }}>
                              {h.musicNote}
                            </span>
                            {appliedFxId && (
                              <span className="text-[8px] font-black px-1.5 py-0.5 rounded-full bg-zinc-800 text-zinc-400">
                                ⚡ {appliedFxId.replace('_', ' ')}
                              </span>
                            )}
                            {h.pitch !== 0 && (
                              <span className="text-[9px] text-zinc-600 font-black">
                                {h.pitch > 0 ? `+${h.pitch}` : h.pitch} ST
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-zinc-500">{h.desc}</p>

                          {/* Waveform si générée */}
                          {hasTrack && existingTrack?.dataUrl && (
                            <div className="mt-2">
                              <WaveformBar
                                dataUrl={existingTrack.dataUrl}
                                color={h.color}
                                height={20}
                                points={50}
                                playbackPct={playingId === existingTrack.id ? undefined : undefined}
                              />
                            </div>
                          )}

                          {/* Progression génération */}
                          {isGen && (
                            <div className="mt-2">
                              <div className="flex justify-between mb-1">
                                <p className="text-[9px] font-black" style={{ color: h.color }}>{generateLabel}</p>
                                <p className="text-[9px] text-zinc-600">{generatePct}%</p>
                              </div>
                              <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
                                <div className="h-full rounded-full transition-all duration-200"
                                  style={{ width: `${generatePct}%`, background: h.color }}/>
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Bouton générer / régénérer */}
                        <div className="shrink-0">
                          {isGen ? (
                            <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: h.color + '20' }}>
                              <Loader2 size={14} className="animate-spin" style={{ color: h.color }}/>
                            </div>
                          ) : isDone ? (
                            <div className="w-9 h-9 rounded-xl bg-emerald-900/30 flex items-center justify-center">
                              <CheckCircle2 size={14} className="text-emerald-400"/>
                            </div>
                          ) : hasTrack ? (
                            <button
                              onClick={() => generateOne(h)}
                              disabled={generatingIndex !== null}
                              className="w-9 h-9 rounded-xl flex items-center justify-center active:scale-90 disabled:opacity-30 transition-all"
                              style={{ background: h.color + '20' }}
                              title="Régénérer">
                              <RefreshCw size={13} style={{ color: h.color }}/>
                            </button>
                          ) : (
                            <button
                              onClick={() => generateOne(h)}
                              disabled={generatingIndex !== null}
                              className="w-9 h-9 rounded-xl flex items-center justify-center active:scale-90 disabled:opacity-30 transition-all"
                              style={{ background: h.color + '25' }}
                              title="Générer">
                              <Sparkles size={13} style={{ color: h.color }}/>
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Progression globale */}
              {generatingIndex === -1 && (
                <div className="mb-3">
                  <div className="flex justify-between mb-1">
                    <p className="text-[10px] text-purple-300 font-black">{generateLabel}...</p>
                    <p className="text-[10px] text-zinc-500">{generatePct}%</p>
                  </div>
                  <div className="h-1.5 bg-zinc-900 rounded-full overflow-hidden">
                    <div className="h-full bg-purple-600 rounded-full transition-all"
                      style={{ width: `${generatePct}%` }}/>
                  </div>
                </div>
              )}

              {/* Bouton Tout générer */}
              <button
                onClick={generateAll}
                disabled={generatingIndex !== null}
                className={`w-full py-3 rounded-xl font-black text-[12px] uppercase tracking-widest flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-50 ${
                  hasAnyHarmony ? 'bg-zinc-800 text-zinc-300' : 'bg-purple-700 text-white'
                }`}>
                {generatingIndex === -1
                  ? <><Loader2 size={14} className="animate-spin"/> Génération...</>
                  : hasAnyHarmony
                  ? <><RefreshCw size={14}/> Tout régénérer</>
                  : <><Sparkles size={14}/> Générer toutes les harmonies</>
                }
              </button>
            </div>
          </div>
        )}

        {/* Guide si vide */}
        {!mainVoice && tracks.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 gap-3 opacity-40">
            <Layers size={40} className="text-zinc-700"/>
            <p className="text-[12px] text-zinc-600 font-black uppercase text-center">Enregistre la voix principale</p>
          </div>
        )}

        {/* ── Pistes ── */}
        {tracks.length > 0 && (
          <div className="space-y-2">
            {tracks.filter(t => !(t as any).isGenerated).length > 0 && (
              <p className="text-[9px] text-zinc-700 font-black uppercase tracking-widest px-1">
                \ud83c\udfa4 Pistes enregistrées
              </p>
            )}
            {tracks.filter(t => !(t as any).isGenerated).map(track => (
              <TrackCard key={track.trackIndex} track={track} playingId={playingId}
                allTracks={tracks}
                onPlay={onPlay} onMute={onMute} onSolo={onSolo} onVolume={onVolume} onPan={onPan} onDelete={onDelete}
                onTrackUpdate={handleTrackUpdate}/>
            ))}

            {tracks.filter(t => (t as any).isGenerated).length > 0 && (
              <p className="text-[9px] text-zinc-700 font-black uppercase tracking-widest px-1 pt-2">
                ✨ Harmonies & layers générés
              </p>
            )}
            {tracks.filter(t => (t as any).isGenerated).map(track => (
              <TrackCard key={track.trackIndex} track={track} playingId={playingId}
                allTracks={tracks}
                onPlay={onPlay} onMute={onMute} onSolo={onSolo} onVolume={onVolume} onPan={onPan} onDelete={onDelete}
                onTrackUpdate={handleTrackUpdate}/>
            ))}
          </div>
        )}

        {/* ── Zone Mix + Export ── */}
        {tracks.length > 0 && (
          <div className="space-y-3 pt-2">

            {/* Bouton Mixer */}
            <button onClick={onMix} disabled={isMixing}
              className="w-full py-4 bg-red-600 rounded-2xl font-black text-[14px] uppercase tracking-widest flex items-center justify-center gap-3 active:scale-95 transition-all disabled:opacity-60">
              {isMixing
                ? <><Loader2 size={18} className="animate-spin"/> Mixage...</>
                : mixDone
                ? <><CheckCircle2 size={18}/> Re-mixer</>
                : <><Layers size={18}/> Mixer toutes les pistes</>}
            </button>

            {/* Waveform du mix + actions */}
            {mixDone && project.mixedDataUrl && (
              <div className="bg-zinc-950 border border-white/8 rounded-2xl overflow-hidden">
                {/* Header mix */}
                <div className="px-4 pt-3 pb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Music2 size={13} className="text-red-400"/>
                    <p className="text-[11px] font-black text-white">Mix vocal</p>
                    {totalDuration > 0 && (
                      <span className="text-[10px] text-zinc-500">{formatTime(totalDuration)}</span>
                    )}
                  </div>
                  <button onClick={onPlayMix}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 rounded-xl text-[11px] font-black text-white active:scale-90">
                    {playingId === 'mix' ? <><Pause size={12}/> Pause</> : <><Play size={12}/> Écouter</>}
                  </button>
                </div>

                {/* Waveform mix */}
                <div className="px-4 pb-3">
                  {mixWaveform.length > 0 ? (
                    <WaveformBar
                      waveform={mixWaveform}
                      color="#ef4444"
                      height={48}
                      points={100}
                      playbackPct={playingId === 'mix' ? undefined : undefined}
                      isPlaying={playingId === 'mix'}
                    />
                  ) : (
                    <div className="h-12 bg-zinc-900 rounded-lg animate-pulse"/>
                  )}
                </div>

                {/* Actions */}
                <div className="border-t border-white/5 divide-y divide-white/5">
                  <button onClick={handleMasterize}
                    className="w-full py-3.5 font-black text-[12px] uppercase tracking-widest flex items-center justify-center gap-2 text-purple-400 active:bg-zinc-900 transition-all">
                    \ud83c\udf9b️ Masteriser & Exporter
                    <span className="text-[10px] opacity-60">{instBlob ? '+ instrumental' : 'voix seule'}</span>
                  </button>

                  {isOnline && (
                    <button onClick={onUploadMix} disabled={uploading === 'mix'}
                      className="w-full py-3.5 font-black text-[12px] uppercase tracking-widest flex items-center justify-center gap-2 text-emerald-400 active:bg-zinc-900 transition-all disabled:opacity-60">
                      {uploading === 'mix'
                        ? <><Loader2 size={14} className="animate-spin"/> Transfert...</>
                        : uploadDone === 'mix'
                        ? <><CheckCircle2 size={14}/> Transféré au Mac !</>
                        : <><Send size={14}/> Envoyer au Mac (brut)</>}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <audio ref={playRef} playsInline className="hidden"/>
    </div>
  );
}

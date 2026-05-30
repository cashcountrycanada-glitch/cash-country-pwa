/**
 * studio.types.ts — Types, constantes et utilitaires du Studio Mobile v2
 *
 * NOUVEAUTÉS :
 * - FxPreset : preset d'effets par piste (EQ, compresseur, saturation, reverb)
 * - FX_PRESETS : banque de presets inspirés BandLab
 */
import { ReverbType } from '../../services/StudioService';

export type Screen = 'songs' | 'record' | 'mixer' | 'recordings' | 'comp' | 'master';

export interface TrackPreset {
  index: number;
  label: string;
  pitch: number;
  pan:   number;
  gain:  number;
  color: string;
  emoji: string;
}

// ── Preset d\'effets par piste ────────────────────────────────────────────────
export interface FxPreset {
  id:          string;
  label:       string;
  emoji:       string;
  description: string;
  color:       string;
  // EQ 3 bandes
  lowGain:     number;   // -12..+12 dB  @ 250 Hz
  midGain:     number;   // -12..+12 dB  @ 2500 Hz
  highGain:    number;   // -12..+12 dB  @ 8000 Hz
  // Compresseur
  compThreshold: number; // -40..0 dB
  compRatio:     number; // 1..20
  compAttack:    number; // ms
  compRelease:   number; // ms
  compKnee:      number; // 0..40 dB
  // Saturation douce 0..1
  saturation:  number;
  // Reverb
  reverb:      ReverbType;
  reverbMix:   number;   // 0..1
  // Auto-Tune léger (0 = off, 0.3 = transparent, 0.7 = audible, 1.0 = T-Pain)
  autotune?:   number;
  autotuneSpeed?: 'slow' | 'medium' | 'fast'; // vitesse de correction
}

// Banque de presets FX — inspirés des presets BandLab populaires
export const FX_PRESETS: FxPreset[] = [
  {
    id: 'clean',
    label: 'Clean',
    emoji: '🎙',
    description: 'Signal propre sans traitement',
    color: '#71717a',
    lowGain: 0, midGain: 0, highGain: 0,
    compThreshold: 0, compRatio: 1, compAttack: 10, compRelease: 150, compKnee: 6,
    saturation: 0, reverb: 'none', reverbMix: 0,
  },
  {
    id: 'studio_vocal',
    label: 'Studio Vocal',
    emoji: '🎤',
    description: 'Voix chaude et présente, compression douce',
    color: '#ef4444',
    lowGain: 1.0, midGain: 2.5, highGain: 1.5,
    compThreshold: -18, compRatio: 3, compAttack: 10, compRelease: 150, compKnee: 8,
    saturation: 0.05, reverb: 'room', reverbMix: 0.18,
  },
  {
    id: 'country_warm',
    label: 'Country Warm',
    emoji: '🤠',
    description: 'Son country chaleureux, graves riches',
    color: '#f97316',
    lowGain: 3.0, midGain: -0.5, highGain: 1.0,
    compThreshold: -20, compRatio: 3.5, compAttack: 15, compRelease: 200, compKnee: 10,
    saturation: 0.08, reverb: 'hall', reverbMix: 0.22,
  },
  {
    id: 'punchy',
    label: 'Punchy',
    emoji: '💥',
    description: 'Attaque forte, présence dans le mix',
    color: '#eab308',
    lowGain: 0.5, midGain: 3.5, highGain: 2.0,
    compThreshold: -15, compRatio: 5, compAttack: 3, compRelease: 80, compKnee: 4,
    saturation: 0.12, reverb: 'room', reverbMix: 0.12,
  },
  {
    id: 'airy',
    label: 'Airy & Bright',
    emoji: '✨',
    description: 'Voix légère et aérienne, aigus brillants',
    color: '#22c55e',
    lowGain: -1.0, midGain: 0.5, highGain: 4.0,
    compThreshold: -20, compRatio: 2.5, compAttack: 20, compRelease: 200, compKnee: 12,
    saturation: 0.03, reverb: 'plate', reverbMix: 0.25,
  },
  {
    id: 'harmony',
    label: 'Harmony',
    emoji: '🎶',
    description: 'Idéal pour harmonies et layers vocaux',
    color: '#a855f7',
    lowGain: -2.0, midGain: 1.0, highGain: 2.5,
    compThreshold: -22, compRatio: 4, compAttack: 8, compRelease: 120, compKnee: 8,
    saturation: 0.04, reverb: 'hall', reverbMix: 0.30,
  },
  {
    id: 'double_epic',
    label: 'Double Epic',
    emoji: '🎵',
    description: 'Double tracking épais et large',
    color: '#3b82f6',
    lowGain: 1.5, midGain: -1.0, highGain: 1.5,
    compThreshold: -16, compRatio: 4, compAttack: 5, compRelease: 100, compKnee: 6,
    saturation: 0.10, reverb: 'hall', reverbMix: 0.28,
  },
  {
    id: 'octave_deep',
    label: 'Octave Deep',
    emoji: '🔉',
    description: 'Octave grave profonde et puissante',
    color: '#06b6d4',
    lowGain: 5.0, midGain: -2.0, highGain: -1.0,
    compThreshold: -20, compRatio: 5, compAttack: 10, compRelease: 200, compKnee: 10,
    saturation: 0.15, reverb: 'room', reverbMix: 0.15,
  },
  {
    id: 'digi_comp',
    label: 'Digi Comp',
    emoji: '⚡',
    description: 'Compression agressive style trap/hip-hop',
    color: '#f43f5e',
    lowGain: 2.0, midGain: 1.5, highGain: 3.0,
    compThreshold: -25, compRatio: 6, compAttack: 1, compRelease: 69, compKnee: 6,
    saturation: 0.15, reverb: 'none', reverbMix: 0,
  },
  {
    id: 'velvet',
    label: 'Velvet',
    emoji: '🎼',
    description: 'Son doux et velouté, voix soul/R&B',
    color: '#d946ef',
    lowGain: 2.5, midGain: -0.5, highGain: -1.0,
    compThreshold: -22, compRatio: 3, compAttack: 15, compRelease: 250, compKnee: 15,
    saturation: 0.06, reverb: 'plate', reverbMix: 0.20,
  },
  {
    id: 'autotune_transparent',
    label: 'Auto-Tune Doux',
    emoji: '🎯',
    description: 'Correction transparente — intonation naturelle',
    color: '#10b981',
    lowGain: 0.5, midGain: 1.5, highGain: 1.0,
    compThreshold: -18, compRatio: 2.5, compAttack: 12, compRelease: 160, compKnee: 8,
    saturation: 0.03, reverb: 'room', reverbMix: 0.12,
    autotune: 0.35, autotuneSpeed: 'slow',
  },
  {
    id: 'autotune_country',
    label: 'Country Pitch',
    emoji: '🤠🎯',
    description: 'Auto-Tune country — chaleureux et contrôlé',
    color: '#f59e0b',
    lowGain: 2.5, midGain: 1.0, highGain: 0.5,
    compThreshold: -20, compRatio: 3, compAttack: 15, compRelease: 200, compKnee: 10,
    saturation: 0.07, reverb: 'hall', reverbMix: 0.18,
    autotune: 0.45, autotuneSpeed: 'medium',
  },
];

export const FX_PRESET_DEFAULT = FX_PRESETS[0]; // Clean

export const TRACK_PRESETS: TrackPreset[] = [
  { index: 0, label: 'Voix principale', pitch: 0,   pan: 0,    gain: 1.0,  color: '#ef4444', emoji: '🎤' },
  { index: 1, label: 'Double tracking', pitch: 0,   pan: -0.4, gain: 0.6,  color: '#f97316', emoji: '🎵' },
  { index: 2, label: 'Harmonie +3',     pitch: 3,   pan: 0.5,  gain: 0.5,  color: '#eab308', emoji: '🎶' },
  { index: 3, label: 'Harmonie +7',     pitch: 7,   pan: -0.5, gain: 0.45, color: '#22c55e', emoji: '🎼' },
  { index: 4, label: 'Octave bas',      pitch: -12, pan: 0,    gain: 0.35, color: '#3b82f6', emoji: '🔉' },
  { index: 5, label: 'Harmonie +5',     pitch: 5,   pan: 0.3,  gain: 0.4,  color: '#a855f7', emoji: '✨' },
];

// Presets FX recommandés par type de piste
export const TRACK_FX_SUGGESTIONS: Record<number, string> = {
  0: 'studio_vocal',  // Voix principale → Studio Vocal
  1: 'double_epic',   // Double tracking → Double Epic
  2: 'harmony',       // Harmonie +3 → Harmony
  3: 'harmony',       // Harmonie +7 → Harmony
  4: 'octave_deep',   // Octave bas → Octave Deep
  5: 'harmony',       // Harmonie +5 → Harmony
};

export interface SectionMarker {
  id:         string;
  label:      'Intro' | 'Couplet' | 'Refrain' | 'Pont' | 'Outro';
  startSec:   number;
  endSec:     number;
  // quelles harmonies (trackIndex 1-5) sont actives dans cette section
  activeHarmonies: number[];
  // volume individuel par harmonie dans cette section (0.0 – 1.0), clé = trackIndex
  harmonyVolumes?: Record<number, number>;
}

export const SECTION_LABELS = ['Intro', 'Couplet', 'Refrain', 'Pont', 'Outro'] as const;
export type SectionLabel = typeof SECTION_LABELS[number];

export const SECTION_COLORS: Record<SectionLabel, string> = {
  Intro:   '#3b82f6',
  Couplet: '#22c55e',
  Refrain: '#ef4444',
  Pont:    '#a855f7',
  Outro:   '#f97316',
};

export const REVERB_LABELS: Record<ReverbType, string> = {
  none:  'Sec',
  room:  'Pièce',
  hall:  'Hall',
  plate: 'Plaque',
};

export const REVERB_TYPES: ReverbType[] = ['none', 'room', 'hall', 'plate'];

export function formatTime(s: number): string {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('fr-CA', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

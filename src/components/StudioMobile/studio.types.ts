export interface FxSettings {
  hpf?:          number; // Hz — High-Pass Filter (coupe sous cette fréquence, 0=off)
  lowGain:       number; // -12..+12 dB shelving graves 200Hz
  lowMidGain?:   number; // -12..+12 dB peak 300Hz (coupe boue)
  midGain:       number; // -12..+12 dB peak présence 3kHz
  highGain:      number; // -12..+12 dB shelving aigus 8kHz
  airGain?:      number; // -12..+12 dB peak air 12kHz
  compThreshold: number; // -40..0 dB
  compRatio:     number; // 1..20
  compAttack:    number; // ms
  compRelease:   number; // ms
  compKnee:      number; // dB
  saturation:    number; // 0..1
  reverb:        'none' | 'room' | 'hall' | 'plate';
  reverbMix:     number; // 0..1
  autotune?:     number;
  autotuneSpeed?: 'slow' | 'medium' | 'fast';
}


export type Screen = 'songs' | 'record' | 'mixer' | 'recordings' | 'comp' | 'master';

export interface TrackPreset {
  index: number;
  label: string;
  pitch: number;
  pan:   number;
  gain:  number;
  color: string;
  emoji: string;
  intervalLabel?: string;   // ex: "Tierce majeure", "Quinte juste"
  singingTip?:   string;    // ex: "Chante +3 demi-tons au-dessus de ta mélodie"
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

// Banque de presets FX — calibrés sur voix baryton country (analyse spectrale réelle)
// Voix de référence : 64% énergie 200-500Hz, manque présence 2-5kHz, SR 48kHz
// Références : Luke Combs, Irvin Blais, George Hamel
export const FX_PRESETS: FxPreset[] = [
  {
    id: 'clean',
    label: 'Clean',
    emoji: '🎙',
    description: 'Signal propre sans traitement',
    color: '#71717a',
    hpf: 0, lowGain: 0, lowMidGain: 0, midGain: 0, highGain: 0, airGain: 0,
    compThreshold: 0, compRatio: 1, compAttack: 10, compRelease: 150, compKnee: 6,
    saturation: 0, reverb: 'none', reverbMix: 0,
  },
  {
    // STUDIO VOCAL — preset principal pour voix country baryton
    // Analyse : 64% énergie low-mid → coupe agressive à 300Hz (-4dB)
    // Manque présence → boost fort à 3kHz (+4dB) + air à 12kHz (+2.5dB)
    // HPF 95Hz : coupe boue sans toucher le corps de la voix (~204Hz fondamentale)
    // Compression douce 3:1 : contrôle sans écraser la dynamique naturelle (19dB range)
    // Reverb room très légère 18% : présence studio sans noyade
    id: 'studio_vocal',
    label: 'Studio Vocal',
    emoji: '🎤',
    description: 'Voix presente et claire - son radio country pro',
    color: '#ef4444',
    hpf: 95,
    lowGain: -1.5, lowMidGain: -4.0, midGain: 4.0, highGain: 1.5, airGain: 2.5,
    compThreshold: -18, compRatio: 3, compAttack: 12, compRelease: 180, compKnee: 8,
    saturation: 0.10, reverb: 'room', reverbMix: 0.18,
  },
  {
    // COUNTRY WARM — chaleur Luke Combs / George Hamel
    // Corps grave conservé (HPF bas à 80Hz), low-mid sculpté proprement
    // midGain modéré pour garder la chaleur sans agressivité
    // Saturation 0.18 : chaleur tape analogique, signature country
    // Reverb hall courte 22% : espace naturel de scène
    id: 'country_warm',
    label: 'Country Warm',
    emoji: '🤠',
    description: 'Chaleur country - corps grave et presence Luke Combs',
    color: '#f97316',
    hpf: 80,
    lowGain: 0.5, lowMidGain: -3.5, midGain: 3.0, highGain: 1.0, airGain: 1.5,
    compThreshold: -20, compRatio: 3, compAttack: 18, compRelease: 220, compKnee: 10,
    saturation: 0.18, reverb: 'hall', reverbMix: 0.22,
  },
  {
    // PUNCHY — voix qui coupe dans le mix country full band
    // Attack 4ms : laisse passer les consonnes et l'attaque vocale
    // lowMidGain -5dB : nettoyage agressif de la zone boueuse
    // midGain +5dB : présence maximale 3kHz
    // Reverb minime 12% : voix sèche qui coupe
    id: 'punchy',
    label: 'Punchy',
    emoji: '💥',
    description: 'Voix qui coupe dans le mix - attaque frontale',
    color: '#eab308',
    hpf: 100,
    lowGain: -1.0, lowMidGain: -5.0, midGain: 5.0, highGain: 2.0, airGain: 1.5,
    compThreshold: -15, compRatio: 5, compAttack: 4, compRelease: 80, compKnee: 4,
    saturation: 0.12, reverb: 'room', reverbMix: 0.12,
  },
  {
    // AIRY & BRIGHT — voix légère Irvin Blais style
    // HPF plus haut 110Hz : corps allégé
    // Moins de saturation, plus d'air
    id: 'airy',
    label: 'Airy & Bright',
    emoji: '✨',
    description: 'Voix legere et aerienne - style Irvin Blais',
    color: '#22c55e',
    hpf: 110,
    lowGain: -2.0, lowMidGain: -3.0, midGain: 2.5, highGain: 3.0, airGain: 4.5,
    compThreshold: -20, compRatio: 2.5, compAttack: 20, compRelease: 200, compKnee: 12,
    saturation: 0.06, reverb: 'plate', reverbMix: 0.28,
  },
  {
    // LAYER HARMONY — preset spécifique pour layers de renforcement
    // Style Luke Combs / George Hamel : même voix +1 octave ou ±3-4 semi-tons
    // lowMidGain très coupé : retire la boue de la couche pour ne pas bloquer la voix principale
    // midGain modéré : présence sans rivaliser avec la principale
    // Reverb hall 35% : place la couche légèrement derrière dans l'espace
    // Saturation douce : fond dans le mix sans ressortir
    id: 'harmony',
    label: 'Layer Harmony',
    emoji: '🎶',
    description: 'Layer de renforcement - fusionne derriere la voix principale',
    color: '#a855f7',
    hpf: 120,
    lowGain: -3.0, lowMidGain: -5.0, midGain: 2.0, highGain: 1.5, airGain: 1.0,
    compThreshold: -24, compRatio: 4, compAttack: 8, compRelease: 120, compKnee: 8,
    saturation: 0.07, reverb: 'hall', reverbMix: 0.35,
  },
  {
    // DOUBLE TRACKING — épaississement voix principale
    // Légèrement désaccordé (via saturation harmonique) pour simuler le double tracking
    // lowMidGain coupé pour que les deux couches ne s'accumulent pas dans la boue
    id: 'double_epic',
    label: 'Double Track',
    emoji: '🎵',
    description: 'Double tracking - epaissit la voix principale',
    color: '#3b82f6',
    hpf: 100,
    lowGain: 0, lowMidGain: -3.5, midGain: 2.0, highGain: 1.5, airGain: 1.0,
    compThreshold: -16, compRatio: 3.5, compAttack: 6, compRelease: 120, compKnee: 6,
    saturation: 0.14, reverb: 'room', reverbMix: 0.20,
  },
  {
    // OCTAVE DEEP — couche octave grave (style basse voix de fond country)
    // HPF très bas 55Hz : garde le graves profond
    // lowGain boost fort : renforce le fondamental grave
    // midGain négatif : retire la présence (voix de fond, pas principale)
    id: 'octave_deep',
    label: 'Octave Deep',
    emoji: '🔉',
    description: 'Couche grave de fond - renforce le bas du mix',
    color: '#06b6d4',
    hpf: 55,
    lowGain: 4.5, lowMidGain: -1.0, midGain: -2.0, highGain: -2.0, airGain: 0,
    compThreshold: -20, compRatio: 5, compAttack: 10, compRelease: 200, compKnee: 10,
    saturation: 0.20, reverb: 'room', reverbMix: 0.25,
  },
  {
    // DIGI COMP — compression agressive pour voix très contrôlée en mix dense
    id: 'digi_comp',
    label: 'Digi Comp',
    emoji: '⚡',
    description: 'Compression agressive - voix tres controlee',
    color: '#f43f5e',
    hpf: 100,
    lowGain: 0, lowMidGain: -4.0, midGain: 3.5, highGain: 2.0, airGain: 2.0,
    compThreshold: -25, compRatio: 7, compAttack: 1, compRelease: 60, compKnee: 4,
    saturation: 0.15, reverb: 'none', reverbMix: 0,
  },
  {
    // AUTO-TUNE DOUX — correction transparente, intonation naturelle
    id: 'autotune_transparent',
    label: 'Auto-Tune Doux',
    emoji: '🎯',
    description: 'Correction transparente - intonation naturelle',
    color: '#10b981',
    hpf: 90,
    lowGain: -1.0, lowMidGain: -3.5, midGain: 3.5, highGain: 1.0, airGain: 2.0,
    compThreshold: -18, compRatio: 2.5, compAttack: 12, compRelease: 160, compKnee: 8,
    saturation: 0.08, reverb: 'room', reverbMix: 0.20,
    autotune: 0.35, autotuneSpeed: 'slow',
  },
  {
    // COUNTRY PITCH — auto-tune country chaleureux
    id: 'autotune_country',
    label: 'Country Pitch',
    emoji: '🤠🎯',
    description: 'Auto-Tune country - chaleureux et controle',
    color: '#f59e0b',
    hpf: 85,
    lowGain: 0.5, lowMidGain: -4.0, midGain: 3.5, highGain: 1.0, airGain: 1.5,
    compThreshold: -20, compRatio: 3, compAttack: 15, compRelease: 200, compKnee: 10,
    saturation: 0.14, reverb: 'hall', reverbMix: 0.28,
    autotune: 0.45, autotuneSpeed: 'medium',
  },
];
export const FX_PRESET_DEFAULT = FX_PRESETS[0]; // Clean

export const TRACK_PRESETS: TrackPreset[] = [
  { index: 0, label: 'Voix principale', pitch: 0,   pan: 0,    gain: 1.0,  color: '#ef4444', emoji: '🎤',
    intervalLabel: 'Mélodie principale', singingTip: 'Chante ta mélodie normalement' },
  { index: 1, label: 'Double tracking', pitch: 0,   pan: -0.3, gain: 0.55, color: '#f97316', emoji: '🎵',
    intervalLabel: 'Unisson (doublement)', singingTip: 'Rechante la même mélodie — les légères variations naturelles créent l\'épaisseur' },
  { index: 2, label: 'Layer +3 ST',     pitch: 3,   pan: 0.4,  gain: 0.45, color: '#eab308', emoji: '🎶',
    intervalLabel: 'Tierce mineure ↑', singingTip: 'Chante 3 demi-tons AU-DESSUS — layer de renforcement doux style Luke Combs' },
  { index: 3, label: 'Layer +4 ST',     pitch: 4,   pan: -0.4, gain: 0.40, color: '#22c55e', emoji: '🎼',
    intervalLabel: 'Tierce majeure ↑', singingTip: 'Chante 4 demi-tons AU-DESSUS — layer brillant qui ouvre la voix' },
  { index: 4, label: 'Octave bas',      pitch: -12, pan: 0,    gain: 0.30, color: '#3b82f6', emoji: '🔉',
    intervalLabel: 'Octave ↓', singingTip: 'Chante UNE OCTAVE EN DESSOUS — renfort grave style George Hamel, discret dans le mix' },
  { index: 5, label: 'Layer -3 ST',     pitch: -3,  pan: 0.3,  gain: 0.35, color: '#a855f7', emoji: '✨',
    intervalLabel: 'Tierce mineure ↓', singingTip: 'Chante 3 demi-tons EN DESSOUS — layer chaud et chaleureux qui soutient' },
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

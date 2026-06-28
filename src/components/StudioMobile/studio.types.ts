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
  deverbAmount?: number; // 0..1 — réduction reverb habitacle auto
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

// Banque de presets FX — calibrés voix baryton grave
// Références : Johnny Cash, Elvis Presley, Alan Jackson, Duck Rivera
// Preset principal : Cash & Elvis (mélange des deux signatures)
// Profil vocal : baryton 90-200Hz, grain naturel, dynamique naturelle, enregistrement auto
// Règle : HPF conservateur (garde le grave), lowMid coupé (boîte auto), reverb sèche
export const FX_PRESETS: FxPreset[] = [
  {
    id: 'clean',
    label: 'Clean',
    emoji: '🎙',
    description: 'Signal brut sans traitement',
    color: '#71717a',
    hpf: 0, lowGain: 0, lowMidGain: 0, midGain: 0, highGain: 0, airGain: 0,
    compThreshold: 0, compRatio: 1, compAttack: 10, compRelease: 150, compKnee: 6,
    saturation: 0, reverb: 'none', reverbMix: 0,
  },
  {
    // CASH & ELVIS — mélange des deux signatures
    // Base grave Cash (HPF 62Hz, lowGain fort, saturation tape)
    // Chaleur Elvis (midGain présence, slapback plate doux)
    // C'est le preset principal pour cette voix
    id: 'cash_elvis',
    label: 'Cash & Elvis',
    emoji: '🎸',
    description: 'Melange Cash et Elvis - grave chaud avec grain analogique',
    color: '#7c3aed',
    hpf: 62,
    lowGain: 3.0, lowMidGain: -3.5, midGain: 2.5, highGain: 0.5, airGain: 0.5,
    compThreshold: -22, compRatio: 2.5, compAttack: 28, compRelease: 320, compKnee: 12,
    saturation: 0.28, reverb: 'plate', reverbMix: 0.09, deverbAmount: 0.45,
  },
  {
    // CASH NOIR — Johnny Cash Man in Black
    // HPF très bas 60Hz : garde le grave profond caractéristique Cash
    // lowMidGain -3.5 : nettoie la boîte auto sans tuer le corps
    // midGain +2.5 : clarté vocale sans brillance pop
    // Saturation 0.22 : grain analogique tape Sun Records
    // Compression 4:1 lente : dynamique préservée, naturel
    // Reverb room 6% : salle sèche, pas d'église
    id: 'cash_noir',
    label: 'Cash Noir',
    emoji: '🖤',
    description: 'Voix grave et sombre - grain analogique Johnny Cash',
    color: '#1c1917',
    hpf: 60,
    lowGain: 2.0, lowMidGain: -3.5, midGain: 2.5, highGain: 0.5, airGain: 0.5,
    compThreshold: -22, compRatio: 4, compAttack: 25, compRelease: 300, compKnee: 10,
    saturation: 0.22, reverb: 'room', reverbMix: 0.06, deverbAmount: 0.45,
  },
  {
    // ELVIS SUN — chaleur rockabilly Sun Studio
    // Saturation haute 0.28 : distorsion douce de bande magnétique
    // Compression très douce 2:1 : dynamique Elvis naturelle
    // lowGain +2.5 : corps grave Elvis
    // Reverb plate 10% : slapback léger (signature Sun Records)
    id: 'elvis_sun',
    label: 'Elvis Sun',
    emoji: '👑',
    description: 'Chaleur Sun Studio - grain tape rockabilly',
    color: '#b45309',
    hpf: 65,
    lowGain: 3.0, lowMidGain: -3.0, midGain: 2.5, highGain: 0.5, airGain: 0,
    compThreshold: -24, compRatio: 2, compAttack: 30, compRelease: 350, compKnee: 12,
    saturation: 0.28, reverb: 'plate', reverbMix: 0.10, deverbAmount: 0.35,
  },
  {
    // ALAN JACKSON — country classique années 90, voix claire et grave
    // Moins de grain que Cash, plus de clarté
    // midGain +3 : présence honky-tonk
    // Compression 3:1 propre
    id: 'alan_jackson',
    label: 'Alan Jackson',
    emoji: '🤠',
    description: 'Country classique - clair et grave Alan Jackson',
    color: '#f97316',
    hpf: 75,
    lowGain: 1.5, lowMidGain: -4.0, midGain: 3.0, highGain: 1.5, airGain: 1.0,
    compThreshold: -20, compRatio: 3, compAttack: 15, compRelease: 200, compKnee: 8,
    saturation: 0.14, reverb: 'room', reverbMix: 0.08, deverbAmount: 0.40,
  },
  {
    // STUDIO VOCAL — son radio country pro
    // HPF 85Hz : garde le bas sans excès de boue
    // lowMidGain -4.0 : nettoie la résonance auto
    // midGain +3.5 : présence radio
    // Saturation légère 0.12
    id: 'studio_vocal',
    label: 'Studio Vocal',
    emoji: '🎤',
    description: 'Voix presente et claire - son radio country pro',
    color: '#ef4444',
    hpf: 85,
    lowGain: 0.5, lowMidGain: -4.0, midGain: 3.5, highGain: 1.0, airGain: 1.5,
    compThreshold: -18, compRatio: 3, compAttack: 12, compRelease: 180, compKnee: 8,
    saturation: 0.12, reverb: 'room', reverbMix: 0.07, deverbAmount: 0.40,
  },
  {
    // PUNCHY LIVE — voix qui coupe dans un mix full band
    // Attack 5ms : consonnes et attaque vocale passent
    // lowMidGain -5 : nettoyage max de la boîte
    // midGain +4.5 : présence maximale
    id: 'punchy',
    label: 'Punchy Live',
    emoji: '💥',
    description: 'Voix qui coupe dans le mix - attaque frontale',
    color: '#eab308',
    hpf: 90,
    lowGain: 0, lowMidGain: -5.0, midGain: 4.5, highGain: 1.5, airGain: 1.0,
    compThreshold: -15, compRatio: 5, compAttack: 5, compRelease: 80, compKnee: 4,
    saturation: 0.13, reverb: 'room', reverbMix: 0.05, deverbAmount: 0.35,
  },
  {
    // LAYER HARMONY — couche de renforcement derrière la voix principale
    // Layer harmony Cash/Elvis : grave conservé, saturation tape, fond du mix
    // lowMid très coupé : ne bloque pas la voix principale
    // Saturation 0.18 : grain analogique cohérent avec la voix principale
    // Reverb hall 16% : place la couche derrière sans noyer
    id: 'harmony',
    label: 'Layer Harmony',
    emoji: '🎶',
    description: 'Layer de renforcement - grain Cash/Elvis derriere la voix',
    color: '#a855f7',
    hpf: 80,
    lowGain: 1.0, lowMidGain: -5.0, midGain: 1.0, highGain: 0.0, airGain: 0.0,
    compThreshold: -26, compRatio: 5, compAttack: 10, compRelease: 150, compKnee: 10,
    saturation: 0.18, reverb: 'hall', reverbMix: 0.16,
  },
  {
    // Double Track Cash/Elvis : unisson, grain tape, légèrement plus sombre que la principale
    // Très peu de highs : la couche s'efface dans les médiums graves
    id: 'double_epic',
    label: 'Double Track',
    emoji: '🎵',
    description: 'Double tracking - epaissit la voix, style Cash/Elvis',
    color: '#3b82f6',
    hpf: 70,
    lowGain: 2.0, lowMidGain: -3.0, midGain: 1.5, highGain: 0.0, airGain: 0.0,
    compThreshold: -22, compRatio: 3, compAttack: 20, compRelease: 280, compKnee: 10,
    saturation: 0.22, reverb: 'room', reverbMix: 0.07,
  },
  {
    // OCTAVE DEEP — couche grave de fond, style basse voix country
    id: 'octave_deep',
    label: 'Octave Deep',
    emoji: '🔉',
    description: 'Couche grave de fond - renforce le bas du mix',
    color: '#06b6d4',
    hpf: 50,
    lowGain: 5.0, lowMidGain: -1.5, midGain: -2.5, highGain: -2.0, airGain: 0,
    compThreshold: -20, compRatio: 5, compAttack: 10, compRelease: 200, compKnee: 10,
    saturation: 0.22, reverb: 'room', reverbMix: 0.10,
  },
  {
    // DIGI COMP — compression broadcast, très contrôlé
    id: 'digi_comp',
    label: 'Digi Comp',
    emoji: '⚡',
    description: 'Compression agressive - voix tres controlee broadcast',
    color: '#f43f5e',
    hpf: 95,
    lowGain: 0, lowMidGain: -4.5, midGain: 3.5, highGain: 2.0, airGain: 1.5,
    compThreshold: -25, compRatio: 7, compAttack: 1, compRelease: 60, compKnee: 4,
    saturation: 0.15, reverb: 'none', reverbMix: 0,
  },
  {
    // AUTO-TUNE DOUX — correction transparente
    id: 'autotune_transparent',
    label: 'Correction Douce',
    emoji: '🎯',
    description: 'Correction intonation transparente - naturelle',
    color: '#10b981',
    hpf: 80,
    lowGain: 1.0, lowMidGain: -3.5, midGain: 3.0, highGain: 0.5, airGain: 1.0,
    compThreshold: -20, compRatio: 2.5, compAttack: 15, compRelease: 200, compKnee: 10,
    saturation: 0.10, reverb: 'room', reverbMix: 0.07, deverbAmount: 0.40,
    autotune: 0.30, autotuneSpeed: 'slow',
  },
  {
    // COUNTRY PITCH — auto-tune country, naturel
    id: 'autotune_country',
    label: 'Country Pitch',
    emoji: '🤠🎯',
    description: 'Auto-Tune country - chaleureux et naturel',
    color: '#f59e0b',
    hpf: 75,
    lowGain: 1.5, lowMidGain: -4.0, midGain: 3.0, highGain: 0.5, airGain: 1.0,
    compThreshold: -20, compRatio: 3, compAttack: 15, compRelease: 220, compKnee: 10,
    saturation: 0.16, reverb: 'hall', reverbMix: 0.10, deverbAmount: 0.40,
    autotune: 0.40, autotuneSpeed: 'medium',
  },
];
export const FX_PRESET_DEFAULT = FX_PRESETS[0]; // Clean


export const TRACK_PRESETS: TrackPreset[] = [
  { index: 0, label: 'Voix principale', pitch: 0,   pan: 0,    gain: 1.0,  color: '#ef4444', emoji: '🎤',
    intervalLabel: 'Mélodie principale', singingTip: 'Chante ta mélodie normalement' },
  { index: 1, label: 'Double tracking', pitch: 0,   pan: -0.25, gain: 0.28, color: '#f97316', emoji: '🎵',
    intervalLabel: 'Unisson', singingTip: "Rechante la même mélodie — les légères variations naturelles créent l'épaisseur. Style Cash/Elvis classique." },
  { index: 2, label: 'Layer +5 ST',     pitch: 5,   pan: 0.35,  gain: 0.22, color: '#eab308', emoji: '🎶',
    intervalLabel: 'Quarte juste ↑', singingTip: 'Chante 5 demi-tons AU-DESSUS — quarte parfaite, signature Alan Jackson et country classique' },
  { index: 3, label: 'Octave bas',      pitch: -12, pan: 0,     gain: 0.25, color: '#3b82f6', emoji: '🔉',
    intervalLabel: 'Octave ↓', singingTip: 'Chante UNE OCTAVE EN DESSOUS — grave profond signature Johnny Cash, très discret dans le mix' },
  { index: 4, label: 'Layer +3 ST',     pitch: 3,   pan: 0.30,  gain: 0.18, color: '#a855f7', emoji: '✨',
    intervalLabel: 'Tierce mineure ↑', singingTip: 'Chante 3 demi-tons AU-DESSUS — layer doux de soutien, presque inaudible seul' },
  { index: 5, label: 'Layer -5 ST',     pitch: -5,  pan: -0.30, gain: 0.18, color: '#22c55e', emoji: '🎼',
    intervalLabel: 'Quarte juste ↓', singingTip: 'Chante 5 demi-tons EN DESSOUS — quarte grave, chaleur Elvis dans les refrains' },
];

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

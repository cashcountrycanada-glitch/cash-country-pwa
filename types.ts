
export enum SongType {
  ORIGINAL = 'Original Cash Country',
  COVER = 'Reprise',
  BREAK = 'Pause / Radio DJ'
}

export enum TrackType {
  STUDIO_MASTER = 'Studio Master (Ma Voix)',
  STEM_VOCAL = 'Vocal Stem (Export ZIP)',
  STEM_INSTRUMENTAL = 'Instrumental Stem (Export ZIP)',
  PURE_INSTRUMENTAL = 'Instrumentale Pure (Copie IA)',
  ROBOTIC = 'Voix Robotisée',
  INSTRUMENTAL = 'Instrumental Simple',
  VIDEO_KARAOKE = 'Video Karaoke (MP4)',
  FULL = 'Vocal Full'
}

export type PerformanceMode = 'live' | 'backing' | 'lipsync';

export interface ProgramEntry {
  songId: string;
  performanceMode: PerformanceMode;
  vocalVolume: number;
  instVolume: number;
  gain: number;
  isNormalized: boolean;
  compression: boolean;
}

export interface DesignLayer {
  id: string;
  type: 'text' | 'image' | 'logo' | 'shape';
  content: string;
  x: number;
  y: number;
  fontSize?: number;
  color?: string;
  fontFamily?: string;
  rotation?: number;
  opacity?: number;
  width?: number;
  height?: number;
}

export type SocialFormat = 'POST_FB' | 'COVER_FB' | 'THUMB_YT' | 'STORY' | 'PRINT_A3' | 'SPOTIFY' | 'POSTER_SONG';

export interface DesignTemplate {
  id: string;
  name: string;
  category: 'Affiche' | 'Social' | 'Carte' | 'Merch' | 'Release';
  format: SocialFormat;
  backgroundUrl: string;
  layers: DesignLayer[];
  linkedSongId?: string;
}

export interface BrandAsset {
  id: string;
  name: string;
  type: 'LOGO' | 'PHOTO' | 'SLOGAN' | 'ARTWORK';
  url: string;
  tags: string[];
}

export type DrumStroke = 'K' | 'S' | 'H' | 'F' | '';

export interface PartitionBeat {
  chord?: string;
  syllable?: string;
  drum?: DrumStroke;
  timestamp?: number;
}

export interface PartitionMeasure {
  id: number;
  section?: string;
  timeSignature: string;
  beats: PartitionBeat[];
}

export type DetectionStep = 'PHASE_SKELETON' | 'PHASE_FORGE' | 'PHASE_OPTICS' | 'PHASE_AUDIO' | 'PHASE_RHYTHM' | 'PHASE_VISUALS' | 'PHASE_LYRICS' | 'LOCKED';

export interface DetectionState {
  step: DetectionStep;
  progress: number;
  validatedPhases: DetectionStep[];
  lastSkeleton?: any;
}

export interface QuizQuestion {
  question: string;
  options: string[];
  correctAnswer: number;
}

export interface QuickBooksState {
  isConnected: boolean;
  companyName?: string;
  lastSync?: number;
  accessToken?: string;
}

export interface GateTransaction {
  id: string;
  timestamp: number;
  amount: number;
  method: 'CASH' | 'GOOGLE_PAY' | 'APPLE_PAY';
  ticketType: string;
}

export interface LiveState {
  currentSongId: string | null;
  activePlaylistId: string | null;
  currentTrackType: TrackType;
  isPlaying: boolean;
  isPauseMode: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  vocalVolume: number;
  isNormalized: boolean;
  mode: 'stage' | 'idle' | 'karaoke';
  activeQuiz: QuizQuestion[] | null;
  showGuitarVisuals: boolean;
  contributionPool?: number;
  sharingEntryPrice?: number;
  quickbooks?: QuickBooksState;
  gateAttendance?: number;
  gateRevenue?: number;
}

export interface SongVersion {
  id: string;
  name: string;
  url: string;
  type: 'audio' | 'video';
  trackType: TrackType;
  fileName?: string;
}

export interface Song {
  id: string;
  title: string;
  artist: string;
  type: SongType;
  danceType: string;
  style?: string;
  compatibleDances: string[];
  tempo: number;
  key: string;
  lyricsWithChords: string;
  versions: SongVersion[];
  posterUrl?: string;
  rating: number;
  playCount: number;
  lastPlayed?: number;
  detectionState?: DetectionState;
  artistBio?: string;
  realPartition?: PartitionMeasure[];
  danceSteps?: string;
  pureInstrumentalAnchor?: number;
  opticTimestamps?: number[];  // Timestamps détectés par Phase 3 PixelSnatcher, assignés aux syllabes en Phase 6
  lrcData?: Array<{time: number; text: string}>;   // Timestamps précis ligne par ligne (source primaire)
  lrcDense?: Array<{time: number; text: string}>;  // Grille dense Option B+ : 1 entrée/seconde exacte (Gemini secondaire)
  lufs?: number;           // Niveau sonore mesuré par ffmpeg (LUFS intégré) — calculé automatiquement à l'import
  volumeOffset?: number;  // Ajustement manuel en dB (-12 à +12) — appliqué en spectacle pour égaliser les chansons
  artistPhoto?: string;   // URL photo de l'artiste — utilisée comme poster par défaut
  useArtistPhoto?: boolean; // Si true, les SongGrids affichent la photo artiste plutôt que posterUrl
  songDescription?: string; // Présentation narrative générée par Gemini (basée sur LRC + métadonnées), mise en cache
  danceScores?: Record<string, { score: number; reason: string }>; // Scores et raisons Phase 5 Visuals
}

export interface Playlist {
  id: string;
  name: string;
  eventType: string;
  songIds: string[];
  entries: ProgramEntry[];
  createdAt: number;
}

export enum VenueCategory {
  THEATRE = 'Théâtre',
  CHURCH = 'Église',
  RESTAURANT = 'Restaurant / Bar',
  FESTIVAL = 'Festival / Extérieur',
  OTHER = 'Autre'
}

export interface Venue {
  id: string;
  name: string;
  category: VenueCategory;
  region: string;
  address: string;
  city: string;
  postalCode: string;
  capacity: number;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  status: 'prospect' | 'negotiation' | 'confirmed';
  notes?: string;
  techSpecs: {
    hasPa: boolean;
    hasLights: boolean;
    powerAmps: string;
    hasPiano: boolean;
  };
  qbCustomerId?: string;
  qbSynced?: boolean;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  price: number;
  currency: string;
  stockQty: number;
  description: string;
  imageUrl: string;
  type: string;
}

export interface Transaction {
  id: string;
  itemName: string;
  price: string;
  timestamp: number;
  status: string;
  customer?: {
    name: string;
    email: string;
  };
  paymentProvider?: string;
  metadata?: any;
}

export interface Seat {
  id: string;
  row: string;
  number: string;
  status: 'available' | 'reserved' | 'sold';
  tierId: string;
}

export interface VenueSection {
  id: string;
  name: string;
  tierId: string;
  rows: number;
  cols: number;
  type: 'grid' | 'tables';
}

export interface SeatingPlan {
  id: string;
  sections: VenueSection[];
  reservedSeats: string[];
}

export interface TicketTier {
  id: string;
  name: string;
  price: string;
  description: string;
  includesDinner: boolean;
  isSeated: boolean;
  stock: number;
}

export interface EventInfo {
  id: string;
  title: string;
  venue: string;
  city: string;
  date: string;
  time: string;
  status: string;
  tiers: TicketTier[];
  seatingPlan?: SeatingPlan;
}

export interface StageElement {
  id: string;
  type: 'mic' | 'monitor' | 'power' | 'person';
  label: string;
  x: number;
  y: number;
  icon: string;
}

export interface TechnicalRider {
  id: string;
  songId: string;
  inputs: any[];
}

export interface GigBooking {
  id: string;
  clientName: string;
  venue: string;
  date: string;
  duration: number;
  eventType: string;
  fee: number;
  status: string;
  travelDistance: number;
  notes?: string;
  metadata?: any;
}

export interface EmailMessage {
  id: string;
  from: string;
  fromName: string;
  subject: string;
  snippet: string;
  body: string;
  date: number;
  unread: boolean;
  category: string;
  linkedVenueId?: string;
}

export interface SongSuggestion {
  title: string;
  artist: string;
  style: string;
  reason: string;
}

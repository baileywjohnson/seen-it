// Shared protocol + domain types for Seen It!.
// Imported by both the server (tsx / tsc) and the client (Vite).

export type ClueType =
  | "location" // shooting location or story setting (map zoom)
  | "year" // release year (timeline zoom)
  | "vitals" // genre, runtime, country: plain facts, revealed one per beat
  | "scene" // a memorable-but-not-obvious moment, drawn stroke by stroke
  | "sceneIconic" // THE iconic image, drawn stroke by stroke
  | "posterSketch" // the poster's composition redrawn without any text
  | "propSketch" // one iconic object or costume piece, drawn alone
  | "piano" // main theme on a synth piano
  | "cast" // performers, least famous first
  | "characters" // character names, side characters first
  | "director" // other films by the director
  | "emoji" // plot in emoji
  | "titleEmoji" // the title itself as an emoji rebus
  | "quote" // famous line, un-redacted word by word
  | "tagline" // the poster tagline, un-redacted word by word
  | "plot" // five sentences, abstract to explicit
  | "anagram" // title letters scrambled, settling into place
  | "blanks"; // title as blanks, letters filling in

export const ALL_CLUE_TYPES: ClueType[] = [
  "location", "year", "vitals", "scene", "sceneIconic", "posterSketch", "propSketch", "piano", "cast", "characters",
  "director", "emoji", "titleEmoji", "quote", "tagline", "plot", "anagram", "blanks",
];

export const CLUE_LABELS: Record<ClueType, string> = {
  location: "On Location",
  year: "Release Date",
  vitals: "Vital Statistics",
  scene: "Draw That Scene",
  sceneIconic: "Iconic Moment",
  posterSketch: "Poster Sketch",
  propSketch: "Prop Department",
  piano: "Name That Tune",
  cast: "Casting Call",
  characters: "Who's Who",
  director: "From the Director Of",
  emoji: "Plot in Emoji",
  titleEmoji: "Title in Emoji",
  quote: "Famous Line",
  tagline: "The Tagline",
  plot: "Plot, Slowly",
  anagram: "Anagram",
  blanks: "Fill in the Blanks",
};

/** Label shown on the marquee; the location clue changes wording by what the map is pointing at. */
export function clueLabel(clueType: ClueType, payload: CluePayload): string {
  if (payload.type === "location" && payload.kind === "set") return "The Setting";
  return CLUE_LABELS[clueType];
}

export type Difficulty = "easy" | "normal" | "hard";

export interface SceneStroke {
  d: string; // SVG path data in a 400x300 viewBox
  stroke: string;
  strokeWidth: number;
  fill: string; // "none" or a colour
}

export interface PianoNote {
  note: string; // e.g. "C4", "F#4", "Bb3" or "R" for rest
  beats: number;
}

export type CluePayload =
  | { type: "location"; kind: "filmed" | "set"; lat: number; lng: number; city: string; region: string; country: string }
  | { type: "year"; year: number }
  | { type: "drawing"; strokes: SceneStroke[] }
  | { type: "piano"; tempo: number; notes: PianoNote[] }
  | { type: "list"; heading: string; items: string[] }
  | { type: "emoji"; emojis: string[] }
  | { type: "quote"; text: string; order: number[] }
  | { type: "plot"; sentences: string[] }
  | { type: "vitals"; facts: { label: string; value: string }[] }
  | { type: "anagram"; words: string[]; solution: string[]; order: number[] }
  | { type: "blanks"; title: string; order: number[] };

export interface RoomSettings {
  rounds: number; // number of movies
  cluesPerMovie: number; // 3..8
  clueSeconds: number; // duration of a single clue (default 15)
  revealSeconds: number; // reveal screen duration
  difficulty: Difficulty; // how revealing the early clues are allowed to be
}

export const DEFAULT_SETTINGS: RoomSettings = {
  rounds: 6,
  cluesPerMovie: 5,
  clueSeconds: 15,
  revealSeconds: 8,
  difficulty: "normal",
};

export const SETTINGS_LIMITS = {
  rounds: { min: 1, max: 20 },
  cluesPerMovie: { min: 3, max: 8 },
  clueSeconds: { min: 9, max: 30 },
  revealSeconds: { min: 4, max: 20 },
} as const;

export type SyncStatus = "none" | "syncing" | "ready" | "error";

export interface PublicPlayer {
  id: string;
  name: string;
  filmCount: number;
  syncStatus: SyncStatus;
  syncMessage: string;
  score: number;
  connected: boolean;
  isHost: boolean;
  guessedThisRound: boolean;
  roundPoints: number;
}

export type Phase = "lobby" | "loading" | "clue" | "reveal" | "gameover";

export interface CluePhaseInfo {
  roundIndex: number;
  rounds: number;
  clueIndex: number;
  clueTotal: number;
  clueType: ClueType;
  payload: CluePayload;
  startsAt: number; // server epoch ms
  endsAt: number; // server epoch ms (end of this clue)
  roundEndsAt: number; // server epoch ms (end of the final clue)
}

export interface RevealInfo {
  roundIndex: number;
  rounds: number;
  title: string;
  year: number;
  director: string;
  posterUrl: string | null;
  letterboxdUrl: string | null;
  endsAt: number;
  results: { playerId: string; points: number; seconds: number | null }[];
}

export interface LoadingInfo {
  message: string;
  progress: number; // 0..1
}

export interface RoomState {
  code: string;
  hostId: string;
  settings: RoomSettings;
  players: PublicPlayer[];
  phase: Phase;
  poolCount: number; // movies every player has watched
  clue: CluePhaseInfo | null;
  reveal: RevealInfo | null;
  loading: LoadingInfo | null;
  serverTime: number;
}

export type ChatKind = "guess" | "chat" | "system" | "correct" | "close" | "error";

export interface ChatMessage {
  id: string;
  kind: ChatKind;
  from: string | null;
  text: string;
  at: number;
}

export interface CsvFilm {
  name: string;
  year: number | null;
  uri: string | null;
}

// ---- Client -> Server ----
export type ClientMessage =
  | { t: "join"; code: string | null; name: string; token: string }
  | { t: "setCsv"; films: CsvFilm[] }
  | { t: "settings"; settings: Partial<RoomSettings> }
  | { t: "start" }
  | { t: "guess"; text: string }
  | { t: "playAgain" }
  | { t: "leave" }
  | { t: "ping" };

// ---- Server -> Client ----
export type ServerMessage =
  | { t: "welcome"; playerId: string; token: string; code: string }
  | { t: "room"; room: RoomState }
  | { t: "chat"; msg: ChatMessage }
  | { t: "guessResult"; correct: boolean; close: boolean; points: number }
  | { t: "error"; message: string }
  | { t: "kicked"; reason: string }
  | { t: "pong"; serverTime: number };

// ---- Helpers shared by both sides ----

export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[’'"`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Deterministic 32-bit hash used for seeded client-side shuffles. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

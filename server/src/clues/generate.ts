import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { FilmDetails } from "../letterboxd.js";
import { CACHE_DIR, readJsonCache, writeJsonCache } from "../paths.js";

// ---------- Schema for the per-movie "clue pack" Claude produces ----------

import type { PianoNote, SceneStroke } from "../../../shared/src/index.js";
import { decodeElements, ELEMENT_FORMAT, renderPng } from "./drawing.js";

// Strokes and notes are encoded as compact strings: the API compiles the output schema into a
// grammar, and three drawings' worth of nested objects blew past its size limit.
const NOTE_FORMAT = "One note per string as 'pitch:beats', e.g. 'C4:0.5', 'F#4:1', 'Bb3:0.25', or 'R:1' for a rest.";

const scored = {
  revealScore: z.number().describe("1-10: how much this clue gives the film away (1 = almost nothing, 10 = practically says the title)"),
  fit: z.number().describe("1-10: whether this clue genuinely points at THIS film. Below 5 means it will be dropped from the game."),
};

/** One drawing per call. The plan comes first so the shapes are laid out deliberately. */
const DrawingSchema = z.object({
  plan: z.string().describe("Composition plan in 2-4 sentences: what is where on the 400x300 canvas (with rough coordinates), what the focal point is, and the 4-7 colour palette."),
  description: z.string().describe("One sentence describing what you drew"),
  elements: z.array(z.string()).describe(`20-45 shapes, drawn in order: sky/ground/walls first, big shapes next, details last. ${ELEMENT_FORMAT}`),
  ...scored,
});
type RawDrawing = z.infer<typeof DrawingSchema>;

/** Everything except the drawings: one call. */
export const TextPackSchema = z.object({
  director: z.string().describe("The film's director (first-billed if several)"),
  altTitles: z
    .array(z.string())
    .describe(
      "Other answers that should count as correct: common short forms, nicknames, the original-language title, the title without a subtitle when it is NOT ambiguous with other films.",
    ),
  location: z.object({
    kind: z.enum(["filmed", "set"]).describe("'filmed' = principal photography location; 'set' = where the story takes place (use for animation, studio-bound films, or when the setting is far more telling)"),
    city: z.string().describe("Real city/town"),
    region: z.string().describe("State / province / region"),
    country: z.string(),
    lat: z.number(),
    lng: z.number(),
    ...scored,
  }),
  yearRevealScore: z.number().describe("1-10: how much the release year gives the film away"),
  piano: z.object({
    songTitle: z.string().describe("Name of the theme or song you transcribed"),
    tempo: z.number().describe("Beats per minute, 60-170"),
    notes: z.array(z.string()).describe(`16-48 notes of the most recognisable phrase, melody only. ${NOTE_FORMAT}`),
    ...scored,
  }),
  cast: z.object({
    names: z.array(z.string()).describe("Exactly 5 real cast members, ordered least famous -> most famous"),
    ...scored,
  }),
  characters: z.object({
    names: z.array(z.string()).describe("Exactly 5 character names, ordered side characters -> lead. Never a name that is also the title."),
    ...scored,
  }),
  directorFilms: z.object({
    films: z.array(z.string()).describe("Up to 5 OTHER films by this director, ordered least known -> best known. Empty if the director has no other notable films."),
    ...scored,
  }),
  emoji: z.object({
    emojis: z.array(z.string()).describe("5-8 single emoji, in plot order"),
    ...scored,
  }),
  quote: z.object({
    text: z.string().describe("The film's most famous line of dialogue, max 20 words, must not contain the title"),
    ...scored,
  }),
  tagline: z.object({
    text: z.string().describe("The film's actual poster tagline, verbatim, must not contain the title. Empty string if it has none worth using."),
    ...scored,
  }),
  titleEmoji: z.object({
    emojis: z.array(z.string()).describe("2-6 emoji that spell out or pun on the TITLE itself (a rebus), e.g. a bee and a film camera for a movie about bees. Not the plot."),
    ...scored,
  }),
  plot: z.object({
    sentences: z
      .array(z.string())
      .describe(
        "Exactly 5 sentences describing the plot, each more specific than the last: #1 could describe a hundred films, #5 leaves little doubt but still never names the title, characters, or actors.",
      ),
    ...scored,
  }),
});

type TextPack = z.infer<typeof TextPackSchema>;

export interface Drawing {
  description: string;
  strokes: SceneStroke[];
  revealScore: number;
  fit: number;
}

/** The decoded, validated clue pack the game works with (and caches). */
export type CluePack = Omit<TextPack, "piano"> & {
  scene: Drawing;
  sceneIconic: Drawing;
  posterSketch: Drawing;
  propSketch: Drawing;
  piano: Omit<TextPack["piano"], "notes"> & { notes: PianoNote[] };
};

// ---------- Claude client ----------

const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5";
const EFFORT = (process.env.CLAUDE_EFFORT ?? "medium") as "low" | "medium" | "high" | "xhigh" | "max";
/** Fast mode streams output ~2.5x faster at a higher per-token price. On by default; CLAUDE_FAST=0 disables. */
let fastAvailable = process.env.CLAUDE_FAST !== "0"; // flips off after the API says fast mode isn't on this account
/** Claude looks at a render of each drawing and fixes it (roughly doubles drawing cost). CLAUDE_DRAW_REVIEW=0 disables. */
const DRAW_REVIEW = process.env.CLAUDE_DRAW_REVIEW !== "0";
const MAX_CONCURRENT = Number(process.env.CLAUDE_CONCURRENCY ?? 3);
const PACK_VERSION = 5;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    // Reads ANTHROPIC_API_KEY (or an `ant auth login` profile). Organization-level keys must also
    // name a workspace, so ANTHROPIC_WORKSPACE_ID is sent as the anthropic-workspace-id header.
    const workspace = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
    client = new Anthropic({
      defaultHeaders: workspace ? { "anthropic-workspace-id": workspace } : undefined,
      maxRetries: 3, // the SDK backs off on 429/529 itself; we add a longer, gentler outer loop below
    });
  }
  return client;
}

/** Turn SDK errors into something a host can act on from the lobby chat. */
function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    const msg = err.message ?? "";
    if (/workspace/i.test(msg)) return "Your Claude API key needs a workspace: add ANTHROPIC_WORKSPACE_ID=wrkspc_... to .env (Console → Settings → Workspaces).";
    if (err.status === 401) return "Claude rejected the API key (401). Check ANTHROPIC_API_KEY in .env.";
    if (err.status === 429) return `Claude kept rate-limiting us for several minutes (${msg.replace(/^\d+\s*/, "").slice(0, 160)}). Lower CLAUDE_CONCURRENCY or check your tier's limits in the Console.`;
    if (err.status === 529) return "Claude is overloaded right now (529). Try rolling film again in a minute.";
    if (err.status === 400) return `Claude rejected the request (400): ${msg.slice(0, 200)}`;
    return `Claude API error ${err.status ?? ""}: ${msg.slice(0, 200)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

const PREAMBLE = `You write clue packs for "Seen It!", a party game where friends guess a movie from progressively more revealing clues. Every player has seen the film, so lean on what is genuinely memorable about it.

Two scores on every clue:
- revealScore (1-10) is how much the clue gives away, relative to THIS film: 1 tells you almost nothing, 10 practically says the title. Use the whole range honestly. For most films the release year is a 2-4, an obscure filming town is a 1-3, a world-famous theme is an 8-10.
- fit (1-10) is whether the clue genuinely points at THIS film at all. Be blunt; a low fit removes the clue from the game, which is far better than wasting 15 seconds of the players' time.

Never include the film's title, or an obvious fragment of it, in any clue.`;

const TEXT_PROMPT = `${PREAMBLE}

Fit guidance: a film with no memorable music gets piano fit 1-2. A live-action film shot on soundstages, or an animated film, gets location fit 1 for "filmed", so switch kind to "set" and rate the setting instead; a fictional setting that maps to no real place gets fit 1. No widely quoted line: quote fit 1-3. A director with no other notable films: directorFilms fit 1. Plot and characters almost always fit.

Quality bar: every clue should give a player who has seen the film a real "oh!" moment. Prefer the famous over the obscure, the concrete over the vague.
- Characters: use the names as spoken in the film, full names where they are known (e.g. "Marion McPherson", not "the mother").
- Plot in emoji: each emoji should stand for one concrete thing that happens or appears in the film, in order; no abstract symbols like arrows or hearts unless they are literally central.
- Quote: the single most quoted line; if the film has several, pick the one people say to each other.
- Tagline: only the real poster tagline; leave it empty and give fit 1 if there isn't a memorable one.
- Title in emoji: a rebus for the words of the title, playful but solvable, revealScore usually 7-9.

Rules:
- The piano clue is a melody only, written so a simple synth can play it: the most recognisable phrase of the main theme or signature song, roughly 15-25 seconds, between C3 and C6, each note a string like "G4:0.5".
- Location: accurate coordinates for a real city. kind "filmed" is where principal photography happened; kind "set" is where the story takes place. Pick whichever is more telling.
- Cast: exactly five real performers, least famous to most famous. If no billed cast is provided, use your own knowledge.
- Characters: five character names, side characters first, protagonist last; skip any name that appears in the title.
- Plot, slowly: five sentences that each narrow the field, from "could be a hundred films" to "unmistakable", without ever naming the title, characters, or actors. Sentences 3-5 must mention concrete, unique specifics (an object, a place, a twist, a set piece) rather than themes.
- altTitles: only include forms that unambiguously mean this film (e.g. "Empire Strikes Back" is fine; "Star Wars" alone is not).`;

const DRAW_STYLE = `You are drawing a single cartoon picture for the game, as flat shapes on a 400x300 canvas. Think of a bold children's-book illustration or a good Pictionary drawing: a few large, clearly readable shapes, not many small ones.

How to draw well with shapes:
- Write the plan first. Decide the horizon line, where the focal subject sits (usually centre or rule-of-thirds), and the 4-7 flat colours. Then list elements in painting order: background fills (sky, ground, wall) covering the whole canvas, then large mid-ground shapes, then the subject, then a few details.
- Build people and creatures from primitives: circle or ellipse head, rounded rect or polygon body, thick lines for limbs (width 8-14) with small circles for hands/feet, ellipses for hair or hats. Faces are two dots and one curved path for the mouth. Keep proportions consistent and all parts touching.
- Every closed shape gets a fill and the same dark outline colour (#2b1a2e) at width 3-6. Use overlap for depth. Avoid tiny elements smaller than ~12 px and avoid stray unattached shapes.
- Absolutely no letters, numbers, logos or text of any kind.

${ELEMENT_FORMAT}`;

const DRAW_BRIEFS = {
  scene: 'Draw a quieter moment from the film that fans would still recognise, not the single most famous image. Aim for revealScore 4-6.',
  sceneIconic: 'Draw THE defining image of the film: the shot people picture when they hear the title. Aim for revealScore 7-9.',
  posterSketch: "Redraw the film's theatrical poster: its layout, colour palette and central figures, with every word, title and credit removed.",
  propSketch: "Draw ONE iconic object, vehicle, costume piece or creature from the film, large and centred on a plain background, like a museum exhibit. Aim for revealScore 5-8.",
} as const;

const REVIEW_PROMPT = `${PREAMBLE}

${DRAW_STYLE}

You are reviewing a render of your own drawing. Look at the image critically: does it read at a glance as the intended subject? Check for floating or disconnected parts, wrong proportions, shapes hiding the focal point, empty or cluttered areas, or anything that looks like text. Then return the complete improved drawing (the full element list, not a diff), keeping what works. You may also correct revealScore and fit now that you can see the result.`;

function describeFilm(f: FilmDetails): string {
  const lines = [
    `Title: ${f.title}`,
    `Year: ${f.year ?? "unknown"}`,
    f.directors.length ? `Director(s): ${f.directors.join(", ")}` : "",
    f.cast.length ? `Billed cast: ${f.cast.join(", ")}` : "",
    f.genres.length ? `Genres: ${f.genres.join(", ")}` : "",
    f.countries.length ? `Countries: ${f.countries.join(", ")}` : "",
    f.runtimeMinutes ? `Runtime: ${f.runtimeMinutes} min` : "",
    f.description ? `Synopsis: ${f.description}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));

function decodeNote(raw: string): PianoNote | null {
  const m = /^(R|[A-Ga-g][#b]?\d)\s*:\s*([\d.]+)$/.exec(raw.trim());
  if (!m) return null;
  return { note: m[1], beats: clamp(Number(m[2]), 0.125, 8) };
}

function sanitize(pack: TextPack & { scene: Drawing; sceneIconic: Drawing; posterSketch: Drawing; propSketch: Drawing }): CluePack {
  const sc = (x: { revealScore: number; fit: number }) => ({ revealScore: clamp(x.revealScore, 1, 10), fit: clamp(x.fit, 1, 10) });
  return {
    ...pack,
    director: pack.director.trim(),
    altTitles: pack.altTitles.map((s) => s.trim()).filter(Boolean).slice(0, 12),
    location: {
      ...pack.location,
      lat: clamp(pack.location.lat, -85, 85),
      lng: clamp(pack.location.lng, -180, 180),
      ...sc(pack.location),
    },
    yearRevealScore: clamp(pack.yearRevealScore, 1, 10),
    scene: pack.scene,
    sceneIconic: pack.sceneIconic,
    posterSketch: pack.posterSketch,
    propSketch: pack.propSketch,
    piano: {
      ...pack.piano,
      tempo: clamp(pack.piano.tempo, 40, 220),
      notes: pack.piano.notes.map(decodeNote).filter((x): x is PianoNote => !!x).slice(0, 120),
      ...sc(pack.piano),
    },
    cast: { names: pack.cast.names.map((s) => s.trim()).filter(Boolean).slice(0, 5), ...sc(pack.cast) },
    characters: { names: pack.characters.names.map((s) => s.trim()).filter(Boolean).slice(0, 5), ...sc(pack.characters) },
    directorFilms: { films: pack.directorFilms.films.map((s) => s.trim()).filter(Boolean).slice(0, 5), ...sc(pack.directorFilms) },
    emoji: { emojis: pack.emoji.emojis.filter(Boolean).slice(0, 10), ...sc(pack.emoji) },
    quote: { text: pack.quote.text.trim(), ...sc(pack.quote) },
    tagline: { text: pack.tagline.text.trim(), ...sc(pack.tagline) },
    titleEmoji: { emojis: pack.titleEmoji.emojis.filter(Boolean).slice(0, 8), ...sc(pack.titleEmoji) },
    plot: { sentences: pack.plot.sentences.map((s) => s.trim()).filter(Boolean).slice(0, 5), ...sc(pack.plot) },
  };
}

export class ClueGenerationError extends Error {}

/** Deterministic stand-in pack for local development without an API key (MOCK_CLUES=1). */
function mockPack(film: FilmDetails): CluePack {
  const cast = film.cast.length ? film.cast.slice(0, 5).reverse() : ["Extra One", "Extra Two", "Supporting Player", "Second Lead", "The Star"];
  while (cast.length < 5) cast.push(`Cast Member ${cast.length + 1}`);
  const drawing = (tint: string, reveal: number) => ({
    description: "A mock sketch: a projector beam lighting a screen",
    strokes: [
      { d: "M 0 220 L 400 220 L 400 300 L 0 300 Z", stroke: "#2b1a2e", strokeWidth: 4, fill: "#d8ecb3" },
      { d: "M 60 40 L 340 40 L 340 200 L 60 200 Z", stroke: "#2b1a2e", strokeWidth: 5, fill: "#fffaf0" },
      { d: "M 200 260 L 90 60 L 310 60 Z", stroke: "#f9c846", strokeWidth: 3, fill: tint },
      { d: "M 180 240 L 220 240 L 230 280 L 170 280 Z", stroke: "#2b1a2e", strokeWidth: 4, fill: "#c8323d" },
      { d: "M 200 240 C 200 220 210 210 200 200 C 190 210 200 220 200 240 Z", stroke: "#2b1a2e", strokeWidth: 3, fill: "#2ec4b6" },
      { d: "M 120 120 C 140 90 180 90 200 120 C 220 90 260 90 280 120", stroke: "#2b1a2e", strokeWidth: 5, fill: "none" },
    ],
    revealScore: reveal,
    fit: 8,
  });
  return {
    director: film.directors[0] ?? "A. Director",
    altTitles: [],
    location: { kind: "filmed", city: "Burbank", region: "California", country: "United States", lat: 34.18, lng: -118.31, revealScore: 2, fit: 6 },
    yearRevealScore: 3,
    scene: drawing("#fff1b8", 4),
    sceneIconic: drawing("#ffd9dc", 8),
    posterSketch: drawing("#d6f5ef", 9),
    propSketch: drawing("#f9c846", 6),
    piano: {
      songTitle: "Mock scale",
      tempo: 120,
      notes: ["C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5", "R", "C5", "G4", "E4", "C4"].map((n) => ({ note: n, beats: n === "R" ? 1 : 0.5 })),
      revealScore: 4,
      fit: 3, // dropped: mock films have no memorable music
    },
    cast: { names: cast, revealScore: 7, fit: 8 },
    characters: { names: ["The Usher", "The Critic", "The Projectionist", "The Rival", "The Dreamer"], revealScore: 8, fit: 9 },
    directorFilms: { films: ["Mock Film One", "Mock Film Two", "Mock Film Three"], revealScore: 5, fit: 6 },
    emoji: { emojis: ["🎬", "🍿", "🎞️", "🎭", "⭐"], revealScore: 6, fit: 7 },
    quote: { text: "This is a placeholder line because no API key was configured for the mock game.", revealScore: 8, fit: 2 },
    tagline: { text: "Every seat tells a story.", revealScore: 4, fit: 7 },
    titleEmoji: { emojis: ["👀", "🎬", "❗"], revealScore: 8, fit: 8 },
    plot: {
      sentences: [
        "Someone wants something they cannot easily have.",
        "A friend and a rival both complicate the pursuit.",
        "A projector and a red velvet curtain figure prominently.",
        "The finale happens on a stage lit by a single golden beam.",
        "It is a mock film about a party game called Seen It!",
      ],
      revealScore: 9,
      fit: 9,
    },
  };
}

export interface GenerateProgress {
  fraction: number; // 0..1
  stage: string;
}

// ---- concurrency limiter (a game start can fan out a dozen calls at once) ----
let running = 0;
/** Current concurrency cap: halves when the API rate-limits us, creeps back up after successes. */
let capacity = MAX_CONCURRENT;
let successStreak = 0;
const waiting: { priority: number; resolve: () => void }[] = [];
function pump(): void {
  while (running < capacity && waiting.length) {
    running++;
    waiting.shift()!.resolve();
  }
}
/** Lower priority number runs first: the film players are waiting on beats the ones being prefetched. */
async function withSlot<T>(priority: number, fn: () => Promise<T>): Promise<T> {
  if (running >= capacity) {
    await new Promise<void>((resolve) => {
      waiting.push({ priority, resolve });
      waiting.sort((a, b) => a.priority - b.priority);
    });
  } else {
    running++;
  }
  try {
    return await fn();
  } finally {
    running--;
    pump();
  }
}
function noteRateLimited(): void {
  successStreak = 0;
  if (capacity > 1) {
    capacity = Math.max(1, Math.floor(capacity / 2));
    console.warn(`[clues] rate limited by Claude; concurrency now ${capacity}`);
  }
}
function noteSuccess(): void {
  if (++successStreak >= 4 && capacity < MAX_CONCURRENT) {
    capacity++;
    successStreak = 0;
    console.log(`[clues] concurrency back up to ${capacity}`);
  }
  pump();
}

const RATE_LIMIT_WAITS_MS = [3000, 8000, 15000, 30000, 60000, 90000];
type ApiError = InstanceType<typeof Anthropic.APIError>;
function isRateLimit(err: unknown): err is ApiError {
  return err instanceof Anthropic.APIError && (err.status === 429 || err.status === 529);
}
function retryAfterMs(err: ApiError, attempt: number): number {
  const header = Number(err.headers?.get?.("retry-after") ?? NaN);
  const base = RATE_LIMIT_WAITS_MS[Math.min(attempt, RATE_LIMIT_WAITS_MS.length - 1)];
  return Math.max(Number.isFinite(header) && header > 0 ? header * 1000 : 0, base) + Math.random() * 1000;
}

/** Typical streamed character counts per call type, learned from previous runs, so the loading bar is honest. */
const calibrationFile = path.join(CACHE_DIR, "calibration.json");
const expectedChars: Record<"text" | "draw" | "review", number> = { text: 5000, draw: 2600, review: 2600 };
let calibrationLoaded = false;
async function loadCalibration(): Promise<void> {
  if (calibrationLoaded) return;
  calibrationLoaded = true;
  const saved = await readJsonCache<Partial<typeof expectedChars>>(calibrationFile, Number.MAX_SAFE_INTEGER);
  if (saved) for (const k of Object.keys(expectedChars) as (keyof typeof expectedChars)[]) if (saved[k]) expectedChars[k] = saved[k]!;
}
function learn(kind: keyof typeof expectedChars, actual: number): void {
  expectedChars[kind] = Math.round(expectedChars[kind] * 0.6 + actual * 0.4);
  void writeJsonCache(calibrationFile, expectedChars);
}

type UserContent = string | Anthropic.Beta.BetaContentBlockParam[];

/** One streamed structured-output call. Reports streamed characters so callers can show progress. */
async function callClaude<T extends z.ZodType>(
  schema: T,
  system: string,
  content: UserContent,
  onChars: (chars: number) => void,
  priority: number,
  onWait?: (seconds: number) => void,
): Promise<{ output: z.infer<T>; chars: number; model: string; inTok: number; outTok: number }> {
  // Rate limits are a fact of life on smaller API tiers: wait it out (up to ~3.5 minutes) rather
  // than fail the film. Each attempt takes its own concurrency slot so waiting doesn't hog one.
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await callClaudeOnce(schema, system, content, onChars, priority);
      noteSuccess();
      return result;
    } catch (err) {
      const cause = err instanceof ClueGenerationError ? err.cause : err;
      if (isRateLimit(cause) && attempt < RATE_LIMIT_WAITS_MS.length) {
        noteRateLimited();
        const wait = retryAfterMs(cause, attempt);
        onWait?.(Math.round(wait / 1000));
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

async function callClaudeOnce<T extends z.ZodType>(
  schema: T,
  system: string,
  content: UserContent,
  onChars: (chars: number) => void,
  priority: number,
): Promise<{ output: z.infer<T>; chars: number; model: string; inTok: number; outTok: number }> {
  return withSlot(priority, async () => {
    const useFast = fastAvailable;
    let chars = 0;
    try {
      const stream = getClient().beta.messages.stream({
        model: MODEL,
        max_tokens: 40000,
        betas: useFast ? ["server-side-fallback-2026-07-01", "fast-mode-2026-02-01"] : ["server-side-fallback-2026-07-01"],
        ...(useFast ? { speed: "fast" as const } : {}),
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: EFFORT, format: zodOutputFormat(schema) },
        system,
        messages: [{ role: "user", content }],
      });
      stream.on("text", (delta) => {
        chars += delta.length;
        onChars(chars);
      });
      const response = await stream.finalMessage();
      if (response.stop_reason === "refusal") throw new ClueGenerationError("Claude declined to write clues for this film.");
      const text = response.content.find((b) => b.type === "text")?.text ?? "";
      let output: z.infer<T>;
      try {
        output = schema.parse(JSON.parse(text));
      } catch (err) {
        throw new ClueGenerationError(`Claude returned an unparseable clue pack: ${err instanceof Error ? err.message.slice(0, 200) : err}`);
      }
      return { output, chars, model: response.model, inTok: response.usage.input_tokens, outTok: response.usage.output_tokens };
    } catch (err) {
      if (err instanceof ClueGenerationError) throw err;
      if (useFast && err instanceof Anthropic.APIError && /fast/i.test(err.message ?? "")) {
        // Fast mode is a separate rate limit and not on every account: give up on it for this process.
        fastAvailable = false;
        console.warn("[clues] fast mode unavailable, using standard speed from now on");
        running--; // withSlot re-acquires below
        try {
          return await callClaudeOnce(schema, system, content, onChars, priority);
        } finally {
          running++;
        }
      }
      throw new ClueGenerationError(describeApiError(err), { cause: err });
    }
  });
}

const STAGES = ["Reading the script…", "Scouting locations…", "Tuning the piano…", "Inking the scenes…", "Sketching the poster…", "Raiding the prop room…", "Reviewing the sketches…", "Cutting the trailer…"];

/** Draw one picture, then (optionally) let Claude look at the render and improve it. */
async function drawOne(
  kind: keyof typeof DRAW_BRIEFS,
  filmText: string,
  onProgress: (fraction: number) => void,
  priority: number,
  onWait?: (seconds: number) => void,
): Promise<{ drawing: Drawing; usage: string }> {
  const share = DRAW_REVIEW ? 0.5 : 1;
  const first = await callClaude(
    DrawingSchema,
    `${PREAMBLE}\n\n${DRAW_STYLE}`,
    `${DRAW_BRIEFS[kind]}\n\n${filmText}`,
    (c) => onProgress(share * Math.min(1, c / expectedChars.draw)),
    priority,
    onWait,
  );
  learn("draw", first.chars);
  const toDrawing = (r: RawDrawing): Drawing => ({
    description: r.description,
    strokes: decodeElements(r.elements),
    revealScore: clamp(r.revealScore, 1, 10),
    fit: clamp(r.fit, 1, 10),
  });
  let drawing = toDrawing(first.output);
  let usage = `${first.outTok}`;
  if (DRAW_REVIEW && drawing.strokes.length >= 5) {
    try {
      const png = renderPng(drawing.strokes).toString("base64");
      const review = await callClaude(
        DrawingSchema,
        REVIEW_PROMPT,
        [
          { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
          {
            type: "text",
            text: `${DRAW_BRIEFS[kind]}\n\n${filmText}\n\nYour plan was: ${first.output.plan}\nYour elements were:\n${first.output.elements.join("\n")}`,
          },
        ],
        (c) => onProgress(share + share * Math.min(1, c / expectedChars.review)),
        priority,
        onWait,
      );
      learn("review", review.chars);
      const improved = toDrawing(review.output);
      if (improved.strokes.length >= 5) drawing = improved;
      usage += `+${review.outTok}`;
    } catch (err) {
      console.warn(`[clues] review of ${kind} failed, keeping first draft:`, err instanceof Error ? err.message.slice(0, 120) : err);
    }
  }
  onProgress(1);
  return { drawing, usage };
}

const EMPTY_DRAWING: Drawing = { description: "", strokes: [], revealScore: 1, fit: 1 };

/** A drawing that fails for any non-rate-limit reason (content filter, malformed output) is dropped, not fatal. */
async function drawOrSkip(
  kind: keyof typeof DRAW_BRIEFS,
  film: FilmDetails,
  filmText: string,
  onProgress: (fraction: number) => void,
  priority: number,
  onWait: (seconds: number) => void,
): Promise<{ drawing: Drawing; usage: string }> {
  try {
    return await drawOne(kind, filmText, onProgress, priority, onWait);
  } catch (err) {
    console.warn(`[clues] skipping ${kind} for ${film.title}:`, err instanceof Error ? err.message.slice(0, 160) : err);
    onProgress(1);
    return { drawing: EMPTY_DRAWING, usage: "skipped" };
  }
}

/** Ask Claude for a clue pack (cached on disk per film slug). Text clues and four drawings run in parallel. */
export async function generateCluePack(
  film: FilmDetails,
  onProgress?: (p: GenerateProgress) => void,
  priority = 5,
): Promise<CluePack> {
  if (process.env.MOCK_CLUES === "1") {
    onProgress?.({ fraction: 1, stage: "Mock clues ready" });
    return mockPack(film);
  }
  const cacheFile = path.join(CACHE_DIR, "clues", `${film.slug}.v${PACK_VERSION}.json`);
  const cached = await readJsonCache<CluePack>(cacheFile, Number.MAX_SAFE_INTEGER);
  if (cached) {
    onProgress?.({ fraction: 1, stage: "Clues ready" });
    return cached;
  }
  await loadCalibration();

  const started = Date.now();
  const parts = { text: 0, scene: 0, sceneIconic: 0, posterSketch: 0, propSketch: 0 };
  let waitingUntil = 0;
  const report = () => {
    const f = (parts.text + parts.scene + parts.sceneIconic + parts.posterSketch + parts.propSketch) / 5;
    const waiting = waitingUntil > Date.now();
    onProgress?.({
      fraction: Math.min(0.97, f),
      stage: waiting ? `Claude is busy, retrying in ${Math.ceil((waitingUntil - Date.now()) / 1000)}s…` : STAGES[Math.min(STAGES.length - 1, Math.floor(f * STAGES.length))],
    });
  };
  const onWait = (seconds: number) => {
    waitingUntil = Math.max(waitingUntil, Date.now() + seconds * 1000);
    report();
  };
  const filmText = describeFilm(film);
  const textProgress = (c: number) => {
    parts.text = Math.min(1, c / expectedChars.text);
    report();
  };
  const textCall = async () => {
    try {
      return await callClaude(TextPackSchema, TEXT_PROMPT, `Write the clue pack for this film.\n\n${filmText}`, textProgress, priority, onWait);
    } catch (err) {
      // The API's output filter sometimes blocks verbatim material (a transcribed song, a long quote).
      // Try once more without those parts rather than losing the whole film.
      if (!(err instanceof Error && /content filter/i.test(err.message))) throw err;
      console.warn(`[clues] text pack for ${film.title} hit the content filter; retrying without melody/quote/tagline`);
      return callClaude(
        TextPackSchema,
        TEXT_PROMPT,
        `Write the clue pack for this film.\n\n${filmText}\n\nIMPORTANT: a previous attempt was blocked by a content filter. Set piano.notes to an empty list with fit 1, quote.text and tagline.text to empty strings with fit 1, and do not reproduce lyrics or any verbatim text longer than a few words.`,
        textProgress,
        priority,
        onWait,
      );
    }
  };
  const [text, scene, sceneIconic, posterSketch, propSketch] = await Promise.all([
    textCall(),
    drawOrSkip("scene", film, filmText, (fr) => {
      parts.scene = fr;
      report();
    }, priority, onWait),
    drawOrSkip("sceneIconic", film, filmText, (fr) => {
      parts.sceneIconic = fr;
      report();
    }, priority, onWait),
    drawOrSkip("posterSketch", film, filmText, (fr) => {
      parts.posterSketch = fr;
      report();
    }, priority, onWait),
    drawOrSkip("propSketch", film, filmText, (fr) => {
      parts.propSketch = fr;
      report();
    }, priority, onWait),
  ]);
  learn("text", text.chars);
  const pack = sanitize({
    ...text.output,
    scene: scene.drawing,
    sceneIconic: sceneIconic.drawing,
    posterSketch: posterSketch.drawing,
    propSketch: propSketch.drawing,
  });
  console.log(
    `[clues] ${film.title} (${film.year}) via ${text.model} in ${((Date.now() - started) / 1000).toFixed(1)}s ` +
      `(out tokens: text ${text.outTok}, scene ${scene.usage}, iconic ${sceneIconic.usage}, poster ${posterSketch.usage}, prop ${propSketch.usage})`,
  );
  await writeJsonCache(cacheFile, pack);
  onProgress?.({ fraction: 1, stage: "Clues ready" });
  return pack;
}

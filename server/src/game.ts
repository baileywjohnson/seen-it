import { randomBytes, randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  DEFAULT_SETTINGS,
  SETTINGS_LIMITS,
  type ChatKind,
  type ChatMessage,
  type ClientMessage,
  type CluePayload,
  type ClueType,
  type CsvFilm,
  type Difficulty,
  type Phase,
  type PublicPlayer,
  type RoomSettings,
  type RoomState,
  type ServerMessage,
  type SyncStatus,
} from "../../shared/src/index.js";
import { generateCluePack, type CluePack, type GenerateProgress } from "./clues/generate.js";
import { checkGuess } from "./guess.js";
import {
  fetchFilmDetails,
  filmsFromCsv,
  minimalDetails,
  resolveSlug,
  type FilmDetails,
  type WatchedFilm,
} from "./letterboxd.js";

/** Opaque poster tokens -> real Letterboxd CDN URLs (the URL contains the title, so never send it). */
export const posterStore = new Map<string, string>();

interface Player {
  id: string;
  token: string;
  name: string;
  films: WatchedFilm[] | null;
  syncStatus: SyncStatus;
  syncMessage: string;
  score: number;
  socket: WebSocket | null;
  guessedAt: number | null;
  roundPoints: number;
  removeTimer: NodeJS.Timeout | null;
}

interface ScoredClue {
  type: ClueType;
  score: number; // how revealing (1-10)
  fit: number; // whether it points at this film at all (1-10)
  payload: CluePayload;
}

interface RoundPack {
  details: FilmDetails;
  pack: CluePack;
  clues: ScoredClue[];
  answers: string[];
}

const DISCONNECT_GRACE_MS = 90_000;
const PREFETCH_DEPTH = 3;
const POSITION_BONUS = [150, 100, 50];
const MIN_FIT = 5;
/** How long to wait for Letterboxd metadata before generating from the CSV's title + year alone. */
const META_BUDGET_MS = 8000;
const MIN_FIT_PIANO = 7; // only themes people actually hum
const MIN_CLUES = 3;
const FINALE_MIN_REVEAL = 8;

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Every clue Claude produced for the film, with its two scores, before any filtering. */
function allClues(details: FilmDetails, pack: CluePack): ScoredClue[] {
  const clues: ScoredClue[] = [];
  const { location: loc } = pack;
  clues.push({
    type: "location",
    score: loc.revealScore,
    fit: loc.fit,
    payload: { type: "location", kind: loc.kind, lat: loc.lat, lng: loc.lng, city: loc.city, region: loc.region, country: loc.country },
  });
  if (details.year) clues.push({ type: "year", score: pack.yearRevealScore, fit: 10, payload: { type: "year", year: details.year } });
  for (const [type, d] of [["scene", pack.scene], ["sceneIconic", pack.sceneIconic], ["posterSketch", pack.posterSketch]] as const) {
    if (d.strokes.length >= 5) clues.push({ type, score: d.revealScore, fit: d.fit, payload: { type: "drawing", strokes: d.strokes } });
  }
  if (pack.piano.notes.length >= 8)
    clues.push({
      type: "piano",
      score: pack.piano.revealScore,
      fit: pack.piano.fit,
      payload: { type: "piano", tempo: pack.piano.tempo, notes: pack.piano.notes },
    });
  if (pack.cast.names.length >= 3)
    clues.push({ type: "cast", score: pack.cast.revealScore, fit: pack.cast.fit, payload: { type: "list", heading: "Starring", items: pack.cast.names } });
  if (pack.characters.names.length >= 3)
    clues.push({
      type: "characters",
      score: pack.characters.revealScore,
      fit: pack.characters.fit,
      payload: { type: "list", heading: "Characters", items: pack.characters.names },
    });
  if (pack.directorFilms.films.length >= 2)
    clues.push({
      type: "director",
      score: pack.directorFilms.revealScore,
      fit: pack.directorFilms.fit,
      payload: { type: "list", heading: "From the director of", items: pack.directorFilms.films },
    });
  if (pack.emoji.emojis.length >= 3)
    clues.push({ type: "emoji", score: pack.emoji.revealScore, fit: pack.emoji.fit, payload: { type: "emoji", emojis: pack.emoji.emojis } });
  if (pack.quote.text) {
    const words = pack.quote.text.split(/\s+/).length;
    clues.push({
      type: "quote",
      score: pack.quote.revealScore,
      fit: pack.quote.fit,
      payload: { type: "quote", text: pack.quote.text, order: shuffle(Array.from({ length: words }, (_, i) => i)) },
    });
  }
  if (pack.plot.sentences.length >= 3)
    clues.push({ type: "plot", score: pack.plot.revealScore, fit: pack.plot.fit, payload: { type: "plot", sentences: pack.plot.sentences } });
  if (pack.propSketch.strokes.length >= 5)
    clues.push({ type: "propSketch", score: pack.propSketch.revealScore, fit: pack.propSketch.fit, payload: { type: "drawing", strokes: pack.propSketch.strokes } });
  if (pack.tagline.text) {
    const words = pack.tagline.text.split(/\s+/).length;
    clues.push({
      type: "tagline",
      score: pack.tagline.revealScore,
      fit: pack.tagline.fit,
      payload: { type: "quote", text: pack.tagline.text, order: shuffle(Array.from({ length: words }, (_, i) => i)) },
    });
  }
  if (pack.titleEmoji.emojis.length >= 2)
    clues.push({ type: "titleEmoji", score: pack.titleEmoji.revealScore, fit: pack.titleEmoji.fit, payload: { type: "emoji", emojis: pack.titleEmoji.emojis } });

  // Facts we already have: no AI, always fit, low reveal.
  const facts: { label: string; value: string }[] = [];
  if (details.countries.length) facts.push({ label: "Country", value: details.countries.slice(0, 2).join(" / ") });
  if (details.runtimeMinutes) facts.push({ label: "Runtime", value: `${Math.floor(details.runtimeMinutes / 60)}h ${details.runtimeMinutes % 60}m` });
  if (details.year) facts.push({ label: "Decade", value: `${Math.floor(details.year / 10) * 10}s` });
  if (details.genres.length) facts.push({ label: "Genre", value: details.genres.slice(0, 3).join(", ") });
  if (details.cast.length) facts.push({ label: "Cast size", value: `${details.cast.length}+ credited` });
  if (facts.length >= 3) clues.push({ type: "vitals", score: 2.5, fit: 10, payload: { type: "vitals", facts: facts.slice(0, 5) } });

  // Title puzzles: universal, and the blanks are the guaranteed finale.
  const titleWords = details.title.split(/\s+/).filter(Boolean);
  const letterCount = details.title.replace(/[^\p{L}\p{N}]/gu, "").length;
  if (letterCount >= 4 && letterCount <= 40) {
    const scrambled = titleWords.map((w) => {
      const letters = w.split("");
      const idx = letters.map((_, i) => i).filter((i) => /[\p{L}\p{N}]/u.test(letters[i]));
      const shuffledIdx = shuffle(idx);
      const out = letters.slice();
      idx.forEach((from, k) => (out[from] = letters[shuffledIdx[k]]));
      return out.join("").toUpperCase();
    });
    const order = shuffle(Array.from({ length: letterCount }, (_, i) => i));
    clues.push({
      type: "anagram",
      score: 6.5,
      fit: titleWords.length <= 6 ? 8 : 4,
      payload: { type: "anagram", words: scrambled, solution: titleWords.map((w) => w.toUpperCase()), order },
    });
    clues.push({ type: "blanks", score: 9.5, fit: 10, payload: { type: "blanks", title: details.title, order: shuffle(Array.from({ length: letterCount }, (_, i) => i)) } });
  }
  return clues;
}

/**
 * Keep only clues that genuinely fit this film, least revealing first, and make sure the round can
 * still end on something guessable. Returns the ordered pool the round will draw from.
 */
function buildClues(details: FilmDetails, pack: CluePack): ScoredClue[] {
  const all = allClues(details, pack);
  const fits = (c: ScoredClue) => c.fit >= (c.type === "piano" ? MIN_FIT_PIANO : MIN_FIT);
  let pool = all.filter(fits);
  if (pool.length < MIN_CLUES) {
    // Thin film: top up with the best-fitting leftovers rather than playing a two-clue round.
    const rest = all.filter((c) => !pool.includes(c)).sort((a, b) => b.fit - a.fit);
    pool = pool.concat(rest.slice(0, MIN_CLUES - pool.length));
  }
  if (!pool.some((c) => c.score >= FINALE_MIN_REVEAL)) {
    // Nothing decisive survived: bring in the most revealing universal clue so the finale lands.
    const finale = all
      .filter((c) => !pool.includes(c) && (c.type === "plot" || c.type === "characters" || c.type === "sceneIconic"))
      .sort((a, b) => b.score - a.score)[0];
    if (finale) pool.push(finale);
  }
  // Least revealing first; ties broken by a small random jitter so repeat plays vary.
  return pool
    .map((c) => ({ c, k: c.score + Math.random() * 0.5 }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.c);
}

/**
 * Pick `k` clues from the reveal-sorted pool. Difficulty sets where the spread starts: on easy the
 * first clue already comes from the middle of the range, on hard it starts at the very bottom.
 * The last pick is always the most revealing clue available.
 */
function selectClues(sorted: ScoredClue[], k: number, difficulty: Difficulty): ScoredClue[] {
  const n = sorted.length;
  if (n <= k) return sorted;
  const start = difficulty === "easy" ? 0.4 : difficulty === "hard" ? 0 : 0.2;
  const picked = new Set<number>();
  for (let i = 0; i < k; i++) {
    const q = start + ((1 - start) * i) / (k - 1);
    picked.add(Math.min(n - 1, Math.round(q * (n - 1))));
  }
  // Rounding can collapse neighbours; fill from the revealing end so the count stays honest.
  for (let i = n - 1; picked.size < k && i >= 0; i--) picked.add(i);
  return [...picked].sort((a, b) => a - b).map((i) => sorted[i]);
}

export class Room {
  readonly code: string;
  hostId: string | null = null;
  settings: RoomSettings = { ...DEFAULT_SETTINGS };
  players = new Map<string, Player>();
  phase: Phase = "lobby";
  private loading: { message: string; progress: number } | null = null;

  private movies: WatchedFilm[] = [];
  private packs = new Map<number, Promise<RoundPack | null>>();
  private packProgress = new Map<string, GenerateProgress>(); // by film key
  /** A film pre-generated while everyone is still in the lobby, so "Roll film" starts fast. */
  private warm: { film: WatchedFilm; promise: Promise<RoundPack | null> } | null = null;
  private warmTimer: NodeJS.Timeout | null = null;
  private lastPackError: string | null = null;
  private roundsPlayed = 0;
  private roundIndex = -1;
  private roundClues: ScoredClue[] = [];
  private clueIndex = 0;
  private roundStartedAt = 0;
  private clueStartedAt = 0;
  private clueEndsAt = 0;
  private revealEndsAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private guessOrder = 0;

  constructor(code: string, private onEmpty: (room: Room) => void) {
    this.code = code;
  }

  // ---------- connection lifecycle ----------

  join(socket: WebSocket, name: string, token: string): Player {
    let player = [...this.players.values()].find((p) => p.token === token);
    if (player) {
      if (player.removeTimer) clearTimeout(player.removeTimer);
      player.removeTimer = null;
      player.socket?.close();
      player.socket = socket;
      if (name.trim()) player.name = name.trim().slice(0, 20);
    } else {
      player = {
        id: randomUUID().slice(0, 8),
        token,
        name: name.trim().slice(0, 20) || "Anonymous",
        films: null,
        syncStatus: "none",
        syncMessage: "",
        score: 0,
        socket,
        guessedAt: null,
        roundPoints: 0,
        removeTimer: null,
      };
      this.players.set(player.id, player);
      this.systemChat(`${player.name} took a seat.`);
    }
    if (!this.hostId || !this.players.has(this.hostId)) this.hostId = player.id;
    this.send(player, { t: "welcome", playerId: player.id, token: player.token, code: this.code });
    this.broadcastRoom();
    return player;
  }

  disconnect(playerId: string, socket: WebSocket): void {
    const p = this.players.get(playerId);
    if (!p || p.socket !== socket) return;
    p.socket = null;
    p.removeTimer = setTimeout(() => this.remove(p), DISCONNECT_GRACE_MS);
    this.broadcastRoom();
  }

  private remove(p: Player): void {
    if (!this.players.delete(p.id)) return;
    if (p.removeTimer) clearTimeout(p.removeTimer);
    this.systemChat(`${p.name} left the theatre.`);
    if (this.hostId === p.id) {
      const next = [...this.players.values()].find((x) => x.socket) ?? [...this.players.values()][0];
      this.hostId = next?.id ?? null;
      if (next) this.systemChat(`${next.name} now holds the projector keys.`);
    }
    if (this.players.size === 0) {
      this.clearTimer();
      this.onEmpty(this);
      return;
    }
    if (this.phase === "clue") this.maybeEndRoundEarly();
    this.broadcastRoom();
  }

  handle(playerId: string, msg: ClientMessage): void {
    const p = this.players.get(playerId);
    if (!p) return;
    switch (msg.t) {
      case "setCsv":
        this.setCsv(p, msg.films);
        break;
      case "settings":
        if (p.id === this.hostId && this.phase === "lobby") this.updateSettings(msg.settings);
        break;
      case "start":
        if (p.id === this.hostId && this.phase === "lobby") void this.start();
        break;
      case "guess":
        this.guess(p, msg.text);
        break;
      case "playAgain":
        if (p.id === this.hostId && this.phase === "gameover") this.backToLobby();
        break;
      case "leave":
        p.socket?.close();
        this.remove(p);
        break;
      case "ping":
        this.send(p, { t: "pong", serverTime: Date.now() });
        break;
    }
  }

  // ---------- lobby ----------

  private setCsv(p: Player, rows: CsvFilm[]): void {
    const films = filmsFromCsv(rows.slice(0, 20_000));
    p.films = films;
    p.syncStatus = films.length ? "ready" : "error";
    p.syncMessage = films.length
      ? `${films.length.toLocaleString()} films from watched.csv`
      : "No films found in that file — make sure it's watched.csv from your Letterboxd export.";
    this.broadcastRoom();
    this.scheduleWarmUp();
  }

  /** Once the pool settles, quietly generate one candidate first film in the background. */
  private scheduleWarmUp(): void {
    if (this.warmTimer) clearTimeout(this.warmTimer);
    this.warmTimer = setTimeout(() => {
      this.warmTimer = null;
      if (this.phase !== "lobby") return;
      const pool = this.computePool();
      if (!pool.length) return;
      if (this.warm && pool.some((f) => f.key === this.warm!.film.key)) return; // still valid
      const film = pool[Math.floor(Math.random() * pool.length)];
      this.warm = { film, promise: this.buildPack(film, 0) };
      console.log(`[room ${this.code}] warming up "${film.name}"`);
    }, 4000);
  }

  private updateSettings(patch: Partial<RoomSettings>): void {
    const next = { ...this.settings };
    for (const key of Object.keys(SETTINGS_LIMITS) as (keyof typeof SETTINGS_LIMITS)[]) {
      const v = patch[key];
      if (typeof v === "number" && Number.isFinite(v)) {
        const { min, max } = SETTINGS_LIMITS[key];
        next[key] = Math.round(Math.min(max, Math.max(min, v)));
      }
    }
    if (patch.difficulty === "easy" || patch.difficulty === "normal" || patch.difficulty === "hard") next.difficulty = patch.difficulty;
    this.settings = next;
    this.broadcastRoom();
  }

  /** Films every ready player has watched (a solo player just gets their own list). */
  private computePool(): WatchedFilm[] {
    const lists = [...this.players.values()].filter((p) => p.films?.length).map((p) => p.films!);
    if (!lists.length) return [];
    const [first, ...rest] = lists.sort((a, b) => a.length - b.length);
    const keySets = rest.map((l) => new Set(l.map((f) => f.key)));
    return first.filter((f) => keySets.every((s) => s.has(f.key)));
  }

  // ---------- game flow ----------

  private async start(): Promise<void> {
    const pool = this.computePool();
    if (!pool.length) {
      this.systemChat("Nobody has a synced watchlist yet, or you have no films in common.", "error");
      return;
    }
    const rounds = Math.min(this.settings.rounds, pool.length);
    if (rounds < this.settings.rounds) this.systemChat(`Only ${pool.length} films in common, so we'll play ${rounds}.`);
    this.movies = shuffle(pool).slice(0, rounds);
    this.packs.clear();
    if (this.warm && pool.some((f) => f.key === this.warm!.film.key)) {
      // The warmed-up film goes first, and its (possibly finished) generation is reused.
      this.movies = [this.warm.film, ...this.movies.filter((m) => m.key !== this.warm!.film.key)].slice(0, rounds);
      this.packs.set(0, this.warm.promise);
    }
    this.warm = null;
    this.roundIndex = -1;
    this.roundsPlayed = 0;
    this.lastPackError = null;
    for (const p of this.players.values()) {
      p.score = 0;
      p.roundPoints = 0;
      p.guessedAt = null;
    }
    this.setLoading("Rolling the projector…", 0.02);
    this.prefetch(0);
    await this.nextRound();
  }

  /** Keep a few films ahead, but generate them one after another: a burst of parallel films trips API rate limits. */
  private prefetch(from: number): void {
    for (let i = from; i < Math.min(this.movies.length, from + PREFETCH_DEPTH); i++) {
      if (this.packs.has(i)) continue;
      const previous = i > from ? this.packs.get(i - 1) : null;
      const index = i;
      this.packs.set(
        index,
        previous ? previous.then(() => this.buildPack(this.movies[index], index)) : this.buildPack(this.movies[index], index),
      );
    }
  }

  private async buildPack(movie: WatchedFilm, priority: number): Promise<RoundPack | null> {
    try {
      // Letterboxd's film page (cast, poster, director) is a nice-to-have, and Cloudflare sometimes
      // stalls hosted servers. Give it a short budget, then generate from the CSV's title + year;
      // if the page arrives later it still feeds the reveal screen.
      const meta = (async (): Promise<FilmDetails | null> => {
        const slug = await resolveSlug(movie);
        return slug ? fetchFilmDetails(slug) : null;
      })().catch((err) => {
        console.warn(`[room ${this.code}] Letterboxd unavailable for ${movie.name}, using CSV data only:`, err instanceof Error ? err.message : err);
        return null;
      });
      let details = await Promise.race([meta, new Promise<undefined>((r) => setTimeout(() => r(undefined), META_BUDGET_MS))]);
      const usedMinimal = !details;
      if (usedMinimal) console.log(`[room ${this.code}] Letterboxd slow for ${movie.name}; generating from CSV data`);
      details ??= minimalDetails(movie, movie.slug);
      const pack = await generateCluePack(details, (p) => this.packProgress.set(movie.key, p), priority);
      if (!details.directors.length && pack.director) details = { ...details, directors: [pack.director] };
      const answers = [details.title, movie.name, ...pack.altTitles];
      const round: RoundPack = { details, pack, clues: buildClues(details, pack), answers };
      if (usedMinimal) {
        void meta.then((late) => {
          if (late) round.details = { ...late, directors: late.directors.length ? late.directors : round.details.directors };
        });
      }
      return round;
    } catch (err) {
      this.lastPackError = err instanceof Error ? err.message : String(err);
      console.error(`[room ${this.code}] failed to build clues for ${movie.name}:`, err);
      return null;
    }
  }

  private async nextRound(): Promise<void> {
    this.clearTimer();
    while (true) {
      this.roundIndex++;
      if (this.roundIndex >= this.movies.length) {
        this.gameOver();
        return;
      }
      this.prefetch(this.roundIndex);
      const promise = this.packs.get(this.roundIndex)!;
      const movie = this.movies[this.roundIndex];
      const refresh = () => {
        const p = this.packProgress.get(movie.key);
        const base = this.roundIndex === 0 ? "Rolling the projector…" : "Threading the next reel…";
        this.setLoading(p?.stage ? `${base} ${p.stage}` : base, p?.fraction ?? 0.02);
      };
      refresh();
      const loadingTimer = setInterval(refresh, 700);
      const pack = await promise;
      clearInterval(loadingTimer);
      if (this.phase === "lobby") return; // the room was reset while we were waiting
      if (!pack) {
        this.systemChat(`Couldn't build clues for "${this.movies[this.roundIndex].name}": ${this.lastPackError ?? "unknown error"}`, "error");
        continue;
      }
      this.roundsPlayed++;
      this.startRound(pack);
      return;
    }
  }

  private posterTokens = new Map<string, string>();
  /** The real poster is only ever shown on the reveal screen, via an opaque token. */
  private revealPosterUrl(pack: RoundPack): string | null {
    const url = pack.details.posterUrl;
    if (!url) return null;
    let token = this.posterTokens.get(url);
    if (!token) {
      token = randomBytes(12).toString("hex");
      this.posterTokens.set(url, token);
      posterStore.set(token, url);
    }
    return `/api/poster/${token}`;
  }

  private currentPack(): RoundPack | null {
    // packs only ever resolve synchronously-cached values after nextRound awaited them
    return this.resolvedPack;
  }
  private resolvedPack: RoundPack | null = null;

  private startRound(pack: RoundPack): void {
    this.resolvedPack = pack;
    this.roundClues = selectClues(pack.clues, this.settings.cluesPerMovie, this.settings.difficulty);
    this.clueIndex = 0;
    this.guessOrder = 0;
    for (const p of this.players.values()) {
      p.guessedAt = null;
      p.roundPoints = 0;
    }
    this.loading = null;
    this.roundStartedAt = Date.now();
    this.startClue();
  }

  private startClue(): void {
    this.phase = "clue";
    this.clueStartedAt = Date.now();
    this.clueEndsAt = this.clueStartedAt + this.settings.clueSeconds * 1000;
    this.broadcastRoom();
    this.setTimer(() => {
      if (this.clueIndex + 1 < this.roundClues.length) {
        this.clueIndex++;
        this.startClue();
      } else {
        this.endRound();
      }
    }, this.settings.clueSeconds * 1000);
  }

  private roundEndsAt(): number {
    return this.clueEndsAt + (this.roundClues.length - this.clueIndex - 1) * this.settings.clueSeconds * 1000;
  }

  private guess(p: Player, raw: string): void {
    const text = raw.trim().slice(0, 120);
    if (!text) return;
    const pack = this.currentPack();
    if (this.phase !== "clue" || !pack) {
      this.broadcastChat({ kind: "chat", from: p.name, text });
      return;
    }
    if (p.guessedAt !== null) {
      // Already solved it: only talk to the other solvers so nothing leaks.
      const msg = this.makeChat("chat", p.name, text);
      for (const q of this.players.values()) if (q.guessedAt !== null) this.send(q, { t: "chat", msg });
      return;
    }
    const verdict = checkGuess(text, pack.answers);
    if (verdict === "correct") {
      const now = Date.now();
      const total = this.roundClues.length * this.settings.clueSeconds * 1000;
      const elapsed = Math.min(total, now - this.roundStartedAt);
      const speed = 100 + Math.round(400 * (1 - elapsed / total));
      const bonus = POSITION_BONUS[this.guessOrder] ?? 25;
      this.guessOrder++;
      p.guessedAt = now;
      p.roundPoints = speed + bonus;
      p.score += p.roundPoints;
      this.send(p, { t: "guessResult", correct: true, close: false, points: p.roundPoints });
      this.broadcastChat({ kind: "correct", from: p.name, text: `${p.name} guessed the movie! (+${p.roundPoints})` });
      this.broadcastRoom();
      this.maybeEndRoundEarly();
      return;
    }
    this.broadcastChat({ kind: "guess", from: p.name, text });
    if (verdict === "close") {
      this.send(p, { t: "guessResult", correct: false, close: true, points: 0 });
      this.send(p, { t: "chat", msg: this.makeChat("close", null, `"${text}" is close!`) });
    }
  }

  private maybeEndRoundEarly(): void {
    if (this.phase !== "clue") return;
    const active = [...this.players.values()].filter((p) => p.socket);
    if (active.length && active.every((p) => p.guessedAt !== null)) {
      this.clearTimer();
      setTimeout(() => this.endRound(), 1200);
    }
  }

  private endRound(): void {
    if (this.phase !== "clue") return;
    this.clearTimer();
    this.phase = "reveal";
    this.revealEndsAt = Date.now() + this.settings.revealSeconds * 1000;
    this.broadcastRoom();
    this.setTimer(() => void this.nextRound(), this.settings.revealSeconds * 1000);
  }

  private gameOver(): void {
    this.clearTimer();
    if (this.roundsPlayed === 0) {
      // Nothing was playable: send everyone back to the lobby with the reason instead of an empty podium.
      this.systemChat("No film could be prepared, so we're back in the lobby. Fix the problem above and roll again.", "error");
      this.backToLobby();
      return;
    }
    this.phase = "gameover";
    this.loading = null;
    this.broadcastRoom();
  }

  private backToLobby(): void {
    this.clearTimer();
    this.phase = "lobby";
    this.loading = null;
    this.resolvedPack = null;
    this.packs.clear();
    this.packProgress.clear();
    this.movies = [];
    this.scheduleWarmUp();
    for (const p of this.players.values()) {
      p.score = 0;
      p.roundPoints = 0;
      p.guessedAt = null;
    }
    this.broadcastRoom();
  }

  // ---------- plumbing ----------

  private setLoading(message: string, progress: number): void {
    this.phase = "loading";
    this.loading = { message, progress };
    this.broadcastRoom();
  }

  private setTimer(fn: () => void, ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(fn, ms);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private publicPlayer(p: Player): PublicPlayer {
    return {
      id: p.id,
      name: p.name,
      filmCount: p.films?.length ?? 0,
      syncStatus: p.syncStatus,
      syncMessage: p.syncMessage,
      score: p.score,
      connected: !!p.socket,
      isHost: p.id === this.hostId,
      guessedThisRound: p.guessedAt !== null,
      roundPoints: p.roundPoints,
    };
  }

  private state(): RoomState {
    const pack = this.currentPack();
    const clue = this.phase === "clue" && pack ? this.roundClues[this.clueIndex] : null;
    return {
      code: this.code,
      hostId: this.hostId ?? "",
      settings: this.settings,
      players: [...this.players.values()].map((p) => this.publicPlayer(p)),
      phase: this.phase,
      poolCount: this.phase === "lobby" ? this.computePool().length : this.movies.length,
      loading: this.phase === "loading" ? this.loading : null,
      clue:
        clue && pack
          ? {
              roundIndex: this.roundIndex,
              rounds: this.movies.length,
              clueIndex: this.clueIndex,
              clueTotal: this.roundClues.length,
              clueType: clue.type,
              payload: clue.payload,
              startsAt: this.clueStartedAt,
              endsAt: this.clueEndsAt,
              roundEndsAt: this.roundEndsAt(),
            }
          : null,
      reveal:
        this.phase === "reveal" && pack
          ? {
              roundIndex: this.roundIndex,
              rounds: this.movies.length,
              title: pack.details.title,
              year: pack.details.year ?? 0,
              director: pack.details.directors.join(", "),
              posterUrl: this.revealPosterUrl(pack),
              letterboxdUrl: pack.details.slug.startsWith("csv-") ? null : `https://letterboxd.com/film/${pack.details.slug}/`,
              endsAt: this.revealEndsAt,
              results: [...this.players.values()].map((p) => ({
                playerId: p.id,
                points: p.roundPoints,
                seconds: p.guessedAt ? Math.round((p.guessedAt - this.roundStartedAt) / 100) / 10 : null,
              })),
            }
          : null,
      serverTime: Date.now(),
    };
  }

  private send(p: Player, msg: ServerMessage): void {
    if (p.socket && p.socket.readyState === p.socket.OPEN) p.socket.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.socket && p.socket.readyState === p.socket.OPEN) p.socket.send(data);
    }
  }

  broadcastRoom(): void {
    this.broadcast({ t: "room", room: this.state() });
  }

  private makeChat(kind: ChatKind, from: string | null, text: string): ChatMessage {
    return { id: randomUUID().slice(0, 8), kind, from, text, at: Date.now() };
  }

  private broadcastChat(msg: { kind: ChatKind; from: string | null; text: string }): void {
    this.broadcast({ t: "chat", msg: this.makeChat(msg.kind, msg.from, msg.text) });
  }

  private systemChat(text: string, kind: ChatKind = "system"): void {
    this.broadcastChat({ kind, from: null, text });
  }
}

import path from "node:path";
import { normalizeTitle, type CsvFilm } from "../../shared/src/index.js";
import { CACHE_DIR, readJsonCache, writeJsonCache } from "./paths.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const BASE = "https://letterboxd.com";
const FILM_TTL = 30 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const CHALLENGE_RETRY_WAITS_MS = [2000]; // one polite retry; Cloudflare challenges sometimes lift quickly

export interface WatchedFilm {
  key: string; // normalised "title|year" used to intersect players' lists
  name: string;
  year: number | null;
  slug: string | null;
  uri: string | null;
}

export interface FilmDetails {
  slug: string;
  title: string;
  year: number | null;
  directors: string[];
  cast: string[];
  genres: string[];
  countries: string[];
  description: string;
  posterUrl: string | null;
  runtimeMinutes: number | null;
}

export class LetterboxdError extends Error {}

export function filmKey(name: string, year: number | null): string {
  return `${normalizeTitle(name)}|${year ?? "?"}`;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

const BROWSER_HEADERS = {
  "user-agent": UA,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "upgrade-insecure-requests": "1",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
};

/** True when Cloudflare answered with a bot challenge instead of the page. */
export function isChallenged(res: Response): boolean {
  return res.status === 403 && (res.headers.get("cf-mitigated") === "challenge" || res.headers.get("server") === "cloudflare");
}

async function fetchHtml(url: string, retries = 3): Promise<{ status: number; html: string; challenged?: boolean }> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const challenged = isChallenged(res);
    const retryable = res.status === 429 || res.status >= 500 || challenged;
    if (!retryable || attempt >= retries) {
      const html = res.ok ? await res.text() : "";
      return { status: res.status, html, challenged };
    }
    await res.arrayBuffer().catch(() => undefined); // drain
    const retryAfter = Number(res.headers.get("retry-after"));
    const wait = challenged
      ? (CHALLENGE_RETRY_WAITS_MS[attempt] ?? -1)
      : Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 800 * 2 ** attempt;
    if (wait < 0) {
      // Out of challenge retries: report it rather than hammering Cloudflare further.
      return { status: res.status, html: "", challenged };
    }
    await new Promise((r) => setTimeout(r, wait));
  }
}

/** Convert rows from a Letterboxd export (ideally watched.csv; diary.csv works too) into WatchedFilms.
 *  This is the only way watchlists enter the game: the server never scrapes member profiles. */
export function filmsFromCsv(rows: CsvFilm[]): WatchedFilm[] {
  const seen = new Set<string>();
  const films: WatchedFilm[] = [];
  for (const r of rows) {
    const name = (r.name ?? "").trim();
    if (!name) continue;
    const year = r.year && Number.isFinite(r.year) ? r.year : null;
    const key = filmKey(name, year);
    if (seen.has(key)) continue;
    seen.add(key);
    const slugMatch = r.uri ? /letterboxd\.com\/film\/([^/]+)\/?/.exec(r.uri) : null;
    films.push({ key, name, year, slug: slugMatch?.[1] ?? null, uri: r.uri ?? null });
  }
  return films;
}

/** Resolve a boxd.it short link (or any Letterboxd film URL) to a film slug. */
export async function resolveSlug(film: WatchedFilm): Promise<string | null> {
  if (film.slug) return film.slug;
  if (film.uri) {
    const direct = /letterboxd\.com\/film\/([^/]+)/.exec(film.uri);
    if (direct) return direct[1];
    try {
      const res = await fetch(film.uri, { headers: BROWSER_HEADERS, redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const loc = res.headers.get("location") ?? "";
      const m = /\/film\/([^/]+)\//.exec(loc);
      if (m) return m[1];
    } catch {
      /* fall through to search */
    }
  }
  // Last resort: Letterboxd search
  try {
    const q = encodeURIComponent(film.year ? `${film.name} ${film.year}` : film.name);
    const res = await fetchHtml(`${BASE}/search/films/${q}/`);
    const m = /data-film-slug="([^"]+)"|data-item-slug="([^"]+)"|href="\/film\/([^/]+)\/"/.exec(res.html);
    return m?.[1] ?? m?.[2] ?? m?.[3] ?? null;
  } catch {
    return null;
  }
}

interface LdPerson {
  name?: string;
}

/** Fetch structured facts about a film from its Letterboxd page (JSON-LD + meta tags). */
export async function fetchFilmDetails(slug: string): Promise<FilmDetails> {
  const cacheFile = path.join(CACHE_DIR, "films", `${slug}.json`);
  const cached = await readJsonCache<FilmDetails>(cacheFile, FILM_TTL);
  if (cached) return cached;

  const { status, html } = await fetchHtml(`${BASE}/film/${slug}/`);
  if (status !== 200) throw new LetterboxdError(`Could not load film page for ${slug} (HTTP ${status}).`);

  let ld: Record<string, unknown> = {};
  const ldMatch = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  if (ldMatch) {
    const raw = ldMatch[1].replace(/\/\*\s*<!\[CDATA\[\s*\*\//, "").replace(/\/\*\s*\]\]>\s*\*\//, "").trim();
    try {
      ld = JSON.parse(raw);
    } catch {
      ld = {};
    }
  }
  const ogTitle = decodeEntities(/<meta property="og:title" content="([^"]*)"/.exec(html)?.[1] ?? "");
  const ym = /^(.*)\s\((\d{4})\)$/.exec(ogTitle);
  const title = (ld.name as string) || (ym ? ym[1] : ogTitle) || slug;
  const year = ym ? Number(ym[2]) : typeof ld.dateCreated === "string" ? Number(ld.dateCreated.slice(0, 4)) : null;
  const people = (v: unknown): string[] =>
    Array.isArray(v) ? (v as LdPerson[]).map((p) => p?.name ?? "").filter(Boolean) : [];
  const durationMatch = typeof ld.duration === "string" ? /PT(?:(\d+)H)?(?:(\d+)M)?/.exec(ld.duration) : null;
  const runtime = durationMatch ? Number(durationMatch[1] ?? 0) * 60 + Number(durationMatch[2] ?? 0) : null;
  const details: FilmDetails = {
    slug,
    title,
    year: Number.isFinite(year) ? year : null,
    directors: people(ld.director),
    cast: people(ld.actor).slice(0, 12),
    genres: Array.isArray(ld.genre) ? (ld.genre as string[]) : [],
    countries: people(ld.countryOfOrigin),
    description: typeof ld.description === "string" ? ld.description : "",
    posterUrl: typeof ld.image === "string" && !/empty-poster/.test(ld.image) ? ld.image : null,
    runtimeMinutes: runtime || null,
  };
  await writeJsonCache(cacheFile, details);
  return details;
}

/** What we know about a film when Letterboxd can't be reached: just the CSV's title and year. */
export function minimalDetails(film: WatchedFilm, slug: string | null): FilmDetails {
  return {
    slug: slug ?? `csv-${normalizeTitle(film.name).replace(/\s+/g, "-")}-${film.year ?? "x"}`,
    title: film.name,
    year: film.year,
    directors: [],
    cast: [],
    genres: [],
    countries: [],
    description: "",
    posterUrl: null,
    runtimeMinutes: null,
  };
}

export async function fetchPosterBytes(url: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { ...BROWSER_HEADERS, accept: "image/*,*/*;q=0.8", referer: `${BASE}/` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? "image/jpeg",
    };
  } catch {
    return null;
  }
}

import { normalizeTitle } from "../../shared/src/index.js";

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

const ARTICLES = /^(the|a|an|le|la|les|el|los|las|der|die|das|il|lo) /;
const NUMBER_WORDS: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  first: "1", second: "2", third: "3",
};
/** Roman numerals only count as numbers in the numbering position (last word): "Rocky II", "Episode IV". */
const ROMAN: Record<string, string> = { i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10" };
/** Trailing numbering people leave out: "Part 1", "Chapter Two", "Vol. 3", "Episode IV". */
const NUMBERING = /\s(part|chapter|volume|vol|episode|book)\s\d+$/;

const STOPWORDS = new Set(["the", "a", "an", "of", "and", "to", "in", "at", "on", "for", "with"]);
/** The title with filler words removed: "lord rings fellowship ring". */
function bare(s: string): string {
  return s.split(" ").filter((w) => !STOPWORDS.has(w)).join(" ");
}

/** Canonical form for comparison: lowercase, no punctuation/articles, numbers unified. */
function canon(s: string): string {
  let n = normalizeTitle(s).replace(/\s\d{4}$/, ""); // drop a trailing "(1999)"
  n = n
    .split(" ")
    .map((w, i, arr) => (arr.length > 1 && NUMBER_WORDS[w]) || (i === arr.length - 1 && i > 0 && ROMAN[w]) || w)
    .join(" ");
  return n.replace(ARTICLES, "");
}

/** Every form of a title that should count as naming it. */
export function answerForms(title: string): string[] {
  const forms = new Set<string>();
  const add = (s: string) => {
    const c = canon(s);
    if (c.length >= 2) forms.add(c);
  };
  add(title);
  // Split on subtitle separators before punctuation is stripped: "A: B - Part 1" -> [A, B, Part 1]
  const segments = title
    .split(/\s*[:–—]\s*|\s+-\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const isNumbering = (s: string) => /^(part|chapter|volume|vol\.?|episode|book)\s+\S+$/i.test(s) || /^\d+$/.test(s);
  const body = segments.filter((s) => !isNumbering(s));
  // The whole thing minus numbering: "the hunger games mockingjay"
  if (body.length && body.length < segments.length) add(body.join(" "));
  // Subtitle alone, with or without numbering: "mockingjay part 1", "mockingjay", "the empire strikes back"
  if (body.length >= 2) {
    add(body.slice(1).join(" "));
    const tail = segments.slice(segments.indexOf(body[1]));
    add(tail.join(" "));
  }
  // "<Franchise> and the <Subtitle>": the subtitle alone names the film well enough.
  for (const seg of body) {
    const m = /^(.+?)\s+and\s+the\s+(.+)$/i.exec(seg);
    if (m && m[2].split(/\s+/).length >= 2) add(m[2]);
  }
  // Same numbering stripping on the flat form: "toy story 2" stays, but "harry potter and the deathly hallows part 2" -> without part
  for (const f of [...forms]) {
    const stripped = f.replace(NUMBERING, "");
    if (stripped !== f && stripped.length >= 6) forms.add(stripped);
  }
  return [...forms];
}

export type GuessVerdict = "correct" | "close" | "wrong";

function typoTolerance(len: number): number {
  if (len >= 16) return 3;
  if (len >= 10) return 2;
  if (len >= 6) return 1;
  return 0;
}

/** Compare a player's guess against the accepted answers (title + alternates). Generous with typos and subtitles. */
export function checkGuess(guess: string, answers: string[]): GuessVerdict {
  const g = canon(guess).replace(NUMBERING, (m) => m); // keep as typed
  if (g.length < 2) return "wrong";
  const gStripped = g.replace(NUMBERING, "");
  const guesses = new Set([g, gStripped]);

  let best = Infinity;
  let bestLen = 0;
  let close = false;
  for (const answer of answers) {
    for (const a of answerForms(answer)) {
      for (const gg of guesses) {
        if (gg === a) return "correct";
        if (bare(gg).length >= 6 && bare(gg) === bare(a)) return "correct";
        // Sequels: never let "Toy Story 2" fuzzy-match "Toy Story 3".
        const sameDigits = gg.replace(/\D/g, "") === a.replace(/\D/g, "");
        // "Alien" vs "Aliens": a different film, so a bare trailing s isn't a typo.
        const pluralOnly = gg + "s" === a || a + "s" === gg;
        const d = sameDigits && !pluralOnly ? levenshtein(gg, a) : Infinity;
        if (d < best) {
          best = d;
          bestLen = a.length;
        }
        if (pluralOnly) close = true;
        if (gg.length >= 6 && (a.includes(gg) || gg.includes(a))) close = true;
        // Right franchise, wrong number ("Toy Story 2" for "Toy Story 3") counts as close.
        if (!sameDigits && a.length >= 6 && levenshtein(gg.replace(/\d/g, ""), a.replace(/\d/g, "")) <= 1) close = true;
      }
    }
  }
  if (best <= typoTolerance(bestLen)) return "correct";
  const closeTolerance = bestLen >= 10 ? 4 : bestLen >= 6 ? 3 : bestLen >= 4 ? 1 : 0;
  if (best <= closeTolerance || close) return "close";
  return "wrong";
}

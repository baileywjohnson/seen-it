// Generate (or load from cache) the clue pack for one film and print it.
// Usage: npm run preview -- the-grand-budapest-hotel
import path from "node:path";
import dotenv from "dotenv";
import fs from "node:fs/promises";
import { generateCluePack } from "../clues/generate.js";
import { renderPng } from "../clues/drawing.js";
import { fetchFilmDetails } from "../letterboxd.js";
import { REPO_ROOT } from "../paths.js";

dotenv.config({ path: path.join(REPO_ROOT, ".env") });

const slug = process.argv[2];
if (!slug) {
  console.error("Usage: npm run preview -- <letterboxd-film-slug>   e.g. npm run preview -- perfect-days-2023");
  process.exit(1);
}

const started = Date.now();
try {
  const film = await fetchFilmDetails(slug);
  console.log(`${film.title} (${film.year}) dir. ${film.directors.join(", ")} — cast: ${film.cast.slice(0, 5).join(", ")}`);
  let lastStage = "";
  const pack = await generateCluePack(film, (p) => {
    const line = `${Math.round(p.fraction * 100)}% ${p.stage}`;
    if (line !== lastStage) {
      lastStage = line;
      process.stdout.write(`\r  ${line.padEnd(50)}`);
    }
  });
  process.stdout.write("\n");
  const outDir = path.join(REPO_ROOT, "data", "preview");
  await fs.mkdir(outDir, { recursive: true });
  for (const kind of ["scene", "sceneIconic", "posterSketch", "propSketch"] as const) {
    await fs.writeFile(path.join(outDir, `${slug}-${kind}.png`), renderPng(pack[kind].strokes));
  }
  console.log(`Drawings rendered to data/preview/${slug}-{scene,sceneIconic,posterSketch,propSketch}.png`);
  console.log(`\nClue pack ready in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log("Accepted answers:", [film.title, ...pack.altTitles].join(" | "));
  console.log("Director:", film.directors[0] ?? pack.director);
  const line = (label: string, x: { revealScore: number; fit: number }, body: string) =>
    console.log(`${x.fit < 5 ? "✗" : "✓"} ${label.padEnd(14)} reveal ${x.revealScore}/10  fit ${x.fit}/10  ${body}`);
  line("Location", pack.location, `${pack.location.kind}: ${pack.location.city}, ${pack.location.region}, ${pack.location.country}`);
  console.log(`✓ ${"Year".padEnd(14)} reveal ${pack.yearRevealScore}/10  fit 10/10  ${film.year}`);
  line("Scene", pack.scene, `${pack.scene.description} [${pack.scene.strokes.length} strokes]`);
  line("Iconic", pack.sceneIconic, `${pack.sceneIconic.description} [${pack.sceneIconic.strokes.length} strokes]`);
  line("Poster sketch", pack.posterSketch, `${pack.posterSketch.description} [${pack.posterSketch.strokes.length} strokes]`);
  line("Prop", pack.propSketch, `${pack.propSketch.description} [${pack.propSketch.strokes.length} strokes]`);
  line("Piano", pack.piano, `${pack.piano.songTitle} @ ${pack.piano.tempo} bpm, ${pack.piano.notes.length} notes${pack.piano.fit < 7 ? " (needs fit ≥ 7)" : ""}`);
  line("Cast", pack.cast, pack.cast.names.join(" → "));
  line("Characters", pack.characters, pack.characters.names.join(" → "));
  line("Director of", pack.directorFilms, pack.directorFilms.films.join(" → "));
  line("Emoji", pack.emoji, pack.emoji.emojis.join(" "));
  line("Quote", pack.quote, `"${pack.quote.text}"`);
  line("Tagline", pack.tagline, `"${pack.tagline.text}"`);
  line("Title emoji", pack.titleEmoji, pack.titleEmoji.emojis.join(" "));
  line("Plot, slowly", pack.plot, "");
  pack.plot.sentences.forEach((t, i) => console.log(`      ${i + 1}. ${t}`));
} catch (err) {
  console.error(`\nFailed after ${((Date.now() - started) / 1000).toFixed(1)}s:`, err instanceof Error ? err.message : err);
  process.exit(1);
}

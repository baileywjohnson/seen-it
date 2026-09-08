import type { CsvFilm } from "@shared";

/** Parse a Letterboxd export CSV (watched.csv, diary.csv, ratings.csv...). */
export function parseLetterboxdCsv(text: string): CsvFilm[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const nameIdx = header.indexOf("name");
  const yearIdx = header.indexOf("year");
  const uriIdx = header.indexOf("letterboxd uri");
  if (nameIdx < 0) return [];
  const films: CsvFilm[] = [];
  for (const row of rows.slice(1)) {
    const name = row[nameIdx]?.trim();
    if (!name) continue;
    const year = yearIdx >= 0 ? Number(row[yearIdx]) : NaN;
    films.push({ name, year: Number.isFinite(year) ? year : null, uri: uriIdx >= 0 ? row[uriIdx] || null : null });
  }
  return films;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

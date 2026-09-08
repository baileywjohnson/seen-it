# Seen It! 🎬

A party game for movie friends. Everyone uploads their Letterboxd `watched.csv`, the game picks films
**all of you have watched**, and then reveals clues about each film at the same time to everyone.
Type your guess as the clues unfold. Faster guesses (and beating your friends to it) score more,
skribbl.io style.

Clues are written per film by Claude and ordered from **least revealing to most revealing**, so the
first clue barely helps and the last one practically says the title.

## Clue types

| Clue | What players see |
| --- | --- |
| **Draw That Scene** | A memorable-but-not-obvious moment, sketched stroke by stroke by Claude |
| **Iconic Moment** | The image everyone associates with the film, sketched stroke by stroke |
| **Poster Sketch** | The poster's composition redrawn as a cartoon with every word removed |
| **Prop Department** | One iconic object, vehicle or costume piece, drawn alone like a museum exhibit |
| **Plot, Slowly** | Five sentences, one per beat, from "could be a hundred films" to unmistakable |
| **Who's Who** | Five character names, side characters first, protagonist last |
| **Casting Call** | Five cast members, least famous first |
| **From the Director Of** | The director's other films, least known first |
| **On Location / The Setting** | A cartoon map zooms in on the filming location, or the story's setting for animated and studio-bound films |
| **Release Date** | A film-strip timeline zooms in on the release year |
| **Vital Statistics** | Country, runtime, decade, genre: plain facts, one per beat (no AI involved) |
| **Name That Tune** | The main theme on a synth piano (only for films with a theme people actually hum) |
| **Plot in Emoji** | The plot in 5–8 emoji, revealed left to right |
| **Title in Emoji** | The title itself as an emoji rebus |
| **Famous Line** | The most quoted line with words un-redacted a few at a time |
| **The Tagline** | The real poster tagline, un-redacted a few words at a time |
| **Anagram** | The title's letters scrambled within each word, settling into place over the beats |
| **Fill in the Blanks** | The title as letter tiles, filling in from 25% to 85% of the letters |

Every clue lasts 15 seconds (configurable) and unfolds in 5 beats of 3 seconds, so guesses stagger
even within a single clue.

**Two scores per clue.** Claude rates every clue for *how revealing* it is (1–10) and for *fit*: whether
it genuinely points at this film at all. Clues with a fit under 5 (under 7 for the piano) are dropped, so
a film with no memorable music never wastes a round on a melody and an animated film gets its story's
setting instead of a soundstage. Vitals, anagram and blanks are computed by the server and always fit.

**Difficulty** (a lobby setting) decides how much of the low-reveal end of the range a round draws from:
*Cosy* starts from the middle so even the first clue helps, *Normal* skips the vaguest fifth, and
*Cinephile* starts from the very bottom. The last clue is always the most revealing one available, and
if nothing decisive survived the fit filter, a plot, characters or iconic-sketch clue is added so every
round can still be won. The real poster only appears on the reveal screen.

## Scoring

A correct guess earns `100 + 400 × (time remaining in the round)` plus a position bonus
(1st +150, 2nd +100, 3rd +50, others +25). The round ends early once everyone has guessed.
Close guesses get a private "close!" nudge; wrong guesses show up in chat for everyone.

Guess matching is deliberately generous: punctuation, articles and filler words are ignored, a typo or
two is fine on longer titles, number words and roman numerals match digits, and a subtitle on its own
("Mockingjay", "Fellowship of the Ring", "Deathly Hallows") counts, as does leaving off a "Part 1".
Sequel numbers still have to match ("Toy Story 2" for *Toy Story 3* is only "close").

## Running it

Requirements: Node 20+ and a Claude API key.

```bash
npm install
cp .env.example .env      # put your ANTHROPIC_API_KEY in .env
npm run dev               # server on :3000, Vite client on :5173
```

Open http://localhost:5173, create a theatre, and share the room link. For a LAN party, run the
production build so everything is served from one port:

```bash
npm run build
npm start                 # http://<your-ip>:3000
```

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | Your Claude API key (the SDK also picks up an `ant auth login` profile) |
| `ANTHROPIC_WORKSPACE_ID` | — | Needed for organization-level keys: the API replies "must include the anthropic-workspace-id header". Find the `wrkspc_…` id under Console → Settings → Workspaces |
| `CLAUDE_MODEL` | `claude-opus-5` | Model used to write clue packs |
| `CLAUDE_EFFORT` | `medium` | `low` / `medium` / `high` / `xhigh` / `max`. Medium generates a film in about a minute with drawings that hold up; `high` roughly doubles the time for a small gain |
| `CLAUDE_DRAW_REVIEW` | `1` | After each drawing, Claude looks at a render of it and returns a corrected version. Set `0` to skip (faster, rougher sketches) |
| `CLAUDE_FAST` | `1` | Use Opus fast mode when the account has it (2.5× faster output at a higher price). Falls back to standard automatically |
| `CLAUDE_CONCURRENCY` | `3` | Max simultaneous Claude calls. Halves automatically when the API rate-limits you and creeps back up afterwards |
| `MOCK_CLUES` | — | Set to `1` to play with placeholder clues and no API calls (handy for UI work) |
| `PORT` | `3000` | Server port |
| `DATA_DIR` | `./data` | Where watched lists, film details and clue packs are cached |

Clue packs are cached on disk per film, so repeat plays of the same film are free. Each film is
four parallel calls (text clues plus one per drawing); drawings are built from a shape vocabulary
(rects, ellipses, polygons, lines, paths) after a written composition plan, then rendered server-side
so Claude can review its own picture and fix it. The lobby quietly pre-generates a first film as soon
as someone uploads a watchlist, so "Roll film" usually starts within a second, and the next three films
generate while you play.

**Rate limits.** A film is five calls (text plus four drawings) and drawings are token-heavy, so smaller
API tiers can hit their output-tokens-per-minute cap. The server handles that rather than failing the
film: it halves its concurrency, waits out the limit with backoff for up to a few minutes (the loading
screen says "Claude is busy, retrying in Ns…"), generates upcoming films one after another instead of
in a burst, and only gives up after repeated failures. If you see it often, lower `CLAUDE_CONCURRENCY`
to 2 or check your tier's limits in the Console.

Use `npm run preview -- <letterboxd-slug>` to generate one film and see every clue with its scores;
the three drawings are written to `data/preview/` as PNGs. Requests to Claude
enable server-side refusal fallbacks (`fallbacks: "default"`), so a rare safety decline is retried on
a fallback model instead of failing the round.

## How the Letterboxd part works

Letterboxd has no public API and its Cloudflare front door blocks servers that scrape profiles, so
the game never reads member pages. Each player uploads their export instead:

1. Go to <https://letterboxd.com/settings/data/> and click **Export your data**.
2. Unzip the download and find `watched.csv` (the diary file is a different list).
3. In the lobby, click **Upload watched.csv**. Only titles and years are read.

Film metadata (director, cast, poster) is fetched from the film's Letterboxd page when possible and
cached. If that page can't be reached, the round still runs from the CSV's title and year and Claude
fills in the rest; only the reveal-screen poster is missing. Posters are proxied through the server
under an opaque token so the poster URL (which contains the title) never reaches players early.

## Deploying

The repo ships a two-stage `Dockerfile` and a `railway.json`. On Railway: `railway init`, add a
service with `ANTHROPIC_API_KEY` (and `ANTHROPIC_WORKSPACE_ID` if needed) and `PORT=3000`, then
`railway up` and `railway domain`. The disk cache lives in `/app/data` and is lost on redeploy unless
you attach a volume there.

## Project layout

```
shared/src/index.ts        Protocol + domain types shared by server and client
server/src/index.ts        Express + WebSocket entry point, poster proxy
server/src/game.ts         Room state machine: lobby → loading → clue → reveal → gameover
server/src/guess.ts        Fuzzy title matching (typos ok, sequels are not)
server/src/letterboxd.ts   CSV import, film details (best effort), poster fetch
server/src/clues/generate.ts   Claude clue-pack generation (structured output, disk cache)
client/src/clues/*         One renderer per clue type (canvas / SVG / WebAudio)
client/src/screens/*       Home, Lobby, Game, Loading, GameOver
```

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import dotenv from "dotenv";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "../../shared/src/index.js";
import { Room, posterStore } from "./game.js";
import { fetchPosterBytes } from "./letterboxd.js";
import { CLIENT_DIST, REPO_ROOT } from "./paths.js";

dotenv.config({ path: path.join(REPO_ROOT, ".env") });

const PORT = Number(process.env.PORT ?? 3000);
const rooms = new Map<string, Room>();

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
function newRoomCode(): string {
  for (;;) {
    let code = "";
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
}

const app = express();
app.disable("x-powered-by");

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, hasClaudeKey: !!process.env.ANTHROPIC_API_KEY });
});

app.get("/api/rooms/:code", (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ ok: false, message: "No such room" });
  res.json({ ok: true, code: room.code, players: room.players.size, phase: room.phase });
});

const posterCache = new Map<string, { bytes: Buffer; contentType: string }>();
app.get("/api/poster/:token", async (req, res) => {
  const url = posterStore.get(req.params.token);
  if (!url) return res.status(404).end();
  let img = posterCache.get(url);
  if (!img) {
    const fetched = await fetchPosterBytes(url);
    if (!fetched) return res.status(502).end();
    img = fetched;
    posterCache.set(url, img);
    if (posterCache.size > 200) posterCache.delete(posterCache.keys().next().value!);
  }
  res.setHeader("content-type", img.contentType);
  res.setHeader("cache-control", "private, max-age=3600");
  res.send(img.bytes);
});

if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get("*", (_req, res) => res.sendFile(path.join(CLIENT_DIST, "index.html")));
} else {
  app.get("/", (_req, res) =>
    res
      .type("text")
      .send("Seen It! server is running. In development open the Vite client (npm run dev), or run npm run build first."),
  );
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

interface Conn {
  room: Room | null;
  playerId: string | null;
  alive: boolean;
}

function sendTo(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on("connection", (ws) => {
  const conn: Conn = { room: null, playerId: null, alive: true };
  ws.on("pong", () => (conn.alive = true));

  ws.on("message", (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return sendTo(ws, { t: "error", message: "Bad message" });
    }
    if (msg.t === "join") {
      const code = msg.code ? msg.code.trim().toUpperCase() : newRoomCode();
      let room = rooms.get(code);
      if (!room) {
        if (msg.code) return sendTo(ws, { t: "error", message: `Room ${code} doesn't exist (or everyone left).` });
        room = new Room(code, (r) => rooms.delete(r.code));
        rooms.set(code, room);
        console.log(`[room ${code}] opened`);
      }
      if (conn.room && conn.playerId) conn.room.disconnect(conn.playerId, ws);
      const player = room.join(ws, String(msg.name ?? ""), String(msg.token ?? ""));
      conn.room = room;
      conn.playerId = player.id;
      return;
    }
    if (!conn.room || !conn.playerId) return sendTo(ws, { t: "error", message: "Join a room first" });
    conn.room.handle(conn.playerId, msg);
  });

  ws.on("close", () => {
    if (conn.room && conn.playerId) conn.room.disconnect(conn.playerId, ws);
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    const anyWs = ws as WebSocket & { _conn?: Conn };
    void anyWs;
    ws.ping();
  }
}, 25_000);

function onListenError(err: NodeJS.ErrnoException): void {
  if (err.code === "EADDRINUSE") {
    console.error(`\nPort ${PORT} is already in use. Stop the other process (lsof -ti:${PORT} | xargs kill) or set PORT=... in .env.\n`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
}
// The WebSocket server re-emits the HTTP server's errors, so both need a handler.
server.on("error", onListenError);
wss.on("error", onListenError);

server.listen(PORT, () => {
  console.log(`Seen It! server listening on http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("  (ANTHROPIC_API_KEY is not set - clue generation will use an `ant auth login` profile if present)");
  }
});

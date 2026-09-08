import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, ClientMessage, RoomState, ServerMessage } from "@shared";
import { storage } from "./storage";

const TOKEN_KEY = "nowshowing.token";
export const NAME_KEY = "nowshowing.name";

/** crypto.randomUUID only exists in secure contexts (not http://<lan-ip>, not older Safari on localhost). */
function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

let sessionToken: string | null = null;
function getToken(): string {
  if (sessionToken) return sessionToken;
  sessionToken = storage.get(TOKEN_KEY) ?? randomId();
  storage.set(TOKEN_KEY, sessionToken); // no-op when storage is blocked: identity then lasts for this page load
  return sessionToken;
}

export interface JoinParams {
  code: string | null;
  name: string;
}

export interface GameConnection {
  room: RoomState | null;
  playerId: string | null;
  chat: ChatMessage[];
  error: string | null;
  connected: boolean;
  /** Set while we are trying to (re)connect after a failure. */
  connectionProblem: string | null;
  lastGuess: { correct: boolean; close: boolean; points: number; at: number } | null;
  /** Add to Date.now() to get an estimate of the server's clock. */
  serverOffset: number;
  join: (params: JoinParams) => void;
  send: (msg: ClientMessage) => void;
  leave: () => void;
}

export function useGameConnection(): GameConnection {
  const [room, setRoom] = useState<RoomState | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectionProblem, setConnectionProblem] = useState<string | null>(null);
  const [lastGuess, setLastGuess] = useState<GameConnection["lastGuess"]>(null);
  const [serverOffset, setServerOffset] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const joinRef = useRef<JoinParams | null>(null);
  const retryRef = useRef(0);
  const everConnected = useRef(false);
  const closedByUser = useRef(false);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const connect = useCallback(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    wsRef.current = ws;
    ws.onopen = () => {
      setConnected(true);
      everConnected.current = true;
      setConnectionProblem(null);
      retryRef.current = 0;
      const j = joinRef.current;
      try {
        if (j) ws.send(JSON.stringify({ t: "join", code: j.code, name: j.name, token: getToken() }));
      } catch (err) {
        setError(`Couldn't join: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    ws.onerror = () => {
      if (!everConnected.current) setConnectionProblem("Can't reach the game server. Is it running on port 3000? Retrying…");
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      switch (msg.t) {
        case "welcome":
          setPlayerId(msg.playerId);
          setError(null);
          if (joinRef.current) joinRef.current = { ...joinRef.current, code: msg.code };
          history.replaceState(null, "", `?room=${msg.code}`);
          break;
        case "room":
          setRoom(msg.room);
          setServerOffset(msg.room.serverTime - Date.now());
          break;
        case "chat":
          setChat((c) => [...c.slice(-199), msg.msg]);
          break;
        case "guessResult":
          setLastGuess({ ...msg, at: Date.now() });
          break;
        case "error":
          setError(msg.message);
          if (!playerId) joinRef.current = null;
          break;
        case "kicked":
          setError(msg.reason);
          joinRef.current = null;
          setRoom(null);
          break;
        case "pong":
          setServerOffset(msg.serverTime - Date.now());
          break;
      }
    };
    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      if (closedByUser.current || !joinRef.current) return;
      const attempt = retryRef.current++;
      const delay = Math.min(8000, 500 * 2 ** attempt);
      setConnectionProblem(
        everConnected.current && attempt === 0
          ? "Lost the connection to the game server. Reconnecting…"
          : `Can't reach the game server${attempt ? ` (attempt ${attempt + 1})` : ""}. Is it running on port 3000? Retrying…`,
      );
      setTimeout(connect, delay);
    };
  }, [playerId]);

  const join = useCallback(
    (params: JoinParams) => {
      closedByUser.current = false;
      joinRef.current = params;
      setError(null);
      setChat([]);
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "join", code: params.code, name: params.name, token: getToken() }));
      } else if (!ws) connect();
    },
    [connect],
  );

  const leave = useCallback(() => {
    closedByUser.current = true;
    joinRef.current = null;
    send({ t: "leave" });
    wsRef.current?.close();
    setRoom(null);
    setPlayerId(null);
    setChat([]);
    history.replaceState(null, "", location.pathname);
  }, [send]);

  useEffect(() => {
    const id = setInterval(() => send({ t: "ping" }), 20_000);
    return () => clearInterval(id);
  }, [send]);

  return { room, playerId, chat, error, connected, connectionProblem, lastGuess, serverOffset, join, send, leave };
}

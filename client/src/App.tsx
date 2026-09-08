import { useEffect } from "react";
import { useGameConnection } from "./ws";
import { Home } from "./screens/Home";
import { Lobby } from "./screens/Lobby";
import { Game } from "./screens/Game";
import { GameOver } from "./screens/GameOver";
import { Loading } from "./screens/Loading";
import { Theatre } from "./components/Theatre";

export function App() {
  const conn = useGameConnection();
  const { room, playerId } = conn;

  useEffect(() => {
    document.title = room ? `Seen It! · ${room.code}` : "Seen It!";
  }, [room]);

  let screen: JSX.Element;
  if (!room || !playerId) screen = <Home conn={conn} />;
  else if (room.phase === "lobby") screen = <Lobby conn={conn} room={room} playerId={playerId} />;
  else if (room.phase === "loading") screen = <Loading room={room} />;
  else if (room.phase === "gameover") screen = <GameOver conn={conn} room={room} playerId={playerId} />;
  else screen = <Game conn={conn} room={room} playerId={playerId} />;

  return (
    <Theatre phase={room?.phase ?? "home"}>
      {room && conn.connectionProblem && <div className="conn-banner">⚠️ {conn.connectionProblem}</div>}
      {screen}
    </Theatre>
  );
}

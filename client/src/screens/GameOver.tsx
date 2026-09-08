import type { RoomState } from "@shared";
import { Confetti } from "../components/Confetti";
import { Marquee } from "../components/Theatre";
import { Tickets } from "../components/Tickets";
import type { GameConnection } from "../ws";

export function GameOver({ conn, room, playerId }: { conn: GameConnection; room: RoomState; playerId: string }) {
  const ranked = [...room.players].sort((a, b) => b.score - a.score);
  const [first, second, third] = ranked;
  const isHost = room.hostId === playerId;
  return (
    <>
      <Marquee title="THAT'S A WRAP" sub="final credits" />
      <div className="final">
      <Confetti burst={1} />
      <div className="podium">
        {second && <Spot rank={2} name={second.name} score={second.score} />}
        {first && <Spot rank={1} name={first.name} score={first.score} />}
        {third && <Spot rank={3} name={third.name} score={third.score} />}
      </div>
      <div className="final-list">
        <Tickets players={room.players} meId={playerId} showScore />
      </div>
      <div className="final-actions">
        {isHost ? (
          <button className="btn red big" onClick={() => conn.send({ t: "playAgain" })}>🎬 Play again</button>
        ) : (
          <div className="waiting" style={{ color: "var(--cream)" }}>Waiting for the host<span className="dotdot" /></div>
        )}
        <button className="btn small ghost" onClick={conn.leave}>Leave</button>
      </div>
      </div>
    </>
  );
}

function Spot({ rank, name, score }: { rank: number; name: string; score: number }) {
  const medal = ["🥇", "🥈", "🥉"][rank - 1];
  return (
    <div className="spot">
      <div className="who">{name}<div className="pts">{score}</div></div>
      <div className="block">{medal}</div>
    </div>
  );
}

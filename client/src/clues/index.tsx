import { clueLabel, type CluePhaseInfo } from "@shared";
import { useClueClock } from "./clock";
import { DrawingClue } from "./DrawingClue";
import { EmojiClue } from "./EmojiClue";
import { ListClue } from "./ListClue";
import { LocationClue } from "./LocationClue";
import { PianoClue } from "./PianoClue";
import { PlotClue } from "./PlotClue";
import { QuoteClue } from "./QuoteClue";
import { YearClue } from "./YearClue";
import { VitalsClue } from "./VitalsClue";
import { BlanksClue } from "./BlanksClue";
import { AnagramClue } from "./AnagramClue";

export function ClueStage({ clue, serverOffset }: { clue: CluePhaseInfo; serverOffset: number }) {
  const clock = useClueClock(clue, serverOffset);
  const p = clue.payload;
  let body: JSX.Element | null = null;
  switch (p.type) {
    case "location": body = <LocationClue payload={p} clock={clock} />; break;
    case "year": body = <YearClue payload={p} clock={clock} />; break;
    case "drawing": body = <DrawingClue payload={p} clock={clock} />; break;
    case "piano": body = <PianoClue payload={p} clock={clock} />; break;
    case "list": body = <ListClue payload={p} clock={clock} />; break;
    case "emoji": body = <EmojiClue payload={p} clock={clock} />; break;
    case "quote": body = <QuoteClue payload={p} clock={clock} />; break;
    case "plot": body = <PlotClue payload={p} clock={clock} />; break;
    case "vitals": body = <VitalsClue payload={p} clock={clock} />; break;
    case "blanks": body = <BlanksClue payload={p} clock={clock} />; break;
    case "anagram": body = <AnagramClue payload={p} clock={clock} />; break;
  }
  return (
    <>
      <div className="clue-title">{clueLabel(clue.clueType, p)}</div>
      <div className="stage-inner">{body}</div>
      <div className="timer-bar">
        {/* CSS-driven: starts mid-way for late joiners via a negative delay */}
        <div style={{ animationDuration: `${clock.duration}ms`, animationDelay: `-${clock.elapsedAtMount}ms` }} />
      </div>
    </>
  );
}

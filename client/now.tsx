import type { PluginTheme } from "@getpaseo/plugin";
import type { StewardState } from "../shared/steward";
import type { Tokens } from "./design";
import { inFlightInRecord, plain, stewardStatus, workersLabel, workersRunning } from "./model";
import { S } from "./strings";
import { Card, Fact, Line, StatusDot } from "./ui";

/**
 * The two facts, as a card: is the steward alive, and which workers run under it now. The panel and the
 * screen both open with this, so all surfaces read the same way the pill does.
 */
export function NowCard({ state, error, theme, t }: { state: StewardState | undefined; error?: unknown; theme: PluginTheme; t: Tokens }) {
  const status = error
    ? { kind: "none" as const, tone: "danger" as const, filled: false, label: S.pill.unreadable, detail: error instanceof Error ? error.message : String(error) }
    : stewardStatus(state);
  const workers = workersRunning(state);
  const recorded = inFlightInRecord(state).length;
  return (
    <Card theme={theme} t={t}>
      <Fact
        label={S.common.steward}
        value={status.label}
        detail={status.detail}
        tone={status.tone}
        lead={<StatusDot theme={theme} status={status} size={t.dot} />}
        theme={theme}
        t={t}
      />
      <Fact label={S.common.workers} value={workersLabel(workers.length)} theme={theme} t={t} />
      {workers.map((w, i) => (
        <Line key={w.id || i} text={plain(w.name)} trailing={w.provider} theme={theme} t={t} />
      ))}
      {state && recorded !== workers.length ? (
        <Line text={S.values.ledgerLine(recorded)} trailing={S.values.ledgerNote} theme={theme} t={t} />
      ) : null}
    </Card>
  );
}

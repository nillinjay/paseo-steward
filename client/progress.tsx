import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import { toneColor, type Tokens, type Tone } from "./design";
import { ago } from "./model";
import { S } from "./strings";
import { Card } from "./ui";

/**
 * The contract T-116 computes, copied verbatim from the brief. Client code may not import `shared/` for this
 * leg, so the shape lives here; when `shared/progress.ts` lands, replace this with a type import. The two
 * are structurally identical, so the swap changes no call site. See docs/design/progress-bar.md.
 */
export type ProgressSnapshot = {
  basis: "milestones" | "legs";
  percent: number; // 0..100, one decimal
  segments: { key: "accepted" | "inReview" | "inFlight" | "queued" | "blocked"; count: number }[];
  milestones: { total: number; done: number } | null;
  legs: { accepted: number; open: number };
  attention: { blocked: number; ownerQuestions: number; staleHours: number | null };
  estimated: boolean;
  label: string;
};

type SegmentKey = ProgressSnapshot["segments"][number]["key"];

/** Fixed reading order: done work first, blocked last, so the eye ends on what is stuck. */
const SEGMENT_ORDER: readonly SegmentKey[] = ["accepted", "inReview", "inFlight", "queued", "blocked"];

export type ProgressView = {
  /** Nothing to measure: no milestones and no legs. Never rendered as a 0 % bar. */
  empty: boolean;
  /** `~42.5%` when estimated. Floored to one decimal so display rounding can never overstate. */
  percent: string;
  /** Bar fill, 0..100. Only the drawing is clamped; the number above is shown as given, even if it fell. */
  fill: number;
  /** The single word the compact form shows, chosen by what most needs the owner. */
  word: { text: string; tone: Tone };
  /** One line about the work that is live right now; never a history count. */
  current: string;
  /** `null` means ordinary foreground, not a status colour. */
  currentTone: Tone | null;
  tally: string;
  stale: string | null;
  a11y: string;
};

function floorOneDecimal(n: number): number {
  return Math.floor(n * 10 + 1e-6) / 10;
}

/** Pure: every decision the bar makes, separate from pixels, so it can be checked without a screen. */
export function progressView(s: ProgressSnapshot): ProgressView {
  const empty = s.basis === "milestones" ? (s.milestones?.total ?? 0) === 0 : s.legs.accepted + s.legs.open === 0;
  const floored = floorOneDecimal(s.percent);
  const percent = `${s.estimated ? "~" : ""}${floored.toFixed(1)}%`;
  const fill = Math.min(100, Math.max(0, floored));
  const stale = s.attention.staleHours === null ? null : ago(Math.round(s.attention.staleHours * 60));
  const { blocked, ownerQuestions } = s.attention;
  const counts = new Map(s.segments.map((x) => [x.key, x.count]));
  const inFlight = counts.get("inFlight") ?? 0;
  const queued = counts.get("queued") ?? 0;
  // The owner's question is "what is happening now", so this line follows one priority:
  // something stuck, then live work, then a question only the owner can answer, then the queue.
  const current: ProgressView["current"] =
    blocked > 0 ? S.progress.current.blocked(blocked)
    : inFlight > 0 ? S.progress.current.inFlight(inFlight)
    : ownerQuestions > 0 ? S.progress.questions(ownerQuestions)
    : S.progress.current.queued(queued);
  const currentTone: ProgressView["currentTone"] =
    blocked > 0 ? "danger" : inFlight > 0 ? null : ownerQuestions > 0 ? "warning" : "muted";
  // The "~" already marks a guess, so the word slot goes to what needs action first.
  const word: ProgressView["word"] =
    blocked > 0 ? { text: S.progress.blockedWord, tone: "danger" }
    : ownerQuestions > 0 ? { text: S.progress.questionsWord, tone: "warning" }
    : stale ? { text: S.progress.staleWord, tone: "warning" }
    : empty ? { text: S.progress.emptyWord, tone: "muted" }
    : s.estimated ? { text: S.progress.estimated, tone: "muted" }
    : s.percent >= 100 ? { text: S.progress.done, tone: "success" }
    : { text: S.progress.milestones, tone: "muted" };
  const tally =
    s.basis === "milestones" && s.milestones
      ? S.progress.tallyMilestones(s.milestones.done, s.milestones.total)
      : S.progress.tallyLegs(s.legs.accepted, s.legs.open);
  return {
    empty,
    percent,
    fill,
    word,
    current,
    currentTone,
    tally,
    stale,
    a11y: empty ? S.progress.empty : S.a11y.progress(percent, s.estimated, blocked, ownerQuestions, stale),
  };
}

/**
 * Track, fill, and — when anything is blocked — a notch at the fill's leading edge: taller than the track,
 * so it reads as a shape and not only as a colour. Static; nothing animates.
 */
function Track({ fill, blocked, height, theme, t }: { fill: number; blocked: boolean; height: number; theme: PluginTheme; t: Tokens }) {
  const overhang = t.space.xs;
  return (
    <View style={{ height: height + overhang * 2, justifyContent: "center" }}>
      <View
        style={{
          height,
          borderRadius: height / 2,
          backgroundColor: theme.colors.surface2,
          borderWidth: 1,
          borderColor: theme.colors.border,
          overflow: "hidden",
        }}
      >
        <View style={{ width: `${fill}%`, height: "100%", backgroundColor: theme.colors.accent }} />
      </View>
      {blocked ? (
        <View
          style={{
            position: "absolute",
            left: `${fill}%`,
            top: 0,
            bottom: 0,
            width: 3,
            marginLeft: fill >= 100 ? -3 : fill <= 0 ? 0 : -1.5,
            borderRadius: 1.5,
            backgroundColor: theme.colors.statusDanger,
          }}
        />
      ) : null}
    </View>
  );
}

/** Sidebar form: bar, percent, one word. The percent never shrinks; the bar and the word give way first. */
function Compact({ view, blocked, theme, t }: { view: ProgressView; blocked: boolean; theme: PluginTheme; t: Tokens }) {
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={view.a11y}
      accessibilityValue={view.empty ? undefined : { min: 0, max: 100, now: view.fill }}
      style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}
    >
      {view.empty ? null : (
        <View style={{ flex: 1, minWidth: t.space.xl * 2 }}>
          <Track fill={view.fill} blocked={blocked} height={t.space.xs} theme={theme} t={t} />
        </View>
      )}
      {view.empty ? null : (
        <Text
          style={{
            color: theme.colors.foreground,
            fontSize: t.type.caption,
            lineHeight: t.line.caption,
            fontVariant: ["tabular-nums"],
            flexShrink: 0,
          }}
        >
          {view.percent}
        </Text>
      )}
      <Text
        style={{
          color: toneColor(theme, view.word.tone),
          fontSize: t.type.caption,
          lineHeight: t.line.caption,
          fontWeight: view.word.tone === "danger" ? "600" : undefined,
          flexShrink: 1,
        }}
        numberOfLines={1}
      >
        {view.word.text}
      </Text>
    </View>
  );
}

function Caption({ text, tone, theme, t, strong }: { text: string; tone?: Tone; theme: PluginTheme; t: Tokens; strong?: boolean }) {
  return (
    <Text
      style={{
        color: tone ? toneColor(theme, tone) : theme.colors.foregroundMuted,
        fontSize: t.type.caption,
        lineHeight: t.line.caption,
        fontWeight: strong ? "600" : undefined,
      }}
      selectable
    >
      {text}
    </Text>
  );
}

/**
 * The snapshot exposes milestone counts only (`done` / `total`), never the milestone rows or their IDs.
 * A checklist would therefore be a guess, so the legend below is the honest fallback the brief allows:
 * every segment with its own label and count, including the zeros.
 */
const SEGMENT_TONE: Record<SegmentKey, Tone | null> = {
  accepted: "success",
  inReview: "warning",
  inFlight: null,
  queued: "muted",
  blocked: "danger",
};

/** Screen form: the number and its basis, the bar, the live line, the segment legend, then attention. */
function Full({ snapshot, view, theme, t }: { snapshot: ProgressSnapshot; view: ProgressView; theme: PluginTheme; t: Tokens }) {
  const { blocked, ownerQuestions } = snapshot.attention;
  const counts = new Map(snapshot.segments.map((x) => [x.key, x.count]));
  const segments = SEGMENT_ORDER.map((key) => ({ key, count: counts.get(key) ?? 0 }));
  return (
    <Card theme={theme} t={t}>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel={view.a11y}
        accessibilityValue={view.empty ? undefined : { min: 0, max: 100, now: view.fill }}
        style={{ gap: t.space.xs }}
      >
        <View style={{ flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", gap: t.space.sm }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: t.type.caption, lineHeight: t.line.caption, fontWeight: "600" }}>
            {S.progress.title}
          </Text>
          {view.empty ? null : (
            <Text
              style={{
                color: theme.colors.foreground,
                fontSize: t.type.display,
                lineHeight: t.line.display,
                fontWeight: "600",
                fontVariant: ["tabular-nums"],
              }}
              selectable
            >
              {view.percent}
            </Text>
          )}
          {snapshot.estimated && !view.empty ? (
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: t.type.caption,
                lineHeight: t.line.caption,
                paddingHorizontal: t.space.xs,
                borderRadius: t.radius,
                borderWidth: 1,
                borderColor: theme.colors.border,
              }}
            >
              {S.progress.estimated}
            </Text>
          ) : null}
        </View>

        {view.empty ? (
          <>
            <Text style={{ color: theme.colors.foreground, fontSize: t.type.body, lineHeight: t.line.body }}>{S.progress.empty}</Text>
            <Caption text={S.progress.emptyDetail} theme={theme} t={t} />
          </>
        ) : (
          <>
            <Track fill={view.fill} blocked={blocked > 0} height={t.space.sm} theme={theme} t={t} />
            <Text
              numberOfLines={1}
              ellipsizeMode="tail"
              style={{
                color: view.currentTone ? toneColor(theme, view.currentTone) : theme.colors.foreground,
                fontSize: t.type.body,
                lineHeight: t.line.body,
                fontWeight: blocked > 0 ? "600" : undefined,
              }}
            >
              {view.current}
            </Text>
            <Caption text={view.tally} theme={theme} t={t} />
            {snapshot.estimated ? <Caption text={S.progress.estimatedNote} theme={theme} t={t} /> : null}
            <Text style={{ fontSize: t.type.caption, lineHeight: t.line.caption, fontVariant: ["tabular-nums"] }} selectable>
              {segments.map(({ key, count }, i) => (
                <Text
                  key={key}
                  style={{
                    color: SEGMENT_TONE[key] ? toneColor(theme, SEGMENT_TONE[key]!) : theme.colors.foreground,
                    fontWeight: key === "blocked" && count > 0 ? "600" : undefined,
                  }}
                >
                  {i > 0 ? " · " : ""}
                  {S.progress.segment[key]} {count}
                </Text>
              ))}
            </Text>
          </>
        )}

        {blocked > 0 ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm, marginTop: t.space.xs }}>
            <View style={{ width: 3, alignSelf: "stretch", borderRadius: 1.5, backgroundColor: theme.colors.statusDanger }} />
            <Caption text={S.progress.blocked(blocked)} tone="danger" strong theme={theme} t={t} />
          </View>
        ) : null}
        {ownerQuestions > 0 ? <Caption text={S.progress.questions(ownerQuestions)} tone="warning" theme={theme} t={t} /> : null}
        {view.stale ? <Caption text={S.progress.stale(view.stale)} tone="warning" theme={theme} t={t} /> : null}
      </View>
    </Card>
  );
}

/**
 * How far a supervised project has come. `compact` is the one-line sidebar form; the default is the full
 * screen form. `theme` and `t` follow every other component in `client/`: colour from the theme, size from
 * `tokens(layout.compact)`. The rationale for each channel is in docs/design/progress-bar.md.
 */
export function ProgressBar({
  snapshot,
  compact,
  theme,
  t,
}: {
  snapshot: ProgressSnapshot;
  compact?: boolean;
  theme: PluginTheme;
  t: Tokens;
}) {
  const view = progressView(snapshot);
  return compact ? (
    <Compact view={view} blocked={snapshot.attention.blocked > 0} theme={theme} t={t} />
  ) : (
    <Full snapshot={snapshot} view={view} theme={theme} t={t} />
  );
}

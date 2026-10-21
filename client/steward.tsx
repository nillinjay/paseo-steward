import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { progressGet } from "../shared/progress";
import type { ProjectSummary, StewardState } from "../shared/steward";
import { STEWARD_KEY, useProjects, useSteward, useStewardControl, useStewards } from "./data";
import { tokens, type Tokens } from "./design";
import { ago, canTakeOver, NOT_ONBOARDED, plain, shortEmployee, shortProjectName, stewardStatus } from "./model";
import { NowCard } from "./now";
import { ProgressBar } from "./progress";
import { S, serverMessage, warning } from "./strings";
import { Button, ChoiceChip, Fact, Line, Section, StatusDot } from "./ui";

/**
 * One chip per discovered project; the dot is that project's steward status. Hidden entirely for the
 * common single-project case, and always a wrapping row: short project names, never directory stamps.
 */
function ProjectPicker({
  projects,
  states,
  selected,
  onSelect,
  theme,
  t,
}: {
  projects: ProjectSummary[];
  states: Map<string, StewardState | undefined>;
  selected: string | undefined;
  onSelect: (root: string) => void;
  theme: PluginTheme;
  t: Tokens;
}) {
  if (projects.length < 2) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm, marginTop: t.space.lg }}>
      {projects.map((p) => {
        const active = p.root === selected;
        return (
          <Pressable
            key={p.root}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onSelect(p.root)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: t.space.sm,
              maxWidth: "100%",
              paddingHorizontal: t.space.md,
              paddingVertical: t.space.xs,
              borderRadius: t.radius,
              borderWidth: 1,
              borderColor: active ? theme.colors.accent : theme.colors.border,
              backgroundColor: active ? theme.colors.surface2 : theme.colors.surface1,
            }}
          >
            <StatusDot theme={theme} status={p.onboarded ? stewardStatus(states.get(p.root)) : NOT_ONBOARDED} size={t.dot} />
            <Text
              style={{
                color: active ? theme.colors.foreground : theme.colors.foregroundMuted,
                fontSize: t.type.body,
                lineHeight: t.line.body,
                flexShrink: 1,
              }}
              numberOfLines={1}
            >
              {shortProjectName(p.name || p.root)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Everything below the two facts. Current state first; history last and labelled as such. */
function AuditView({ state, theme, t }: { state: StewardState; theme: PluginTheme; t: Tokens }) {
  const perm = state.permissions;
  return (
    <>
      <Section title={S.sections.automaticAnswers} note={S.sections.automaticAnswersNote} theme={theme} t={t} />
      <Line text={S.values.auditRetention(perm.auditRetention)} tone="muted" theme={theme} t={t} />
      {perm.auditError ? <Line text={S.values.auditNotRecorded(perm.auditError)} tone="danger" theme={theme} t={t} /> : null}
      {perm.audit.length === 0 ? (
        <Line text={S.values.auditNone} tone="muted" theme={theme} t={t} />
      ) : perm.audit.map((a, i) => (
        <View key={`${a.attemptId}${i}`}>
          <Line
            text={S.values.auditText(S.auditDecision(a.decision), a.request, a.agentId.slice(0, 7))}
            trailing={S.values.auditTrailing(a.at, S.auditSource(a.source), null, plain(a.agentTitle))}
            theme={theme}
            t={t}
          />
          <Line
            text={S.values.auditStatus(a.delivery, a.recorded, a.error)}
            tone={!a.recorded || a.delivery === "failed" ? "danger" : a.delivery === "confirmed" ? undefined : "warning"}
            theme={theme}
            t={t}
          />
        </View>
      ))}
    </>
  );
}

function Detail({ state, theme, t }: { state: StewardState; theme: PluginTheme; t: Tokens }) {
  const perm = state.permissions;
  const history = [...state.dispatch].sort((a, b) => b.updated.localeCompare(a.updated));
  return (
    <>
      {state.questions.length > 0 ? (
        <>
          <Section title={S.sections.waiting(state.questions.length)} theme={theme} t={t} />
          {state.questions.map((q, i) => (
            <Line key={i} text={plain(q)} theme={theme} t={t} />
          ))}
        </>
      ) : null}

      {state.batch.length > 0 ? (
        <>
          <Section title={S.sections.currentBatch} theme={theme} t={t} />
          <Line text={state.batch.join(" · ")} theme={theme} t={t} />
        </>
      ) : null}

      {state.acceptance.length > 0 ? (
        <>
          <Section title={S.sections.acceptance} note={S.sections.acceptanceNote} theme={theme} t={t} />
          {state.acceptance.map((a) => {
            // The status word comes from the server when it has one: "no artifact" is not the same fact as
            // "never verified", and a leg accepted before we kept artifacts must not read as a failure.
            const ready = a.status ? a.status === "certified" : a.artifactExists && a.commitMatchesHead === true && a.allCommandsPassed;
            const trailing = a.status === "legacy-accepted"
              ? S.values.acceptanceLegacyAccepted
              : a.status === "legacy-artifact"
                ? S.values.acceptanceLegacyArtifact
                : !a.artifactExists
                  ? S.values.acceptanceUnverified
                  : a.commitMatchesHead !== true
                    ? S.values.acceptanceMismatch(a.sha ?? S.common.unknown)
                    : !a.allCommandsPassed
                      ? S.values.acceptanceCommandsFailed
                      : S.values.acceptanceReady;
            return (
              <Line
                key={a.task}
                // The headline must not contradict the state: a leg accepted before artifacts were kept has no
                // path to show, and printing "无产物：implemented, unverified" beside "已验收" is a lie
                // (owner's screenshot, 2026-10-20). Say what it is instead.
                text={`${plain(a.task)} · ${a.artifactPath
                  ?? (a.status === "legacy-accepted" ? S.values.acceptanceNoArtifactShort
                    : a.status === "legacy-artifact" ? S.values.acceptanceLegacyArtifact
                      : S.values.acceptanceUnverified)}`}
                trailing={trailing}
                tone={ready ? undefined : "warning"}
                theme={theme}
                t={t}
              />
            );
          })}
        </>
      ) : null}

      {state.warnings.length > 0 ? (
        <>
          <Section title={S.sections.warnings(state.warnings.length)} theme={theme} t={t} />
          {state.warnings.map((w, i) => (
            <Line key={i} text={warning(w)} tone="warning" theme={theme} t={t} />
          ))}
        </>
      ) : null}

      <Section title={S.sections.lease} theme={theme} t={t} />
      {state.lease ? (
        <>
          <Fact label={S.facts.state} value={state.lease.state} theme={theme} t={t} />
          <Fact label={S.facts.session} value={state.lease.session} theme={theme} t={t} />
          <Fact label={S.facts.since} value={state.lease.since} theme={theme} t={t} />
          <Fact
            label={S.facts.heartbeat}
            value={state.lease.heartbeat}
            detail={
              state.lease.heartbeatInFuture
                ? S.values.heartbeatFuture
                : S.values.heartbeatDetail(ago(state.lease.heartbeatAgeMinutes))
            }
            tone={state.lease.heartbeatInFuture ? "danger" : state.lease.stale ? "warning" : undefined}
            theme={theme}
            t={t}
          />
        </>
      ) : (
        <Fact label={S.facts.lease} value={S.values.noLease} tone="muted" theme={theme} t={t} />
      )}

      <Section title={S.sections.capacity} theme={theme} t={t} />
      <Fact
        label={S.facts.worktreeSlots}
        value={S.values.slotsUsed(state.workspaces.projectWorktrees, state.workspaces.cap)}
        tone={state.workspaces.projectWorktrees >= state.workspaces.cap ? "warning" : undefined}
        theme={theme}
        t={t}
      />
      {state.fork ? (
        <Fact
          label={S.facts.solverFork}
          value={`${state.fork.branch} @ ${state.fork.head}`}
          detail={state.fork.dirty > 0 ? S.values.forkDirty(state.fork.dirty) : S.values.clean}
          tone={state.fork.dirty > 0 ? "warning" : undefined}
          theme={theme}
          t={t}
        />
      ) : null}
      {state.git ? (
        <Fact
          label={S.facts.project}
          value={`${state.git.branch} @ ${state.git.head}`}
          detail={S.values.gitDetail(state.git.dirtyFiles, state.git.ahead, state.git.behind)}
          tone={state.git.dirtyFiles > 0 || state.git.behind > 0 ? "warning" : undefined}
          theme={theme}
          t={t}
        />
      ) : null}
      <Fact
        label={S.facts.lazy}
        value={state.config.lazyMode ? S.values.lazyOn : S.values.lazyOff}
        detail={state.config.workspace ? S.values.intoWorkspace(state.config.workspace) : S.values.noWorkspace}
        theme={theme}
        t={t}
      />
      <Fact
        label={S.facts.planExit}
        value={perm.autoAllowPlanExit ? S.values.planExitAllowed : S.values.planExitOff}
        detail={S.values.planExitDetail}
        theme={theme}
        t={t}
      />
      <Fact
        label={S.facts.questions}
        value={perm.autoDenyQuestions ? S.values.questionsDeclined : S.values.questionsOff}
        detail={S.values.questionsDetail}
        theme={theme}
        t={t}
      />
      <Fact
        label={S.facts.anythingElse}
        value={S.values.anythingElseValue}
        detail={S.values.anythingElseDetail}
        tone="muted"
        theme={theme}
        t={t}
      />

      <Section
        title={S.sections.pending(perm.readable ? String(perm.pending.length) : S.common.unknown)}
        theme={theme}
        t={t}
      />
      {perm.pending.length === 0 ? (
        <Line text={perm.readable ? S.values.pendingNone : S.values.pendingUnreadable} tone="muted" theme={theme} t={t} />
      ) : (
        perm.pending.map((p) => (
          <Line
            key={p.requestId}
            text={`${p.agentId.slice(0, 7)} ${p.request}`}
            trailing={S.values.pendingTrailing(S.kind(p.kind), S.agentStatus(p.agentStatus), plain(p.agentName))}
            tone={p.agentStatus === "idle" ? "warning" : undefined}
            theme={theme}
            t={t}
          />
        ))
      )}

      <AuditView state={state} theme={theme} t={t} />

      <Section title={S.sections.history} note={S.sections.historyNote} theme={theme} t={t} />
      <Fact
        label={S.facts.lastRun}
        value={state.ledger.lastRunId ?? S.values.lastRunNone}
        detail={state.ledger.lastExit !== null ? S.values.lastRunDetail(state.ledger.lastExit, state.ledger.rows) : undefined}
        tone="muted"
        theme={theme}
        t={t}
      />
      {state.merges.slice(0, 6).map((m, i) => (
        <Line key={`m${i}`} text={S.values.merged(plain(m.leg))} trailing={`${m.at} · ${m.commit}`} tone="muted" theme={theme} t={t} />
      ))}
      {history.map((r, i) => (
        <Line key={`d${i}`} text={plain(r.leg)} trailing={`${plain(r.status)} · ${shortEmployee(r.employee)} · ${r.updated}`} tone="muted" theme={theme} t={t} />
      ))}
    </>
  );
}

export function StewardScreen({ params, theme, layout }: PluginScreenProps) {
  const t = tokens(layout.compact);
  const projects = useProjects();
  const list = projects.data?.projects ?? [];
  const onboarded = list.filter((p) => p.onboarded);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  // Opening the screen again from a pill selects that pill's project.
  const requested = typeof params?.project === "string" ? params.project : undefined;
  useEffect(() => {
    if (requested) setPicked(requested);
  }, [requested]);
  const project = picked ?? requested ?? onboarded[0]?.root ?? list[0]?.root;
  const selected = list.find((p) => p.root === project);

  const all = useStewards(onboarded.map((p) => p.root));
  const states = new Map(onboarded.map((p, i) => [p.root, all[i]?.data]));
  const { data, error, isLoading, refetch } = useSteward(project);
  const control = useStewardControl();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const status = stewardStatus(data);
  // Keep the fixed takeover rule (T-113's F4) rather than the inline expression this leg forked from.
  const needsHandOver = canTakeOver(data);
  // The progress bar's one mount. Current state only: the RPC computes it on every read.
  const readProgress = useRpc(progressGet);
  const { data: progress } = useQuery({
    queryKey: [...STEWARD_KEY, "progress", project ?? null],
    queryFn: () => readProgress({ project }),
    enabled: Boolean(project),
    staleTime: 20_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const act = (input: Parameters<typeof control>[0]) => {
    setBusy(true);
    void control(input)
      .then((r) => setNote(serverMessage(r.message)))
      .catch((e: unknown) => setNote(serverMessage(e instanceof Error ? e.message : String(e))))
      .finally(() => setBusy(false));
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: t.space.xl }}>
      <Text
        style={{ color: theme.colors.foreground, fontSize: t.type.display, lineHeight: t.line.display, fontWeight: "600" }}
        numberOfLines={1}
      >
        {shortProjectName(selected?.name) || S.common.steward}
      </Text>
      <Text
        style={{ color: theme.colors.foregroundMuted, fontSize: t.type.caption, lineHeight: t.line.caption, marginTop: t.space.xxs }}
        numberOfLines={1}
        ellipsizeMode="middle"
      >
        {project ?? (projects.isLoading ? S.screen.discovering : S.screen.noProject)}
      </Text>

      <ProjectPicker projects={list} states={states} selected={project} onSelect={(root) => { setPicked(root); setNote(null); }} theme={theme} t={t} />

      <NowCard state={data} error={error} theme={theme} t={t} />

      {data?.onboarded && progress ? <ProgressBar snapshot={progress} theme={theme} t={t} /> : null}

      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: t.space.sm, marginTop: t.space.md }}>
        {needsHandOver ? (
          <Button label={S.actions.handOverNow} variant="primary" disabled={busy} onPress={() => act({ action: "tick-now", project })} theme={theme} t={t} />
        ) : null}
        <Button label={S.actions.refresh} disabled={busy} onPress={() => void refetch()} theme={theme} t={t} />
        {data?.onboarded ? (
          <ChoiceChip
            label={S.actions.lazyChip(data.config.lazyMode)}
            on={data.config.lazyMode}
            disabled={busy || !data.config.workspace}
            onPress={() => act({ action: "set-lazy", project, on: !data.config.lazyMode })}
            theme={theme}
            t={t}
          />
        ) : null}
        {data?.onboarded ? (
          <ChoiceChip
            label={S.actions.planChip(data.permissions.autoAllowPlanExit)}
            on={data.permissions.autoAllowPlanExit}
            disabled={busy}
            onPress={() => act({ action: "set-policy", project, policy: "plan", on: !data.permissions.autoAllowPlanExit })}
            theme={theme}
            t={t}
          />
        ) : null}
        {data?.onboarded ? (
          <ChoiceChip
            label={S.actions.shellChip(data.permissions.autoAllowShell)}
            on={data.permissions.autoAllowShell}
            disabled={busy}
            onPress={() => act({ action: "set-policy", project, policy: "shell", on: !data.permissions.autoAllowShell })}
            theme={theme}
            t={t}
          />
        ) : null}
        {data?.onboarded ? (
          <ChoiceChip
            label={S.actions.questionChip(data.permissions.autoDenyQuestions)}
            on={data.permissions.autoDenyQuestions}
            disabled={busy}
            onPress={() => act({ action: "set-policy", project, policy: "question", on: !data.permissions.autoDenyQuestions })}
            theme={theme}
            t={t}
          />
        ) : null}
        {data?.onboarded && data.permissions.pending.length > 0 ? (
          <Button label={S.actions.answerPending} disabled={busy} onPress={() => act({ action: "answer-pending", project })} theme={theme} t={t} />
        ) : null}
        {(data?.workspaces.stewardLike.length ?? 0) > 1 ? (
          <Button label={S.actions.archiveStray} disabled={busy} onPress={() => act({ action: "archive-stray" })} theme={theme} t={t} />
        ) : null}
      </View>
      {note ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: t.type.caption, lineHeight: t.line.caption, marginTop: t.space.sm }} selectable>
          {note}
        </Text>
      ) : null}

      {isLoading ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: t.type.body, lineHeight: t.line.body, marginTop: t.space.md }}>
          {S.screen.reading}
        </Text>
      ) : null}
      {data && !data.onboarded ? (
        <View style={{ gap: t.space.sm, marginTop: t.space.md }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: t.type.body, lineHeight: t.line.body }}>
            {S.screen.notOnboarded}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
            <Button
              label={S.actions.onboard}
              variant="primary"
              disabled={busy || !project}
              onPress={() => act({ action: "onboard", project })}
              theme={theme}
              t={t}
            />
          </View>
        </View>
      ) : null}
      {data?.onboarded ? <Detail state={data} theme={theme} t={t} /> : null}
      {data && !data.onboarded ? <AuditView state={data} theme={theme} t={t} /> : null}
      {data?.tick.lastPluginTickAt ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: t.type.caption, lineHeight: t.line.caption, marginTop: t.space.xl }} selectable>
          {S.screen.lastTick(data.tick.lastPluginTickAt, data.tick.lastPluginTickResult ? serverMessage(data.tick.lastPluginTickResult) : S.common.none)}
        </Text>
      ) : null}
    </ScrollView>
  );
}

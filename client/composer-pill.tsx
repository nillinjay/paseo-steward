import type {
  PluginButtonContentProps,
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { progressGet } from "../shared/progress";
import { STEWARD_KEY, useSteward, useStewardControl } from "./data";
import { tokens } from "./design";
import { canTakeOver, pillLabel, shortAgent, shortProjectName, stewardStatus, workersLabel, workersRunning, type StewardStatus } from "./model";
import { ProgressBar } from "./progress";
import { STEWARD_SCREEN } from "./screen-id";
import { S, serverMessage } from "./strings";
import { Button, Fact, StatusDot } from "./ui";

export const PILL_ID = "steward";

/** The project behind an agent's workspace, and its live steward state. Shared by the dot and the popover. */
function useProjectSteward(workspaceId: string) {
  const root = useWorkspace(workspaceId, (w) => w.projectRootPath);
  const query = useSteward(root ?? undefined);
  const status: StewardStatus = query.error
    ? { kind: "none", tone: "danger", filled: false, label: S.pill.unreadable, detail: query.error instanceof Error ? query.error.message : String(query.error) }
    : stewardStatus(query.data);
  return { root, status, workers: workersRunning(query.data), data: query.data };
}

/**
 * The pill's icon: one status dot, live. It also publishes the pill's label (`Steward` or `Steward · 2`)
 * through the registration, because a label is a string and cannot subscribe by itself.
 */
function PillDot({ workspaceId, theme, size, publish }: PluginButtonIconProps & { publish: (label: string) => void }) {
  const { status, workers } = useProjectSteward(workspaceId);
  const label = pillLabel(workers.length);
  useEffect(() => publish(label), [label, publish]);
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <StatusDot theme={theme} status={status} size={Math.round(size * 0.6)} />
    </View>
  );
}

/** Title, the two facts, one action. Nothing historical. */
function PillContent({
  workspaceId,
  theme,
  layout,
  close,
  openScreen,
}: PluginButtonContentProps & { openScreen: PluginClientContext["openScreen"] }) {
  const t = tokens(layout.compact);
  const name = useWorkspace(workspaceId, (w) => w.projectDisplayName);
  const { root, status, workers, data } = useProjectSteward(workspaceId);
  const control = useStewardControl();
  const readProgress = useRpc(progressGet);
  const { data: progress } = useQuery({
    queryKey: [...STEWARD_KEY, "progress", root ?? null],
    queryFn: () => readProgress({ project: root ?? undefined }),
    enabled: Boolean(root),
    staleTime: 20_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // 接管 is needed only when the project has NO steward. An old heartbeat is not an absence.
  const needsHandOver = Boolean(data?.onboarded && (!data.lease?.claimed || (data.agentsReadable && !data.lease.agentPresent)));
  const canHandOver = canTakeOver(data);
  const lazyMode = Boolean(data?.config.lazyMode);
  const hasWorkspace = Boolean(data?.config.workspace);
  // Loading is its own reason. Before the config arrives `hasWorkspace` is false only because nothing
  // has been read yet, so the caption must not claim the workspace is missing.
  const loading = status.kind === "loading";

  const toggleLazy = () => {
    if (!root) return;
    setBusy(true);
    void control({ action: "set-lazy", project: root, on: !lazyMode })
      .then((r) => setNote(serverMessage(r.message)))
      .catch((e: unknown) => setNote(serverMessage(e instanceof Error ? e.message : String(e))))
      .finally(() => setBusy(false));
  };

  const handOver = () => {
    setBusy(true);
    void control({ action: "tick-now", project: root ?? undefined })
      .then((r) => setNote(serverMessage(r.message)))
      .catch((e: unknown) => setNote(serverMessage(e instanceof Error ? e.message : String(e))))
      .finally(() => setBusy(false));
  };
  const open = () => {
    openScreen({ screenId: STEWARD_SCREEN, params: root ? { project: root } : {} });
    close();
  };

  return (
    <View style={{ gap: t.space.xs, minWidth: layout.compact ? undefined : 280 }}>
      <Text
        style={{
          color: theme.colors.foreground,
          fontSize: t.type.title,
          lineHeight: t.line.title,
          fontWeight: "600",
          marginBottom: t.space.xs,
        }}
        numberOfLines={1}
      >
        {shortProjectName(name) || S.common.steward}
      </Text>
      <Fact
        label={S.common.steward}
        value={status.label}
        detail={status.detail}
        tone={status.tone}
        lead={<StatusDot theme={theme} status={status} size={t.dot} />}
        theme={theme}
        t={t}
      />
      <Fact
        label={S.common.workers}
        value={workersLabel(workers.length)}
        detail={workers.length > 0 ? workers.map(shortAgent).join(" · ") : undefined}
        theme={theme}
        t={t}
      />
      {progress ? (
        <View style={{ marginTop: t.space.xxs }}>
          <ProgressBar snapshot={progress} compact theme={theme} t={t} />
        </View>
      ) : null}      {/*
        懒人模式: the one switch that turns supervision unattended. It sits beside the hand-over because
        both answer "who drives?" — the button says WHO, this says WHETHER anyone has to.
      */}
      <View style={{ marginTop: t.space.sm, gap: t.space.xs }}>
        <Button
          label={busy ? S.pill.lazyBusy : lazyMode ? S.pill.lazyOn : S.pill.lazyOff}
          variant={lazyMode ? "primary" : "secondary"}
          disabled={busy || loading || !root || !hasWorkspace}
          onPress={toggleLazy}
          theme={theme}
          t={t}
        />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: t.type.caption, lineHeight: t.line.caption }}>
          {loading ? S.pill.lazyLoading : hasWorkspace ? (lazyMode ? S.pill.lazyHintOn : S.pill.lazyHintOff) : S.pill.lazyNoWorkspace}
        </Text>
      </View>
      <View style={{ flexDirection: "row", gap: t.space.sm, marginTop: t.space.sm }}>
        {canHandOver ? (
          <Button label={busy ? S.pill.handingOver : S.pill.handOverNow} variant="primary" disabled={busy} onPress={handOver} theme={theme} t={t} />
        ) : null}
        <Button label={S.pill.open} onPress={open} theme={theme} t={t} />
      </View>
      {needsHandOver && !canHandOver ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: t.type.caption, lineHeight: t.line.caption }}>
          {S.pill.handoverOff}
        </Text>
      ) : null}
      {note ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: t.type.caption, lineHeight: t.line.caption }} selectable>
          {note}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * One Steward pill in every agent's composer, showing that agent's project. Every agent of a project
 * therefore shows the same single steward. A registration is kept across agent updates and replaced only
 * when the agent moves to another workspace, so status changes do not make the pill flicker.
 */
export function followAgents(client: PluginClientContext) {
  const pills = new Map<string, { workspaceId: string; registration: PluginButtonRegistration }>();
  let stopped = false;
  const lifetime = new AbortController();

  const register = (agent: { id: string; workspaceId?: string | null }) => {
    if (stopped || !agent.workspaceId) return;
    const workspaceId = agent.workspaceId;
    const existing = pills.get(agent.id);
    if (existing?.workspaceId === workspaceId) return;
    existing?.registration.remove();

    let current = pillLabel(0);
    let registration: PluginButtonRegistration | null = null;
    const publish = (label: string) => {
      if (label === current) return;
      current = label;
      registration?.update({ label });
    };
    const Icon = (props: PluginButtonIconProps) => <PillDot {...props} publish={publish} />;
    const Content = (props: PluginButtonContentProps) => <PillContent {...props} openScreen={client.openScreen} />;
    registration = client.addComposerPill({
      id: PILL_ID,
      workspaceId,
      agentId: agent.id,
      button: {
        title: S.pill.title,
        icon: Icon,
        label: current,
        behavior: { kind: "popover", Content },
      },
    });
    pills.set(agent.id, { workspaceId, registration });
  };

  const remove = (agentId: string) => {
    pills.get(agentId)?.registration.remove();
    pills.delete(agentId);
  };

  const removeAll = () => {
    for (const pill of pills.values()) pill.registration.remove();
    pills.clear();
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          removeAll();
          for (const entry of entries) register(entry.agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const payload = message.payload;
          if (payload.kind === "remove") return remove(payload.agentId);
          register(payload.agent);
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!stopped) console.error("Steward pill: agent observation failed", error);
    });

  return () => {
    stopped = true;
    lifetime.abort();
    removeAll();
  };
}

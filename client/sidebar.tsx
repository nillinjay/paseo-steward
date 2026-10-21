import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { useProjects, useStewards } from "./data";
import { tokens } from "./design";
import { stewardStatus, workersRunning, type StewardStatus } from "./model";
import { STEWARD_SCREEN } from "./screen-id";
import { S } from "./strings";
import { StatusDot } from "./ui";

const RANK: Record<StewardStatus["kind"], number> = { clock: 4, gone: 5, none: 4, working: 3, idle: 2, loading: 1 };

/**
 * Footer row across every onboarded project: the dot of the project that most needs attention, and the
 * number of workers running now. The same two facts as the pill, aggregated.
 */
export function StewardSidebarItem({ theme, layout, currentScreen, openScreen }: PluginSidebarItemProps) {
  const t = tokens(layout.compact);
  const { data } = useProjects();
  const roots = (data?.projects ?? []).filter((p) => p.onboarded).map((p) => p.root);
  const states = useStewards(roots);
  const statuses = states.map((q) => stewardStatus(q.data));
  const worst = statuses.reduce<StewardStatus>((a, b) => (RANK[b.kind] > RANK[a.kind] ? b : a), stewardStatus(undefined));
  const running = states.reduce((n, q) => n + workersRunning(q.data).length, 0);
  const alive = statuses.filter((s) => s.kind === "working" || s.kind === "idle").length;
  return (
    <SidebarRow
      icon="Activity"
      active={currentScreen?.screenId === STEWARD_SCREEN}
      onPress={() => openScreen({ screenId: STEWARD_SCREEN })}
      trailing={
        <View style={{ alignItems: "flex-end", gap: t.space.xxs }}>
          <View
            accessibilityLabel={S.a11y.sidebar(alive, roots.length, running)}
            style={{ flexDirection: "row", alignItems: "center", gap: t.space.xs }}
          >
            <StatusDot theme={theme} status={worst} size={t.dot} />
            {running > 0 ? (
              <Text
                style={{
                  color: theme.colors.foregroundMuted,
                  fontSize: t.type.caption,
                  lineHeight: t.line.caption,
                  fontVariant: ["tabular-nums"],
                }}
              >
                {running}
              </Text>
            ) : null}
          </View>
        </View>
      }
    />
  );
}

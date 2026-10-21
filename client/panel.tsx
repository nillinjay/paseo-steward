import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useWorkspace } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { Text } from "react-native";
import { useSteward } from "./data";
import { tokens } from "./design";
import { plain, shortProjectName } from "./model";
import { NowCard } from "./now";
import { S, warning } from "./strings";
import { Line, Section } from "./ui";

/** Lives beside agents and diffs on the project workspace: the two facts, then what needs the owner. */
export function StewardPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const t = tokens(layout.compact);
  const root = useWorkspace(workspaceId, (w) => w.projectRootPath);
  const name = useWorkspace(workspaceId, (w) => w.projectDisplayName);
  const { data, error } = useSteward(root ?? undefined);
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: t.space.xl }}>
      <Text
        style={{ color: theme.colors.foreground, fontSize: t.type.display, lineHeight: t.line.display, fontWeight: "600" }}
        numberOfLines={1}
      >
        {shortProjectName(name) || S.common.steward}
      </Text>
      <Text
        style={{ color: theme.colors.foregroundMuted, fontSize: t.type.caption, lineHeight: t.line.caption, marginTop: t.space.xxs }}
        numberOfLines={1}
        ellipsizeMode="middle"
      >
        {root ?? S.panel.resolving}
      </Text>

      <NowCard state={data} error={error} theme={theme} t={t} />

      {(data?.questions.length ?? 0) > 0 ? (
        <>
          <Section title={S.sections.waiting(data!.questions.length)} theme={theme} t={t} />
          {data!.questions.map((q, i) => (
            <Line key={i} text={plain(q)} theme={theme} t={t} />
          ))}
        </>
      ) : null}

      {(data?.warnings.length ?? 0) > 0 ? (
        <>
          <Section title={S.sections.warnings(data!.warnings.length)} theme={theme} t={t} />
          {data!.warnings.map((w, i) => (
            <Line key={i} text={warning(w)} tone="warning" theme={theme} t={t} />
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}

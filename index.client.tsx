import type { PluginClientContext } from "@getpaseo/plugin/client";
import { followAgents } from "./client/composer-pill";
import { StewardPanel } from "./client/panel";
import { STEWARD_SCREEN } from "./client/screen-id";
import { StewardSidebarItem } from "./client/sidebar";
import { StewardScreen } from "./client/steward";
import { S } from "./client/strings";

export default function contribute(client: PluginClientContext) {
  // One Steward pill in every agent's composer, beside Tasks and Subagents. It shows that agent's project:
  // a dot for "is the steward alive" and a count for "how many workers run under it", nothing else.
  const stopPills = followAgents(client);
  client.addScreen({ id: STEWARD_SCREEN, title: S.app.screenTitle, Component: StewardScreen });
  client.addSidebarFooterItem({ id: "steward", title: S.app.sidebarTitle, Component: StewardSidebarItem });
  client.addWorkspacePanel({
    id: "steward-panel",
    title: S.app.panelTitle,
    icon: "Activity",
    context: "workspace",
    Component: StewardPanel,
  });
  client.addCommandCenterItem({
    id: "open-steward",
    title: S.app.commandTitle,
    icon: "Activity",
    keywords: S.app.commandKeywords,
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: STEWARD_SCREEN });
    },
  });
  client.addSlashCommand({
    name: "steward",
    description: S.app.slashDescription,
    argumentHint: "",
    context: "agent",
    async onSubmit({ openScreen }) {
      openScreen({ screenId: STEWARD_SCREEN });
    },
  });
  return () => {
    stopPills();
  };
}

import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerGrants } from "./server/grants";
import { controlSteward, onPermissionRequested, onTurnEnded, readProjects, readSteward, registerProgress, startStewardTick } from "./server/steward";
import { stewardControl, stewardProjects, stewardRead } from "./shared/steward";

export default function contribute(server: PluginServerContext) {
  server.handle(stewardRead, readSteward);
  server.handle(stewardProjects, readProjects);
  server.handle(stewardControl, controlSteward);
  registerProgress(server);
  // V1.2 phase 1: state the environment once per leg, at agent creation, so the CLI stops asking command by command.
  const stopGrants = registerGrants(server);
  const stopPolicy = server.on("agent.permission_requested", onPermissionRequested);
  // The closed loop for 懒人模式: a worker's turn ends, the same steward session is woken.
  const stopTurns = server.on("agent.turn_ended", onTurnEnded);
  const stop = startStewardTick();
  return async () => {
    stopGrants();
    stopPolicy();
    stopTurns();
    stop();
  };
}

import { useRpc } from "@getpaseo/plugin/client";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { stewardControl, stewardProjects, stewardRead } from "../shared/steward";

export const STEWARD_KEY = ["paseo-steward"] as const;

/** Full state for ONE project. `project` is that project's root directory. */
export function useSteward(project: string | undefined) {
  const read = useRpc(stewardRead);
  return useQuery({
    queryKey: [...STEWARD_KEY, project ?? null],
    queryFn: () => read({ project }),
    enabled: Boolean(project),
    staleTime: 20_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * Full state for SEVERAL projects, sharing `useSteward`'s cache entries. The sidebar uses this so that it
 * derives "alive" and "running" with the same functions as the pill, rather than from the summary.
 */
export function useStewards(projects: readonly string[]) {
  const read = useRpc(stewardRead);
  return useQueries({
    queries: projects.map((project) => ({
      queryKey: [...STEWARD_KEY, project],
      queryFn: () => read({ project }),
      staleTime: 20_000,
      refetchInterval: 60_000,
      refetchOnWindowFocus: true,
    })),
  });
}

/** Cheap aggregate over every project the plugin knows, for the sidebar and the picker. */
export function useProjects() {
  const read = useRpc(stewardProjects);
  return useQuery({
    queryKey: [...STEWARD_KEY, "projects"],
    queryFn: () => read({}),
    staleTime: 20_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useStewardControl() {
  const control = useRpc(stewardControl);
  const cache = useQueryClient();
  return async (input: Parameters<typeof control>[0]) => {
    const result = await control(input);
    await cache.invalidateQueries({ queryKey: STEWARD_KEY });
    return result;
  };
}

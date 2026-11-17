import { existsSync } from "node:fs";
import path from "node:path";

/** Preserve the old catalog in place until a new catalog exists. */
export function resolveServerConfig(env: NodeJS.ProcessEnv, home: string) {
  const current = path.join(home, ".fansnipe");
  const legacy = path.join(home, ".streamsnipe");
  const dataDir =
    env.DATA_DIR ??
    (existsSync(path.join(current, "engine.sqlite"))
      ? current
      : existsSync(path.join(legacy, "engine.sqlite"))
        ? legacy
        : current);
  return {
    dataDir,
    mode:
      (env.FANSNIPE_MODE ?? env.STREAMSNIPE_MODE) === "docker"
        ? ("docker" as const)
        : ("desktop" as const),
  };
}

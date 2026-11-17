import { existsSync } from "node:fs";
import path from "node:path";

/** Preserve the old catalog in place until a new catalog exists. */
export function resolveServerConfig(env: NodeJS.ProcessEnv, home: string) {
  if (env.FANSNIPE_HOSTED_DASHBOARD === "true" && env.PUBLIC_ORIGIN)
    throw new Error("Hosted dashboard cannot be combined with PUBLIC_ORIGIN");
  const current = path.join(home, ".fansnipe");
  const legacy = path.join(home, ".streamsnipe");
  const dataDir =
    env.DATA_DIR ??
    (existsSync(path.join(current, "engine.sqlite"))
      ? current
      : existsSync(path.join(legacy, "engine.sqlite"))
        ? legacy
        : current);
  const defaultPasswordFile = "/run/secrets/fansnipe_studio_password";
  return {
    dataDir,
    studioPasswordFile:
      env.FANSNIPE_STUDIO_PASSWORD_FILE || defaultPasswordFile,
    hostedDashboard: env.FANSNIPE_HOSTED_DASHBOARD === "true",
    mode:
      (env.FANSNIPE_MODE ?? env.STREAMSNIPE_MODE) === "docker"
        ? ("docker" as const)
        : ("desktop" as const),
  };
}

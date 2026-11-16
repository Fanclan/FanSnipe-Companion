/** Recorder/tool supervisor keeps a shared catalog lease until its process tree exits. */
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
const [parentArg, leasePath, program, ...args] = process.argv.slice(2);
const parentPid = Number(parentArg);
if (!program || !leasePath || !Number.isInteger(parentPid)) process.exit(2);
const lease = new DatabaseSync(leasePath);
try {
  lease.exec("PRAGMA busy_timeout=0; BEGIN; SELECT * FROM gate");
  if (process.ppid !== parentPid) {
    lease.close();
    process.exit(1);
  }
} catch {
  lease.close();
  process.exit(1);
}
const child = spawn(program, args, {
  detached: true,
  stdio: ["ignore", "inherit", "ignore"],
});
let group = child.pid,
  stopping = false,
  completed = false;
function signal(sig: NodeJS.Signals) {
  if (group)
    try {
      process.kill(-group, sig);
    } catch {}
}
function stop(sig: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  signal(sig);
  setTimeout(() => signal("SIGKILL"), 5000).unref();
}
process.stdin.resume();
process.stdin.on("data", () => stop("SIGINT"));
process.stdin.on("end", () => stop("SIGTERM"));
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => stop(sig));
child.once("error", () => {
  if (!completed) {
    completed = true;
    lease.close();
    process.exit(1);
  }
});
child.once("close", async (code) => {
  if (completed) return;
  completed = true;
  if (stopping) await new Promise((resolve) => setTimeout(resolve, 500));
  signal("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 300));
  signal("SIGKILL");
  // Hold the shared lease until the process group no longer exists.
  if (group)
    for (;;) {
      try {
        process.kill(-group, 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch {
        break;
      }
    }
  lease.close();
  process.exit(code ?? (stopping ? 0 : 1));
});

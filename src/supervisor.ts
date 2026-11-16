/** POSIX recorder supervisor: parent pipe closure terminates the capture group. */
import { spawn } from "node:child_process";
const [program, ...args] = process.argv.slice(2);
if (!program) process.exit(2);
const child = spawn(program, args, {
  detached: true,
  stdio: ["ignore", "inherit", "ignore"],
});
let group = child.pid,
  stopping = false,
  completed = false;
function groupSignal(signal: NodeJS.Signals) {
  if (group)
    try {
      process.kill(-group, signal);
    } catch {}
}
function stop(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  groupSignal(signal);
  setTimeout(() => groupSignal("SIGKILL"), 5000).unref();
}
process.stdin.resume();
process.stdin.on("data", () => stop("SIGINT"));
process.stdin.on("end", () => stop("SIGTERM"));
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => stop(signal));
child.once("error", () => {
  if (!completed) {
    completed = true;
    process.exit(1);
  }
});
child.once("close", async (code) => {
  if (completed) return;
  completed = true;
  // A recorder may spawn ffmpeg; never leave descendants after its parent exits.
  if (stopping) await new Promise((resolve) => setTimeout(resolve, 500));
  groupSignal("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 300));
  groupSignal("SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 100));
  process.exit(code ?? (stopping ? 0 : 1));
});

import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

const keyBytes = 32;
const cost = { N: 32768, maxmem: 64 * 1024 * 1024 };
const maxPasswordBytes = 1024;
const stateKey = "studioPasswordVerifier";

function readStudioPassword(file?: string): Buffer | undefined {
  if (!file) return;
  const stat = statSync(file, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isFile() || stat.size > maxPasswordBytes + 5)
    throw Error(
      "Studio password file must contain one line of 8–1024 UTF-8 bytes",
    );
  // Text editors commonly add a UTF-8 BOM and a final CRLF. Spaces are part of the password.
  const text = readFileSync(file, "utf8")
    .replace(/^\uFEFF/, "")
    .replace(/\r?\n$/, "");
  const value = Buffer.from(text);
  if (
    value.length < 8 ||
    value.length > maxPasswordBytes ||
    /[\r\n\0]/.test(text)
  )
    throw Error(
      "Studio password file must contain one line of 8–1024 UTF-8 bytes",
    );
  return value;
}

// A folder may be mounted empty and populated later via the host. An invalid
// or unreadable file keeps this login method disabled while the operator fixes it.
function availableStudioPassword(file?: string): Buffer | undefined {
  try {
    return readStudioPassword(file);
  } catch {
    return undefined;
  }
}

function configureStudioPassword(db: DatabaseSync, secret?: Buffer) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS studio_password_sessions (id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE)",
  );
  const row = db.prepare("SELECT value FROM meta WHERE key=?").get(stateKey);
  const previous: { salt: string; verifier: string } | undefined = row
    ? JSON.parse(String(row.value))
    : undefined;
  const salt = previous ? Buffer.from(previous.salt, "hex") : randomBytes(16);
  const verifier = secret && scryptSync(secret, salt, keyBytes, cost);
  secret?.fill(0);

  if (previous?.verifier !== verifier?.toString("hex")) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(
        "DELETE FROM sessions WHERE id IN (SELECT id FROM studio_password_sessions)",
      );
      if (verifier) {
        db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run(
          stateKey,
          JSON.stringify({
            salt: salt.toString("hex"),
            verifier: verifier.toString("hex"),
          }),
        );
      } else db.prepare("DELETE FROM meta WHERE key=?").run(stateKey);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (!verifier) return;
  const attempts: { ip: string; at: number }[] = [];
  let inFlight = 0;
  return async (
    candidate: unknown,
    ip: string,
  ): Promise<"allowed" | "incorrect" | "limited"> => {
    const current = Date.now();
    while (attempts.length && current - attempts[0].at >= 60000)
      attempts.shift();
    if (
      inFlight >= 2 ||
      attempts.length >= 30 ||
      attempts.filter((a) => a.ip === ip).length >= 5
    )
      return "limited";
    attempts.push({ ip, at: current });
    if (
      typeof candidate !== "string" ||
      Buffer.byteLength(candidate) > maxPasswordBytes
    )
      return "incorrect";
    inFlight++;
    try {
      const key = await new Promise<Buffer>((resolve, reject) =>
        scrypt(candidate, salt, keyBytes, cost, (error, value) =>
          error ? reject(error) : resolve(value),
        ),
      );
      const matches = timingSafeEqual(key, verifier);
      key.fill(0);
      return matches ? "allowed" : "incorrect";
    } finally {
      inFlight--;
    }
  };
}

export function createStudioLogin(db: DatabaseSync, file?: string) {
  let verify = configureStudioPassword(db, availableStudioPassword(file));
  return {
    configured() {
      if (verify) return true;
      const secret = availableStudioPassword(file);
      if (!secret) return false;
      secret.fill(0);
      return true;
    },
    async unlock(password: unknown, ip: string) {
      if (!verify) {
        const secret = availableStudioPassword(file);
        if (secret) verify = configureStudioPassword(db, secret);
      }
      return verify ? verify(password, ip) : ("unconfigured" as const);
    },
  };
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { createEngine } from "../dist/app.js";

const password = "local studio password";
async function harness(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "fansnipe-studio-"));
  const file = join(dataDir, "password.txt");
  await writeFile(file, password + "\r\n");
  let engine;
  async function start(overrides = {}) {
    if (engine) await engine.stop();
    engine = createEngine({
      mode: "docker",
      dataDir,
      port: 0,
      monitor: false,
      setupToken: "operator-token",
      studioPasswordFile: file,
      ...options,
      ...overrides,
    });
    const address = await engine.start();
    return `http://127.0.0.1:${address.port}`;
  }
  t.after(async () => {
    if (engine) await engine.stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { start, file, engine: () => engine };
}

function request(base, route, method = "GET", headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + route, { method, headers }, (res) => {
      let text = "";
      res.on("data", (part) => (text += part));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text,
          json: () => JSON.parse(text),
        }),
      );
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const unlock = (base, pass, headers = { origin: base }) =>
  request(
    base,
    "/api/v1/studio/unlock",
    "POST",
    { "content-type": "application/json", ...headers },
    { password: pass },
  );
const access = (base, token) =>
  request(base, "/api/v1/settings", "GET", {
    authorization: `Bearer ${token}`,
  });

test("fresh Docker unlock uses local password and a revocable session", async (t) => {
  const h = await harness(t, { hostedDashboard: true });
  const base = await h.start();
  const info = (await request(base, "/api/v1/info")).json();
  assert.equal(info.capabilities?.studioPassword, true);
  assert.equal(info.studioPasswordConfigured, true);
  assert.equal((await unlock(base, "incorrect")).status, 401);
  const ok = await unlock(base, password);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["cache-control"], "no-store");
  const { token } = ok.json();
  assert.ok(token);
  assert.equal((await access(base, token)).status, 200);
  assert.equal(
    (
      await request(base, "/api/v1/sessions/revoke", "POST", {
        authorization: `Bearer ${token}`,
      })
    ).status,
    200,
  );
  assert.equal((await access(base, token)).status, 401);
});

test("password changes and removal revoke password sessions and preserve old pairings", async (t) => {
  const h = await harness(t);
  let base = await h.start();
  const pair = (
    await request(
      base,
      "/api/v1/pairings",
      "POST",
      { "content-type": "application/json" },
      { name: "Existing browser" },
    )
  ).json();
  h.engine().auth.approve(pair.id);
  const paired = (
    await request(base, `/api/v1/pairings/${pair.id}`, "GET", {
      "x-pairing-token": pair.pollToken,
    })
  ).json().token;
  const original = (await unlock(base, password)).json().token;
  base = await h.start();
  assert.equal((await access(base, original)).status, 200);
  await writeFile(h.file, "replaced local password\n");
  base = await h.start();
  assert.equal((await access(base, original)).status, 401);
  assert.equal((await access(base, paired)).status, 200);
  assert.equal((await unlock(base, password)).status, 401);
  const replacement = (await unlock(base, "replaced local password")).json()
    .token;
  assert.ok(replacement);
  base = await h.start({ studioPasswordFile: undefined });
  assert.equal((await access(base, replacement)).status, 401);
  assert.equal((await access(base, paired)).status, 200);
  assert.equal((await unlock(base, password)).status, 409);
  assert.equal(
    (await request(base, "/api/v1/info")).json().studioPasswordConfigured,
    false,
  );
});

test("Docker accepts password only on the bundled origin or configured HTTPS proxy", async (t) => {
  const h = await harness(t, { hostedDashboard: true });
  let base = await h.start();
  for (const headers of [
    {},
    { origin: "https://fansnipe.com" },
    { origin: "null" },
    { origin: "http://untrusted.example", host: "untrusted.example" },
    { origin: base, "sec-fetch-site": "cross-site" },
  ])
    assert.equal((await unlock(base, password, headers)).status, 403);
  base = await h.start({ hostedDashboard: false });
  assert.equal(
    (
      await unlock(base, password, {
        origin: "http://nas.local:47821",
        host: "nas.local:47821",
      })
    ).status,
    403,
  );
  base = await h.start({
    hostedDashboard: false,
    publicOrigin: "https://studio.example",
  });
  assert.equal(
    (
      await unlock(base, password, {
        origin: "https://studio.example",
        host: "studio.example",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await unlock(base, password, {
        origin: "https://studio.example",
        host: "other.example",
      })
    ).status,
    403,
  );
  base = await h.start({
    hostedDashboard: false,
    publicOrigin: "http://studio.example",
  });
  assert.equal(
    (
      await unlock(base, password, {
        origin: "http://studio.example",
        host: "studio.example",
      })
    ).status,
    403,
  );
});

test("Docker lockout limits guessing, including attempts with forwarded IP headers", async (t) => {
  const h = await harness(t);
  const base = await h.start();
  for (let i = 0; i < 5; i++)
    assert.equal(
      (
        await unlock(base, "incorrect", {
          origin: base,
          "x-forwarded-for": `192.0.2.${i}`,
        })
      ).status,
      401,
    );
  const limited = await unlock(base, password);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers["retry-after"]) > 0);
});

test("the Docker port opens the canonical local studio with the published port, or preserves a configured proxy origin", async (t) => {
  const h = await harness(t);
  let base = await h.start();
  let resp = await request(base, "/", "GET", { host: "localhost:47821" });
  assert.equal(resp.status, 302);
  assert.equal(resp.headers.location, "http://127.0.0.1:47821/app/");
  resp = await request(base, "/", "GET", { host: "localhost:38433" });
  assert.equal(resp.headers.location, "http://127.0.0.1:38433/app/");
  base = await h.start({ publicOrigin: "https://studio.example" });
  resp = await request(base, "/", "GET", { host: "studio.example" });
  assert.equal(resp.headers.location, "/app/");
  base = await h.start({ mode: "desktop" });
  assert.equal(
    (await request(base, "/api/v1/info")).json().capabilities.studioPassword,
    false,
  );
  assert.equal((await unlock(base, password)).status, 403);
});

test("an initially empty mounted secret directory can be configured during the same running container", async (t) => {
  const h = await harness(t);
  await rm(h.file);
  const base = await h.start();
  assert.equal(
    (await request(base, "/api/v1/info")).json().studioPasswordConfigured,
    false,
  );
  assert.equal((await unlock(base, password)).status, 409);
  await writeFile(h.file, password + "\n");
  assert.equal(
    (await request(base, "/api/v1/info")).json().studioPasswordConfigured,
    true,
  );
  const accepted = await unlock(base, password);
  assert.equal(accepted.status, 200);
  assert.equal((await access(base, accepted.json().token)).status, 200);
  await writeFile(h.file, "next start changes password");
  assert.equal((await unlock(base, password)).status, 200);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import http from "node:http";
import { createEngine } from "../dist/app.js";
import { resolveServerConfig } from "../dist/server-config.js";

const raw = (url, method, headers, body) =>
  new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode, json: async () => JSON.parse(data) }),
      );
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
const hosted = "https://fansnipe.com";
const json = { "content-type": "application/json" };
const post = (url, body, headers = {}) =>
  fetch(url, {
    method: "POST",
    headers: { ...json, ...headers },
    body: JSON.stringify(body),
  });
const socketResult = (url, origin, host, token) =>
  new Promise((resolve) => {
    const ws = new WebSocket(url, {
      origin,
      headers: host ? { Host: host } : undefined,
    });
    const timer = setTimeout(() => {
      ws.terminate();
      resolve("timeout");
    }, 2000);
    ws.once("error", () => {
      clearTimeout(timer);
      resolve("rejected");
    });
    ws.once("open", () => {
      if (token) ws.send(JSON.stringify({ type: "auth", token }));
      setTimeout(() => {
        const state = ws.readyState === WebSocket.OPEN ? "open" : "closed";
        ws.close();
        clearTimeout(timer);
        resolve(state);
      }, 100);
    });
  });

test("hosted bridge opt-in keeps setup token local and binds HTTP and WS Host", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-bridge-"));
  const dashboard = path.join(dir, "dashboard");
  await mkdir(dashboard);
  await writeFile(path.join(dashboard, "index.html"), "local");
  const e = createEngine({
    dataDir: dir,
    dashboardPath: dashboard,
    port: 0,
    mode: "docker",
    setupToken: "setup-secret",
    hostedDashboard: true,
    allowedOrigins: ["https://evil.example"],
    monitor: false,
  });
  try {
    const a = await e.start(),
      base = `http://127.0.0.1:${a.port}/api/v1`,
      ws = `ws://127.0.0.1:${a.port}/api/v1/events`,
      local = `http://127.0.0.1:${a.port}`;
    assert.equal(
      (await fetch(base + "/info", { headers: { origin: hosted } })).status,
      200,
    );
    assert.equal(
      (
        await fetch(base + "/info", {
          headers: { origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await raw(base + "/info", "GET", {
          origin: hosted,
          host: `attacker.example:${a.port}`,
        })
      ).status,
      403,
    );
    for (const origin of [
      "null",
      "https://www.fansnipe.com",
      "https://x.fansnipe.com",
      "https://fansnipe.com.evil.example",
      "http://fansnipe.com",
      "https://fansnipe.com:444",
    ]) {
      assert.equal(
        (await fetch(base + "/info", { headers: { origin } })).status,
        403,
      );
    }
    const preflight = await fetch(base + "/pairings", {
      method: "OPTIONS",
      headers: {
        origin: hosted,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), hosted);
    const localDashboard = await fetch(local + "/app/");
    assert.equal(localDashboard.headers.get("x-frame-options"), "DENY");
    assert.match(
      localDashboard.headers.get("content-security-policy"),
      /frame-ancestors 'none'/,
    );
    const pairResponse = await post(
      base + "/pairings",
      { name: "hosted browser" },
      { origin: hosted },
    );
    assert.equal(pairResponse.status, 201);
    assert.equal(pairResponse.headers.get("cache-control"), "no-store");
    const pair = await pairResponse.json();
    const setup = { "X-Setup-Token": "setup-secret" };
    assert.equal(
      (await fetch(base + `/pairings/${pair.id}/pending`, { headers: setup }))
        .status,
      200,
    );
    const pending = await (
      await fetch(base + `/pairings/${pair.id}/pending`, {
        headers: { ...setup, origin: local },
      })
    ).json();
    assert.deepEqual(pending, {
      id: pair.id,
      name: "hosted browser",
      code: pair.code,
      expiresAt: pair.expiresAt,
      origin: hosted,
    });
    assert.equal(JSON.stringify(pending).includes(pair.pollToken), false);
    assert.equal(
      (
        await fetch(base + `/pairings/${pair.id}/pending`, {
          headers: { ...setup, origin: hosted },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await post(
          base + `/pairings/${pair.id}/approve`,
          {},
          { ...setup, origin: hosted },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + `/pairings/${pair.id}/pending`, {
          headers: { "X-Setup-Token": "wrong" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await post(
          base + `/pairings/${pair.id}/approve`,
          {},
          { ...setup, origin: local },
        )
      ).status,
      200,
    );
    assert.equal(
      (await fetch(base + `/pairings/${pair.id}/pending`, { headers: setup }))
        .status,
      404,
    );
    assert.equal(
      (
        await fetch(base + `/pairings/${pair.id}`, {
          headers: { "X-Pairing-Token": "wrong", origin: hosted },
        })
      ).status,
      403,
    );
    const { token } = await (
      await fetch(base + `/pairings/${pair.id}`, {
        headers: { "X-Pairing-Token": pair.pollToken, origin: hosted },
      })
    ).json();
    assert.ok(token);
    assert.equal(
      (
        await fetch(base + `/pairings/${pair.id}`, {
          headers: { "X-Pairing-Token": pair.pollToken, origin: hosted },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(base + "/channels", { headers: { origin: hosted } })).status,
      401,
    );
    assert.equal(
      (
        await fetch(base + "/channels", {
          headers: { origin: hosted, authorization: `Bearer ${token}` },
        })
      ).status,
      200,
    );
    const unauthenticated = new WebSocket(ws, { origin: hosted });
    await new Promise((resolve, reject) => {
      unauthenticated.once("open", resolve);
      unauthenticated.once("error", reject);
    });
    const events = [];
    unauthenticated.on("message", (data) =>
      events.push(JSON.parse(data.toString())),
    );
    await post(
      base + "/channels",
      { name: "Fixture", url: "https://www.twitch.tv/example" },
      { origin: hosted, authorization: `Bearer ${token}` },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(events, []);
    unauthenticated.send(JSON.stringify({ type: "auth", token }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await post(
      base + "/channels",
      { name: "Fixture 2", url: "https://www.twitch.tv/other" },
      { origin: hosted, authorization: `Bearer ${token}` },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(events[0]?.type, "channel_update");
    unauthenticated.close();
    assert.equal(await socketResult(ws, hosted, undefined, token), "open");
    assert.equal(
      await socketResult(ws, "https://evil.example", undefined, token),
      "rejected",
    );
    assert.equal(
      await socketResult(ws, hosted, `evil.example:${a.port}`, token),
      "rejected",
    );
    const dest = {
      s3Enabled: true,
      s3Bucket: "mine",
      s3Region: "us-east-1",
      s3Endpoint: "http://127.0.0.1:9000",
    };
    const req = await (
      await post(base + "/settings/s3-approvals", dest, {
        origin: hosted,
        authorization: `Bearer ${token}`,
      })
    ).json();
    assert.equal(
      (
        await post(
          base + `/settings/s3-approvals/${req.id}/approve`,
          {},
          { ...setup, origin: hosted, authorization: `Bearer ${token}` },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await post(
          base + `/settings/s3-approvals/${req.id}/approve`,
          {},
          { ...setup, origin: local, authorization: `Bearer ${token}` },
        )
      ).status,
      200,
    );
  } finally {
    await e.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("bridge is off by default, incompatible with public origin before data access, and exact env opt-in", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-bridge-config-"));
  try {
    const target = path.join(dir, "must-not-exist");
    assert.throws(
      () =>
        createEngine({
          dataDir: target,
          mode: "docker",
          hostedDashboard: true,
          publicOrigin: "https://example.com",
        }),
      /HOSTED|hosted/i,
    );
    await assert.rejects(access(target));
    assert.equal(
      resolveServerConfig({ FANSNIPE_HOSTED_DASHBOARD: "true" }, dir)
        .hostedDashboard,
      true,
    );
    assert.throws(
      () =>
        resolveServerConfig(
          {
            FANSNIPE_HOSTED_DASHBOARD: "true",
            PUBLIC_ORIGIN: "https://docker.example",
          },
          dir,
        ),
      /HOSTED|hosted/i,
    );
    for (const v of ["TRUE", "1", "false", ""])
      assert.equal(
        resolveServerConfig({ FANSNIPE_HOSTED_DASHBOARD: v }, dir)
          .hostedDashboard,
        false,
      );
    const desktop = createEngine({
      dataDir: path.join(dir, "desktop"),
      port: 0,
      mode: "desktop",
      allowedOrigins: ["https://preview.example"],
      monitor: false,
    });
    try {
      const a = await desktop.start();
      assert.equal(
        (
          await fetch(`http://127.0.0.1:${a.port}/api/v1/info`, {
            headers: { origin: "https://preview.example" },
          })
        ).status,
        200,
      );
    } finally {
      await desktop.stop();
    }
    const e = createEngine({
      dataDir: path.join(dir, "off"),
      port: 0,
      mode: "docker",
      monitor: false,
      allowedOrigins: [hosted],
    });
    try {
      const a = await e.start();
      assert.equal(
        (
          await fetch(`http://127.0.0.1:${a.port}/api/v1/info`, {
            headers: { origin: hosted },
          })
        ).status,
        403,
      );
    } finally {
      await e.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pending details expire and local same-origin reverse proxy approval remains supported", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "fansnipe-bridge-expiry-"));
  const e = createEngine({
    dataDir: dir,
    port: 0,
    mode: "docker",
    setupToken: "local",
    publicOrigin: "https://docker.example",
    monitor: false,
  });
  try {
    const a = await e.start(),
      base = `http://127.0.0.1:${a.port}/api/v1`,
      headers = {
        host: "docker.example",
        origin: "https://docker.example",
        "X-Setup-Token": "local",
      };
    const p = await (
      await raw(
        base + "/pairings",
        "POST",
        { ...headers, ...json },
        { name: "remote same origin" },
      )
    ).json();
    assert.equal(
      (await raw(base + `/pairings/${p.id}/pending`, "GET", headers)).status,
      200,
    );
    const clock = t.mock.method(Date, "now", () => Date.parse(p.expiresAt) + 1);
    try {
      assert.equal(
        (await raw(base + `/pairings/${p.id}/pending`, "GET", headers)).status,
        404,
      );
      assert.equal(
        (
          await raw(
            base + `/pairings/${p.id}/approve`,
            "POST",
            { ...headers, ...json },
            {},
          )
        ).status,
        404,
      );
    } finally {
      clock.mock.restore();
    }
  } finally {
    await e.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

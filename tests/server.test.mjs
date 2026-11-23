import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startGui } from "../exporter/src/gui.mjs";

function request(port, { path = "/api/ping", method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("local server requires a session token", async (t) => {
  const { url, token, close } = await startGui({ port: 0, openBrowser: false, token: "test-token" });
  t.after(close);
  const port = Number(new URL(url).port);
  const base = `http://127.0.0.1:${port}`;

  const noToken = await fetch(`${base}/api/ping`);
  assert.equal(noToken.status, 401);

  const withToken = await fetch(`${base}/api/ping`, { headers: { "x-openstv-token": token } });
  assert.equal(withToken.status, 200);

  const page = await fetch(`${base}/?token=${token}`);
  assert.equal(page.status, 200);
  const csp = page.headers.get("content-security-policy") || "";
  assert.match(csp, /script-src 'nonce-/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
});

test("foreign Origin and Host are rejected", async (t) => {
  const { url, token, close } = await startGui({ port: 0, openBrowser: false, token: "test-token" });
  t.after(close);
  const port = Number(new URL(url).port);
  const base = `http://127.0.0.1:${port}`;

  const badOrigin = await fetch(`${base}/api/ping`, {
    headers: { "x-openstv-token": token, origin: "http://evil.example" },
  });
  assert.equal(badOrigin.status, 403);

  const badHost = await request(port, {
    path: "/api/ping",
    headers: { host: "evil.example", "x-openstv-token": token },
  });
  assert.equal(badHost.status, 403);

  const okHost = await request(port, {
    path: "/api/ping",
    headers: { host: `127.0.0.1:${port}`, "x-openstv-token": token },
  });
  assert.equal(okHost.status, 200);
});

test("API reads only paths selected by the user", async (t) => {
  const { url, token, close } = await startGui({ port: 0, openBrowser: false, token: "test-token" });
  t.after(close);
  const base = new URL(url).origin;
  const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
  const scan = await fetch(`${base}/api/scan`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-openstv-token": token },
    body: JSON.stringify({ dir: fixtures }),
  }).then((r) => r.json());
  assert.ok(scan.total >= 1);

  const trace = await fetch(`${base}/api/trace`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-openstv-token": token },
    body: JSON.stringify({ file: join(fixtures, "small.sor") }),
  });
  assert.equal(trace.status, 200);

  const outside = await fetch(`${base}/api/trace`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-openstv-token": token },
    body: JSON.stringify({ file: join(dirname(fixtures), "..", "package.json") }),
  });
  assert.equal(outside.status, 403);
});

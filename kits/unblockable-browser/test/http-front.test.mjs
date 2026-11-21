// Tests for the unblockable browser kit's browser-mcp-http.mjs. Run: node --test kits/unblockable-browser/test/http-front.test.mjs
// A real broker (bin/browser-broker.mjs) runs in front of a fake Browser MCP server (a small script in a temporary
// folder); the front under test talks to the broker. Everything is on loopback and no browser starts.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createBroker } from "../bin/browser-broker.mjs";
import { createFront, readSettings } from "../bin/browser-mcp-http.mjs";

const FRONT = fileURLToPath(new URL("../bin/browser-mcp-http.mjs", import.meta.url));
const dir = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "hf-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const TOKEN = "t".repeat(20) + "0123456789abcdef";

// The fake server logs what it reads to $FAKE_LOG; tools/call "slow" answers after 400 ms, "die" exits, "emit"
// sends a list-changed notice, "big" answers with 6 MB of text.
const FAKE = join(dir, "fake-server.mjs");
writeFileSync(FAKE, `
import { appendFileSync } from "node:fs";
let buf = "";
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
    appendFileSync(process.env.FAKE_LOG, JSON.stringify(m) + "\\n");
    if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-browser-mcp", version: "1", pid: process.pid } } });
    else if (m.method === "tools/list") out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "browser_navigate" }] } });
    else if (m.method === "tools/call") {
      const name = m.params?.name;
      if (name === "die") process.exit(3);
      if (name === "emit") out({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      const text = name === "big" ? "x".repeat(6 * 1024 * 1024) : "did " + name + " " + JSON.stringify(m.params?.arguments ?? {});
      const answer = () => out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }] } });
      if (name === "slow") setTimeout(answer, 400); else answer();
    }
  }
});
`);

let n = 0;
async function start(extra = {}) {
  n += 1;
  const log = join(dir, `server-${n}.log`);
  writeFileSync(log, "");
  const socketPath = join(dir, `b-${n}.sock`);
  const broker = createBroker({ socketPath, upstream: [process.execPath, FAKE], env: { ...process.env, FAKE_LOG: log } });
  await broker.listen();
  const front = createFront({ ...readSettings({ BROWSER_MCP_TOKEN: TOKEN, BROWSER_MCP_SOCKET: socketPath, BROWSER_MCP_HTTP_PORT: "0" }), ...extra });
  const addr = await front.listen();
  const url = `http://127.0.0.1:${addr.port}/mcp`;
  const seen = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { broker, front, url, seen, socketPath, stop: async () => (await front.close(), broker.close()) };
}

const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } };
const auth = { authorization: `Bearer ${TOKEN}` };
async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...auth, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
}
async function session(url) {
  const r = await post(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: INIT });
  assert.equal(r.status, 200);
  const sid = r.headers.get("mcp-session-id");
  assert.match(sid, /^[0-9a-f-]{36}$/);
  assert.equal((await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": sid })).status, 202);
  return { sid, init: r.body, call: (id, name, args = {}) => post(url, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, { "mcp-session-id": sid }) };
}

test("settings: a token of 32 characters or more is required, read from the environment or a file, never printed", () => {
  assert.throws(() => readSettings({ BROWSER_MCP_SOCKET: "/x.sock" }), /at least 32 characters/);
  assert.throws(() => readSettings({ BROWSER_MCP_TOKEN: "short", BROWSER_MCP_SOCKET: "/x.sock" }), (e) => /at least 32/.test(e.message) && !e.message.includes("short"));
  const file = join(dir, "token");
  writeFileSync(file, TOKEN + "\n");
  const s = readSettings({ BROWSER_MCP_TOKEN_FILE: file, BROWSER_ROOT: "/srv/ub", BROWSER_PROFILE: "browser" });
  assert.equal(s.token, TOKEN);
  assert.equal(s.socketPath, "/srv/ub/run/browser.sock");
  assert.equal(s.host, "127.0.0.1");
  assert.equal(s.port, 8930);
  assert.throws(() => readSettings({ BROWSER_MCP_TOKEN_FILE: join(dir, "missing") }), (e) => /could not be read \(ENOENT\)/.test(e.message));
  assert.throws(() => readSettings({ BROWSER_MCP_TOKEN: TOKEN, BROWSER_ROOT: "/srv/../etc", BROWSER_PROFILE: "browser" }), /plain absolute path/);
  assert.throws(() => readSettings({ BROWSER_MCP_TOKEN: TOKEN, BROWSER_MCP_SOCKET: "/x.sock", BROWSER_MCP_HTTP_PORT: "70000" }), /BROWSER_MCP_HTTP_PORT/);
});

test("a session: initialize, tools/list and a tool call go through the broker, under the client's own ids", async () => {
  const t = await start();
  try {
    const s = await session(t.url);
    assert.equal(s.init.id, 1);
    assert.equal(s.init.result.serverInfo.name, "fake-browser-mcp");
    const list = await post(t.url, { jsonrpc: "2.0", id: "list-1", method: "tools/list" }, { "mcp-session-id": s.sid });
    assert.equal(list.status, 200);
    assert.equal(list.headers.get("content-type"), "application/json");
    assert.deepEqual(list.body, { jsonrpc: "2.0", id: "list-1", result: { tools: [{ name: "browser_navigate" }] } });
    const call = await s.call(7, "browser_navigate", { url: "https://example.com/" });
    assert.equal(call.body.id, 7);
    assert.equal(call.body.result.content[0].text, 'did browser_navigate {"url":"https://example.com/"}');
    // Upstream, the ids are the broker's own and the server was initialized once.
    const seen = t.seen();
    assert.equal(seen.filter((m) => m.method === "initialize").length, 1);
    assert.ok(seen.filter((m) => m.method === "tools/call").every((m) => /^b\d+$/.test(m.id)));
  } finally {
    await t.stop();
  }
});

test("two sessions share the one server and their answers never cross", async () => {
  const t = await start();
  try {
    const a = await session(t.url);
    const b = await session(t.url);
    assert.notEqual(a.sid, b.sid);
    const [ra, rb] = await Promise.all([a.call(5, "slow", { who: "a" }), b.call(5, "browser_navigate", { who: "b" })]);
    assert.equal(ra.body.result.content[0].text, 'did slow {"who":"a"}');
    assert.equal(rb.body.result.content[0].text, 'did browser_navigate {"who":"b"}');
    assert.equal(t.seen().filter((m) => m.method === "initialize").length, 1);
  } finally {
    await t.stop();
  }
});

test("refusals: no token, a wrong token, a foreign origin, no session, an unknown session, GET, batches and non-JSON", async () => {
  const t = await start();
  try {
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: INIT };
    const none = await fetch(t.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(init) });
    assert.equal(none.status, 401);
    assert.equal(none.headers.get("www-authenticate"), "Bearer");
    assert.equal((await post(t.url, init, { authorization: `Bearer ${TOKEN}x` })).status, 401);
    assert.equal((await post(t.url, init, { authorization: TOKEN })).status, 401);
    assert.equal((await post(t.url, init, { origin: "https://evil.example" })).status, 403);
    assert.equal((await post(t.url, { jsonrpc: "2.0", id: 2, method: "tools/list" })).status, 400);
    const unknown = await post(t.url, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": "00000000-0000-0000-0000-000000000000" });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.id, 2);
    const get = await fetch(t.url, { headers: auth });
    assert.equal(get.status, 405);
    assert.equal((await post(t.url, [init])).status, 400);
    assert.equal((await post(t.url, "{not json")).status, 400);
    assert.equal((await post(t.url, init, { "content-type": "text/plain" })).status, 415);
    assert.equal((await post(t.url, "x".repeat(5 * 1024 * 1024))).status, 413);
    const s = await session(t.url);
    assert.equal((await post(t.url, init, { "mcp-session-id": s.sid })).status, 400);
    assert.equal((await fetch(t.url.replace("/mcp", "/other"), { headers: auth })).status, 404);
    // Nothing refused reached the server.
    assert.equal(t.seen().filter((m) => m.method === "tools/list").length, 0);
  } finally {
    await t.stop();
  }
});

test("an allowed origin passes; healthz answers without a token and says nothing else", async () => {
  const t = await start({ origins: ["https://strut.example"] });
  try {
    const r = await post(t.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: INIT }, { origin: "https://strut.example" });
    assert.equal(r.status, 200);
    const h = await fetch(t.url.replace("/mcp", "/healthz"));
    assert.equal(h.status, 200);
    assert.equal(await h.text(), "ok\n");
  } finally {
    await t.stop();
  }
  const gone = createFront(readSettings({ BROWSER_MCP_TOKEN: TOKEN, BROWSER_MCP_SOCKET: join(dir, "none.sock"), BROWSER_MCP_HTTP_PORT: "0" }));
  const addr = await gone.listen();
  try {
    const h = await fetch(`http://127.0.0.1:${addr.port}/healthz`);
    assert.equal(h.status, 503);
    const r = await post(`http://127.0.0.1:${addr.port}/mcp`, { jsonrpc: "2.0", id: 1, method: "initialize", params: INIT });
    assert.equal(r.status, 503);
    assert.equal(gone.sessions.size, 0);
  } finally {
    await gone.close();
  }
});

test("DELETE ends a session; the session cap refuses one more", async () => {
  const t = await start({ maxSessions: 2 });
  try {
    const a = await session(t.url);
    await session(t.url);
    const third = await post(t.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: INIT });
    assert.equal(third.status, 503);
    const del = await fetch(t.url, { method: "DELETE", headers: { ...auth, "mcp-session-id": a.sid } });
    assert.equal(del.status, 204);
    assert.equal((await a.call(2, "browser_navigate")).status, 404);
    await session(t.url);
  } finally {
    await t.stop();
  }
});

test("a server that ends answers the call with an error; the session's next call starts a new server", async () => {
  const t = await start();
  try {
    const s = await session(t.url);
    const died = await s.call(3, "die");
    assert.equal(died.status, 200);
    assert.equal(died.body.id, 3);
    assert.match(died.body.error.message, /ended|closed/);
    const again = await s.call(4, "browser_navigate");
    assert.equal(again.body.result.content[0].text, "did browser_navigate {}");
    assert.equal(t.seen().filter((m) => m.method === "initialize").length, 2);
  } finally {
    await t.stop();
  }
});

test("a call longer than the limit is answered with a timeout and cancelled upstream; big answers pass whole", async () => {
  const t = await start({ callMs: 100 });
  try {
    const s = await session(t.url);
    const slow = await s.call(9, "slow");
    assert.equal(slow.body.error.code, -32001);
    await new Promise((r) => setTimeout(r, 50));
    const cancel = t.seen().find((m) => m.method === "notifications/cancelled");
    assert.ok(cancel, "the cancel reached the server");
    assert.match(cancel.params.requestId, /^b\d+$/);
  } finally {
    await t.stop();
  }
  const u = await start();
  try {
    const s = await session(u.url);
    const big = await s.call(1, "big");
    assert.equal(big.body.result.content[0].text.length, 6 * 1024 * 1024);
  } finally {
    await u.stop();
  }
});

test("as a program: refuses to start without a token, and serves with one", async () => {
  const bad = spawn(process.execPath, [FRONT], { env: { PATH: process.env.PATH, BROWSER_MCP_SOCKET: "/x.sock" }, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  bad.stderr.on("data", (d) => (err += d));
  const [code] = await once(bad, "exit");
  assert.equal(code, 64);
  assert.match(err, /at least 32 characters/);
  const t = await start();
  await t.front.close();
  const prog = spawn(process.execPath, [FRONT], {
    env: { PATH: process.env.PATH, BROWSER_MCP_TOKEN: TOKEN, BROWSER_MCP_SOCKET: t.socketPath, BROWSER_MCP_HTTP_PORT: "0" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    let out = "";
    prog.stderr.setEncoding("utf8");
    const port = await new Promise((resolve, reject) => {
      prog.stderr.on("data", (d) => {
        out += d;
        const m = /listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/.exec(out);
        if (m) resolve(Number(m[1]));
      });
      prog.once("exit", () => reject(new Error(out)));
    });
    const s = await session(`http://127.0.0.1:${port}/mcp`);
    assert.equal((await s.call(1, "browser_navigate")).body.result.content[0].text, "did browser_navigate {}");
    assert.ok(!out.includes(TOKEN), "the token is never logged");
    assert.match(out, /tools\/call browser_navigate ok/);
  } finally {
    prog.kill("SIGTERM");
    await once(prog, "exit");
    t.broker.close();
  }
});

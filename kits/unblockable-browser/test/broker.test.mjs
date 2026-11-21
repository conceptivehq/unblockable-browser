// Tests for the unblockable browser kit's browser-broker.mjs. Run: node --test kits/unblockable-browser/test/broker.test.mjs
// A fake Browser MCP server (a small script in a temporary folder) stands in for the real one; nothing leaves the
// machine and no browser starts.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createBroker } from "../bin/browser-broker.mjs";

const BROKER = fileURLToPath(new URL("../bin/browser-broker.mjs", import.meta.url));
// Unix socket paths are short (104 bytes on macOS), and macOS's per-user temporary folder is long.
const dir = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "lb-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// The fake server: logs every message it reads to $FAKE_LOG, answers initialize, tools/list and tools/call, asks its
// client for a ping after notifications/initialized, and on tools/call "emit" sends tools/list_changed; "slow" answers
// after 300 ms; "die" exits.
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
    if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fake-browser-mcp", version: "1", pid: process.pid } } });
    else if (m.method === "notifications/initialized") out({ jsonrpc: "2.0", id: "srv-1", method: "ping" });
    else if (m.method === "tools/list") out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "browser_navigate" }, { name: "browser_snapshot" }] } });
    else if (m.method === "tools/call") {
      const name = m.params?.name;
      if (name === "die") process.exit(3);
      if (name === "emit") out({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      if (name === "progress") out({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: 1, progress: 1 } });
      const answer = () => out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "did " + name }] } });
      if (name === "slow") setTimeout(answer, 300); else answer();
    }
  }
});
`);

let n = 0;
async function startBroker() {
  n += 1;
  const log = join(dir, `server-${n}.log`);
  writeFileSync(log, "");
  const socketPath = join(dir, `browser-${n}.sock`);
  const broker = createBroker({ socketPath, upstream: [process.execPath, FAKE], env: { ...process.env, FAKE_LOG: log } });
  await broker.listen();
  const seen = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { broker, socketPath, seen };
}

/** One MCP client on the broker's socket: request() resolves with the answer to that id; notes holds notifications. */
async function client(socketPath) {
  const sock = net.createConnection(socketPath);
  await once(sock, "connect");
  const waiting = new Map();
  const notes = [];
  let buf = "";
  let closed = false;
  sock.setEncoding("utf8");
  sock.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (m.id !== undefined && waiting.has(m.id)) {
        waiting.get(m.id)(m);
        waiting.delete(m.id);
      } else notes.push(m);
    }
  });
  sock.on("close", () => (closed = true));
  return {
    sock,
    notes,
    get closed() {
      return closed;
    },
    send: (m) => sock.write(JSON.stringify(m) + "\n"),
    request(id, method, params = {}) {
      const p = new Promise((resolve) => waiting.set(id, resolve));
      sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return p;
    },
  };
}

const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await wait(20);
  }
}

test("two clients share one server: one initialize upstream, the same answer for both, ids kept apart", async () => {
  const { broker, socketPath, seen } = await startBroker();
  try {
    assert.equal(statSync(socketPath).mode & 0o777, 0o600);
    const a = await client(socketPath);
    const b = await client(socketPath);
    const [ia, ib] = await Promise.all([a.request(1, "initialize", INIT), b.request(1, "initialize", INIT)]);
    assert.equal(ia.id, 1);
    assert.equal(ib.id, 1);
    assert.deepEqual(ia.result, ib.result);
    assert.equal(ia.result.serverInfo.name, "fake-browser-mcp");
    a.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    b.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const [la, lb] = await Promise.all([a.request(2, "tools/list"), b.request(2, "tools/list")]);
    assert.equal(la.result.tools.length, 2);
    assert.equal(lb.result.tools.length, 2);
    const slow = a.request("x", "tools/call", { name: "slow" });
    const fast = await b.request("x", "tools/call", { name: "fast" });
    assert.equal(fast.result.content[0].text, "did fast", "b's answer is not a's");
    assert.equal((await slow).result.content[0].text, "did slow");

    await until(() => seen().some((m) => m.id === "srv-1"));
    const log = seen();
    assert.equal(log.filter((m) => m.method === "initialize").length, 1, "one initialize reached the server");
    assert.equal(log.filter((m) => m.method === "notifications/initialized").length, 1, "the broker sends its own, once");
    assert.deepEqual(log.find((m) => m.id === "srv-1"), { jsonrpc: "2.0", id: "srv-1", result: {} }, "the broker answered the server's ping");
    assert.ok(log.filter((m) => m.method === "tools/list").every((m) => typeof m.id === "string" && m.id.startsWith("b")));
    assert.ok(!a.notes.some((m) => m.method === "ping") && !b.notes.some((m) => m.method === "ping"), "clients never see the server's requests");

    await a.request(3, "tools/call", { name: "emit" });
    await until(() => b.notes.some((m) => m.method === "notifications/tools/list_changed"));
    assert.ok(a.notes.some((m) => m.method === "notifications/tools/list_changed"), "list changes go to every client");
    await a.request(4, "tools/call", { name: "progress" });
    await wait(100);
    assert.ok(![...a.notes, ...b.notes].some((m) => m.method === "notifications/progress"), "progress has no single owner and stops");
    a.sock.end();
    b.sock.end();
  } finally {
    broker.close();
  }
});

test("a client that leaves keeps the server; a cancel is passed on under the server's id", async () => {
  const { broker, socketPath, seen } = await startBroker();
  try {
    const a = await client(socketPath);
    await a.request(1, "initialize", INIT);
    const pid = broker.serverPid;
    a.request(7, "tools/call", { name: "slow" });
    a.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7, reason: "user" } });
    await until(() => seen().some((m) => m.method === "notifications/cancelled"));
    const cancel = seen().find((m) => m.method === "notifications/cancelled");
    const call = seen().find((m) => m.method === "tools/call");
    assert.equal(cancel.params.requestId, call.id);
    a.sock.destroy();
    await wait(100);
    const b = await client(socketPath);
    const init = await b.request(1, "initialize", INIT);
    assert.equal(broker.serverPid, pid, "the same server");
    assert.equal(init.result.serverInfo.pid, pid);
    b.sock.end();
  } finally {
    broker.close();
  }
});

test("the server ending answers what is pending, closes every client, and the next client starts a new one", async () => {
  const { broker, socketPath } = await startBroker();
  try {
    const a = await client(socketPath);
    const b = await client(socketPath);
    const first = await a.request(1, "initialize", INIT);
    await b.request(1, "initialize", INIT);
    const pending = b.request(2, "tools/call", { name: "slow" });
    const died = await Promise.race([a.request(2, "tools/call", { name: "die" }), pending]);
    assert.equal(died.error.code, -32000);
    assert.match(died.error.message, /server ended \(exit 3\)/);
    await until(() => a.closed && b.closed);
    const c = await client(socketPath);
    const again = await c.request(1, "initialize", INIT);
    assert.notEqual(again.result.serverInfo.pid, first.result.serverInfo.pid);
    c.sock.end();
  } finally {
    broker.close();
  }
});

test("listen replaces a stale socket and refuses a file that is not one", async () => {
  const path = join(dir, "stale.sock");
  const keep = net.createServer().listen(path);
  await once(keep, "listening");
  const b1 = createBroker({ socketPath: path, upstream: [process.execPath, FAKE] });
  await b1.listen();
  b1.close();
  keep.close();

  const plain = join(dir, "plain.sock");
  writeFileSync(plain, "not a socket");
  const b2 = createBroker({ socketPath: plain, upstream: [process.execPath, FAKE] });
  await assert.rejects(b2.listen(), /exists and is not a socket/);
  assert.equal(readFileSync(plain, "utf8"), "not a socket");
});

test("serve and connect as programs: the relay carries one client's stdio to the broker", async () => {
  const root = mkdtempSync(join(dir, "r-"));
  const log = join(dir, "program.log");
  writeFileSync(log, "");
  const upstream = join(dir, "upstream.sh");
  writeFileSync(upstream, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}"\n`, { mode: 0o755 });
  const env = { ...process.env, BROWSER_ROOT: root, BROWSER_PROFILE: "examplemarketing", FAKE_LOG: log };
  const serve = spawn(process.execPath, [BROKER, "serve", "--upstream", upstream], { env, stdio: ["ignore", "ignore", "pipe"] });
  try {
    const sock = join(root, "run", "examplemarketing.sock");
    let err = "";
    serve.stderr.on("data", (c) => (err += c));
    await until(() => err.includes("listening on"));
    assert.equal(statSync(join(root, "run")).mode & 0o777, 0o700);
    const relay = spawn(process.execPath, [BROKER, "connect", sock], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    relay.stdout.on("data", (c) => (out += c));
    relay.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: INIT }) + "\n");
    relay.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    await until(() => out.split("\n").filter(Boolean).length >= 2);
    const answers = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(answers.find((m) => m.id === 2).result.tools.length, 2);
    relay.stdin.end();
    const [code] = await once(relay, "exit");
    assert.equal(code, 0);
  } finally {
    serve.kill("SIGTERM");
    await once(serve, "exit");
  }
});

test("connect waits for a broker that is still starting; a relative path is refused", async () => {
  const path = join(dir, "late.sock");
  const relay = spawn(process.execPath, [BROKER, "connect", path], { stdio: ["pipe", "pipe", "pipe"] });
  await wait(500);
  const broker = createBroker({ socketPath: path, upstream: [process.execPath, FAKE], env: { ...process.env, FAKE_LOG: join(dir, "late.log") } });
  await broker.listen();
  try {
    let out = "";
    relay.stdout.on("data", (c) => (out += c));
    relay.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: INIT }) + "\n");
    await until(() => out.includes('"id":1'));
    relay.stdin.end();
    await once(relay, "exit");
  } finally {
    broker.close();
  }
  const missing = spawn(process.execPath, [BROKER, "connect", "relative.sock"], { stdio: "ignore" });
  const [code] = await once(missing, "exit");
  assert.equal(code, 64);
});

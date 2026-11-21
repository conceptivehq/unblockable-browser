#!/usr/bin/env node
// One browser's shared Browser MCP server (the unblockable browser kit, docs/unblockable-browser.md).
//
// Browser MCP speaks MCP over stdio, one client per process, and holds the browser's extension port while it runs. An
// agent can have several MCP clients at once: the Hermes gateway's own, and one per Codex thread when the profile runs
// on Codex's app-server, each started as soon as its thread opens. Started side by side, every server after the first
// would find the port taken. So each browser runs one broker (fleet-browser-mcp@<profile>.service):
//
//   serve    listens on <root>/run/<profile>.sock (mode 600, folder 700), starts the browser's real server
//            (bin/browser-server) when the first client arrives, answers every client's initialize from the
//            server's one answer, gives each forwarded request an id of its own and routes the answer back, answers
//            the server's own requests (ping, roots/list) itself, and passes list-changed notices to every client. A
//            client leaving keeps the server; the server ending closes every client, and the next client starts a
//            new one.
//   connect  <socket>: what bin/browser-mcp runs for Hermes or Codex; it relays stdio to the broker's socket.
//
// Messages are MCP's stdio framing: one JSON-RPC message per line. No dependencies; nothing listens on the network.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

const MAX_LINE = 64 * 1024 * 1024; // screenshots come back as base64 inside one line
const log = (...parts) => process.stderr.write(`browser-broker: ${parts.join(" ")}\n`);

/** Splits a byte stream into lines and calls onLine with each parsed message; ends the stream on oversize input. */
function lineReader(stream, onLine, onBad) {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buf += chunk;
    if (buf.length > MAX_LINE && !buf.includes("\n")) {
      onBad("a message longer than the limit");
      buf = "";
      return;
    }
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        onBad("a line that is not JSON");
        continue;
      }
      onLine(msg);
    }
  });
}

const isRequest = (m) => m && typeof m.method === "string" && m.id !== undefined && m.id !== null;
const isNotification = (m) => m && typeof m.method === "string" && (m.id === undefined || m.id === null);
const isResponse = (m) => m && m.method === undefined && m.id !== undefined;

/** Messages the broker passes from the server to every client. Others (progress, logging) have no single owner. */
const BROADCAST = new Set([
  "notifications/tools/list_changed",
  "notifications/resources/list_changed",
  "notifications/prompts/list_changed",
]);

export function createBroker({ socketPath, upstream, env = process.env }) {
  const clients = new Set();
  let server = null; // { proc, pending: Map<upstreamId, {client, id}>, init: {result?, waiting: [{client,id}]}, nextId }

  function send(target, msg) {
    if (target.writable) target.write(JSON.stringify(msg) + "\n");
  }

  function stopServer(reason) {
    if (!server) return;
    const s = server;
    server = null;
    log("the Browser MCP server ended:", reason);
    for (const { client, id } of s.pending.values()) {
      send(client, { jsonrpc: "2.0", id, error: { code: -32000, message: `the browser's server ended (${reason})` } });
    }
    for (const { client, id } of s.init.waiting) {
      send(client, { jsonrpc: "2.0", id, error: { code: -32000, message: `the browser's server ended (${reason})` } });
    }
    for (const client of clients) client.end();
    if (s.proc.exitCode === null && s.proc.signalCode === null) s.proc.kill("SIGTERM");
  }

  function startServer() {
    const [cmd, ...args] = upstream;
    const proc = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "inherit"] });
    const s = { proc, pending: new Map(), init: { result: undefined, error: undefined, sent: false, waiting: [] }, nextId: 1 };
    server = s;
    log("started the Browser MCP server, pid", String(proc.pid));
    proc.on("error", (err) => server === s && stopServer(`could not start: ${err.message}`));
    proc.on("exit", (code, signal) => server === s && stopServer(signal ? `signal ${signal}` : `exit ${code}`));
    proc.stdin.on("error", () => {});
    lineReader(proc.stdout, (msg) => fromServer(s, msg), (what) => log("the server sent", what));
    return s;
  }

  function toServer(s, msg) {
    if (s.proc.stdin.writable) s.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  function fromServer(s, msg) {
    if (isResponse(msg)) {
      if (msg.id === "broker-init") {
        if (msg.error) s.init.error = msg.error;
        else s.init.result = msg.result;
        for (const { client, id } of s.init.waiting.splice(0)) answerInit(s, client, id);
        if (msg.result) toServer(s, { jsonrpc: "2.0", method: "notifications/initialized" });
        return;
      }
      const route = s.pending.get(msg.id);
      if (!route) return;
      s.pending.delete(msg.id);
      send(route.client, { ...msg, id: route.id });
      return;
    }
    if (isRequest(msg)) {
      // The server asking its client: the broker answers for all of them.
      if (msg.method === "ping") toServer(s, { jsonrpc: "2.0", id: msg.id, result: {} });
      else if (msg.method === "roots/list") toServer(s, { jsonrpc: "2.0", id: msg.id, result: { roots: [] } });
      else toServer(s, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `the browser's broker does not answer ${msg.method}` } });
      return;
    }
    if (isNotification(msg) && BROADCAST.has(msg.method)) {
      for (const client of clients) send(client, msg);
    }
  }

  function answerInit(s, client, id) {
    if (s.init.error) send(client, { jsonrpc: "2.0", id, error: s.init.error });
    else send(client, { jsonrpc: "2.0", id, result: s.init.result });
  }

  function fromClient(client, msg) {
    if (isRequest(msg)) {
      const s = server ?? startServer();
      if (msg.method === "initialize") {
        if (s.init.result !== undefined || s.init.error !== undefined) return answerInit(s, client, msg.id);
        s.init.waiting.push({ client, id: msg.id });
        if (!s.init.sent) {
          s.init.sent = true;
          toServer(s, { ...msg, id: "broker-init" });
        }
        return;
      }
      const upstreamId = `b${s.nextId++}`;
      s.pending.set(upstreamId, { client, id: msg.id });
      toServer(s, { ...msg, id: upstreamId });
      return;
    }
    if (isNotification(msg) && msg.method === "notifications/cancelled" && server) {
      const requestId = msg.params?.requestId;
      for (const [upstreamId, route] of server.pending) {
        if (route.client === client && route.id === requestId) {
          toServer(server, { ...msg, params: { ...msg.params, requestId: upstreamId } });
          break;
        }
      }
    }
    // notifications/initialized (the broker sends its own once), answers to server requests (the broker answered
    // them) and anything else from a client stop here.
  }

  function dropClient(client) {
    clients.delete(client);
    if (!server) return;
    for (const [upstreamId, route] of server.pending) if (route.client === client) server.pending.delete(upstreamId);
    server.init.waiting = server.init.waiting.filter((w) => w.client !== client);
  }

  const listener = net.createServer((client) => {
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => dropClient(client));
    lineReader(client, (msg) => fromClient(client, msg), (what) => {
      log("a client sent", what, "and was closed");
      client.destroy();
    });
  });

  return {
    async listen() {
      if (existsSync(socketPath)) {
        if (!lstatSync(socketPath).isSocket()) throw new Error(`${socketPath} exists and is not a socket`);
        unlinkSync(socketPath);
      }
      await new Promise((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(socketPath, resolve);
      });
      chmodSync(socketPath, 0o600);
      log("listening on", socketPath);
    },
    close() {
      stopServer("the broker stopped");
      listener.close();
      try {
        unlinkSync(socketPath);
      } catch {}
    },
    get serverPid() {
      return server?.proc.pid ?? null;
    },
  };
}

function connect(socketPath, deadlineMs = 30_000) {
  const until = Date.now() + deadlineMs;
  const attempt = () => {
    const sock = net.createConnection(socketPath);
    sock.once("connect", () => {
      process.stdin.pipe(sock);
      sock.pipe(process.stdout);
      process.stdin.on("end", () => sock.end());
      sock.on("close", () => process.exit(0));
    });
    sock.once("error", (err) => {
      if (Date.now() < until && (err.code === "ENOENT" || err.code === "ECONNREFUSED")) return setTimeout(attempt, 200);
      log("cannot reach", socketPath + ":", err.message);
      process.exit(69);
    });
  };
  attempt();
}

async function main(argv) {
  const [mode, ...rest] = argv;
  const flag = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (mode === "connect") {
    const socketPath = rest[0];
    if (!socketPath || !socketPath.startsWith("/")) {
      log("usage: browser-broker.mjs connect <absolute socket path>");
      process.exit(64);
    }
    return connect(socketPath);
  }
  if (mode !== "serve") {
    log("usage: browser-broker.mjs serve [--socket <path>] [--upstream <command>] | connect <socket>");
    process.exit(64);
  }
  const root = process.env.BROWSER_ROOT ?? "";
  const profile = process.env.BROWSER_PROFILE ?? "";
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(profile)) {
    log("BROWSER_PROFILE must match ^[a-z0-9][a-z0-9-]{0,40}$");
    process.exit(64);
  }
  if (!/^\/[A-Za-z0-9._/-]+$/.test(root) || root.includes("..")) {
    log("BROWSER_ROOT must be a plain absolute path");
    process.exit(64);
  }
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  chmodSync(runDir, 0o700);
  const socketPath = flag("--socket") ?? join(runDir, `${profile}.sock`);
  const upstream = flag("--upstream") ? [flag("--upstream")] : [join(root, "bin", "browser-server")];
  const broker = createBroker({ socketPath, upstream });
  await broker.listen();
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      broker.close();
      process.exit(0);
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    log(err.message);
    process.exit(1);
  });
}

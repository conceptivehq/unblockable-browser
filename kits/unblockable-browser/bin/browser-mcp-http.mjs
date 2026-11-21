#!/usr/bin/env node
// One browser's MCP over HTTP (the unblockable browser kit, docs/unblockable-browser.md, "MCP over HTTP").
//
// Browser MCP speaks MCP over stdio. The browser's broker (bin/browser-broker.mjs) shares that one server between
// clients on a Unix socket. This front gives remote clients, such as a Strut server's MCP browser, the same server over
// MCP's Streamable HTTP transport, behind a bearer token:
//
//   POST   /mcp       one JSON-RPC message. An initialize opens a session (its id comes back in Mcp-Session-Id),
//                     and the session gets a broker connection of its own. A request is answered as one
//                     application/json body. A notification or a response is accepted with 202.
//   DELETE /mcp       ends the session named in Mcp-Session-Id.
//   GET    /mcp       405: the front opens no server-to-client stream, so the server's own notices (list changed)
//                     are not passed on.
//   GET    /healthz   200 "ok" when the broker's socket is there, 503 when it is not. No token, and nothing else.
//
// Every /mcp call needs `Authorization: Bearer <token>`. The token comes from BROWSER_MCP_TOKEN, or from the file
// named by BROWSER_MCP_TOKEN_FILE, and is at least 32 characters; the front never starts without one and never
// prints it. A request with an Origin header is refused unless the origin is listed in BROWSER_MCP_ALLOWED_ORIGINS.
// The front speaks plain HTTP: keep it on loopback or a private network, or put TLS in front of it.
//
// Settings: BROWSER_ROOT and BROWSER_PROFILE (the socket is <root>/run/<profile>.sock) or BROWSER_MCP_SOCKET;
// BROWSER_MCP_HTTP_HOST (default 127.0.0.1) and BROWSER_MCP_HTTP_PORT (default 8930); BROWSER_MCP_SESSIONS (most
// open sessions, default 16); BROWSER_MCP_IDLE_MS (a session's idle limit, default 30 minutes); BROWSER_MCP_CALL_MS
// (the longest one call may take, default 10 minutes). It logs method, tool name, status and time, never arguments
// or answers. No dependencies; Node 18 or newer.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_BODY = 4 * 1024 * 1024; // requests are small; screenshots come back in answers, which have no limit here
const MAX_LINE = 64 * 1024 * 1024; // the broker's own limit for one message
const MIN_TOKEN = 32;
const log = (...parts) => process.stderr.write(`browser-mcp-http: ${parts.join(" ")}\n`);
const digest = (s) => createHash("sha256").update(String(s)).digest();

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const isObject = (m) => m !== null && typeof m === "object" && !Array.isArray(m);
const hasId = (m) => m.id !== undefined && m.id !== null;
const isRequest = (m) => typeof m.method === "string" && hasId(m);
const isNotification = (m) => typeof m.method === "string" && !hasId(m);
const isResponse = (m) => m.method === undefined && hasId(m) && ("result" in m || "error" in m);

/** Reads and checks the settings. Throws a message that never holds the token. */
export function readSettings(env = process.env) {
  let token = env.BROWSER_MCP_TOKEN || "";
  if (!token && env.BROWSER_MCP_TOKEN_FILE) {
    try {
      token = readFileSync(env.BROWSER_MCP_TOKEN_FILE, "utf8").trim();
    } catch (err) {
      throw new Error(`BROWSER_MCP_TOKEN_FILE could not be read (${err.code ?? "error"})`);
    }
  }
  if (token.length < MIN_TOKEN) throw new Error(`a token of at least ${MIN_TOKEN} characters must be set (BROWSER_MCP_TOKEN or BROWSER_MCP_TOKEN_FILE)`);
  if (/\s/.test(token)) throw new Error("the token must not hold whitespace");
  let socketPath = env.BROWSER_MCP_SOCKET || "";
  if (!socketPath) {
    const root = env.BROWSER_ROOT ?? "";
    const profile = env.BROWSER_PROFILE ?? "";
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(profile)) throw new Error("BROWSER_PROFILE must match ^[a-z0-9][a-z0-9-]{0,40}$");
    if (!/^\/[A-Za-z0-9._/-]+$/.test(root) || root.includes("..")) throw new Error("BROWSER_ROOT must be a plain absolute path");
    socketPath = join(root, "run", `${profile}.sock`);
  }
  if (!socketPath.startsWith("/")) throw new Error("BROWSER_MCP_SOCKET must be an absolute path");
  const int = (name, d, min, max) => {
    const v = env[name] === undefined || env[name] === "" ? d : Number(env[name]);
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
    return v;
  };
  const origins = (env.BROWSER_MCP_ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    token,
    socketPath,
    host: env.BROWSER_MCP_HTTP_HOST || "127.0.0.1",
    port: int("BROWSER_MCP_HTTP_PORT", 8930, 0, 65535),
    maxSessions: int("BROWSER_MCP_SESSIONS", 16, 1, 1000),
    idleMs: int("BROWSER_MCP_IDLE_MS", 30 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
    callMs: int("BROWSER_MCP_CALL_MS", 10 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
    origins,
  };
}

/** One HTTP session: its own connection to the broker, opened again (with the session's initialize) if it closes. */
class Session {
  constructor(id, socketPath, initMessage) {
    this.id = id;
    this.socketPath = socketPath;
    this.init = initMessage; // the client's initialize, replayed when the connection is opened again
    this.sock = null;
    this.ready = null;
    this.pending = new Map(); // JSON id -> { resolve }
    this.lastUsed = Date.now();
    this.closed = false;
    this.nextInternal = 1;
  }

  /** Opens the broker connection; resolves once it is connected (and, after a reconnect, initialized again). */
  open(replay) {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const sock = net.createConnection(this.socketPath);
      let buf = "";
      sock.setEncoding("utf8");
      sock.once("connect", async () => {
        this.sock = sock;
        if (!replay) return resolve();
        // The broker answers a repeated initialize from the server's one answer (or starts a new server).
        try {
          await this.exchange({ ...this.init, id: `front-init-${this.nextInternal++}` });
          this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      sock.on("data", (chunk) => {
        buf += chunk;
        if (buf.length > MAX_LINE && !buf.includes("\n")) {
          buf = "";
          sock.destroy(new Error("an answer longer than the limit"));
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
            continue;
          }
          if (!isObject(msg) || !isResponse(msg)) continue; // server notices are not passed on (no GET stream)
          const key = JSON.stringify(msg.id);
          const w = this.pending.get(key);
          if (!w) continue;
          this.pending.delete(key);
          w.resolve(msg);
        }
      });
      sock.on("error", () => {});
      sock.on("close", () => {
        const wasOpen = this.sock === sock;
        if (wasOpen) this.sock = null;
        this.ready = null;
        if (!wasOpen) reject(new Error("the browser's broker is not reachable"));
        for (const [key, w] of this.pending) {
          w.resolve(rpcError(JSON.parse(key), -32000, "the browser's broker closed the connection"));
        }
        this.pending.clear();
      });
    });
    this.ready.catch(() => {});
    return this.ready;
  }

  write(msg) {
    if (this.sock?.writable) this.sock.write(JSON.stringify(msg) + "\n");
  }

  /** Sends a request and resolves with its answer (an error answer when the connection closes first). */
  exchange(msg) {
    const key = JSON.stringify(msg.id);
    if (this.pending.has(key)) return Promise.resolve(rpcError(msg.id, -32600, "a request with this id is still open in this session"));
    return new Promise((resolve) => {
      this.pending.set(key, { resolve });
      this.write(msg);
    });
  }

  forget(id) {
    this.pending.delete(JSON.stringify(id));
  }

  close() {
    this.closed = true;
    this.sock?.end();
    this.sock?.destroy();
    this.sock = null;
    this.ready = null;
  }
}

/** Builds the front; `listen()` resolves with the bound address. */
export function createFront(settings) {
  const { token, socketPath, host, port, maxSessions, idleMs, callMs, origins } = settings;
  const want = digest(token);
  const sessions = new Map();

  const authorized = (req) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
    return Boolean(m) && timingSafeEqual(digest(m[1]), want);
  };

  const reply = (res, status, body, headers = {}) => {
    if (res.headersSent) return;
    const json = body === undefined ? undefined : JSON.stringify(body);
    res.writeHead(status, { ...(json ? { "content-type": "application/json" } : {}), ...headers });
    res.end(json);
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const parts = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          // Read the rest without keeping it, so the client sees the 413; the connection closes after it.
          if (parts.length || size - c.length <= MAX_BODY) reject(Object.assign(new Error("too large"), { status: 413 }));
          parts.length = 0;
          return;
        }
        parts.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
      req.on("error", reject);
    });

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (s.pending.size === 0 && now - s.lastUsed > idleMs) {
        s.close();
        sessions.delete(id);
        log("closed idle session", id.slice(0, 8));
      }
    }
  }, Math.min(idleMs, 60_000));
  sweep.unref();

  async function call(session, msg, req, res) {
    const started = Date.now();
    const label = msg.method === "tools/call" && typeof msg.params?.name === "string" ? `tools/call ${msg.params.name.slice(0, 64)}` : msg.method;
    let timer;
    let answered = false;
    // A client that hangs up before the answer: the call is cancelled upstream.
    res.on("close", () => {
      if (answered) return;
      session.forget(msg.id);
      session.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: msg.id, reason: "the HTTP client left" } });
    });
    const answer = await Promise.race([
      session.exchange(msg),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          session.forget(msg.id);
          session.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: msg.id, reason: "timed out" } });
          resolve(rpcError(msg.id, -32001, `no answer within ${callMs} ms`));
        }, callMs);
      }),
    ]);
    clearTimeout(timer);
    answered = true;
    session.lastUsed = Date.now();
    log(label.replace(/[^\w/ .:-]/g, "?"), answer.error ? `error ${answer.error.code}` : "ok", `${Date.now() - started}ms`);
    return answer;
  }

  async function onPost(req, res) {
    const type = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") return reply(res, 415, rpcError(null, -32700, "Content-Type must be application/json"));
    let msg;
    try {
      msg = JSON.parse(await readBody(req));
    } catch (err) {
      if (err.status === 413) return reply(res, 413, rpcError(null, -32600, "the request is too large"), { connection: "close" });
      return reply(res, 400, rpcError(null, -32700, "the body is not JSON"));
    }
    if (Array.isArray(msg)) return reply(res, 400, rpcError(null, -32600, "batches are not accepted: send one message per request"));
    if (!isObject(msg) || msg.jsonrpc !== "2.0") return reply(res, 400, rpcError(null, -32600, "not a JSON-RPC 2.0 message"));
    const sid = req.headers["mcp-session-id"];

    if (msg.method === "initialize") {
      if (!isRequest(msg)) return reply(res, 400, rpcError(null, -32600, "initialize is a request"));
      if (sid) return reply(res, 400, rpcError(msg.id, -32600, "initialize opens a session: send it without Mcp-Session-Id"));
      if (sessions.size >= maxSessions) return reply(res, 503, rpcError(msg.id, -32000, `${maxSessions} sessions are open; end one first`));
      const session = new Session(randomUUID(), socketPath, msg);
      try {
        await session.open(false);
      } catch {
        return reply(res, 503, rpcError(msg.id, -32000, "the browser's broker is not running"));
      }
      sessions.set(session.id, session);
      const answer = await call(session, msg, req, res);
      if (answer.error) {
        session.close();
        sessions.delete(session.id);
        return reply(res, 200, answer);
      }
      log("opened session", session.id.slice(0, 8));
      return reply(res, 200, answer, { "mcp-session-id": session.id });
    }

    if (!sid) return reply(res, 400, rpcError(msg.id, -32600, "Mcp-Session-Id is missing: initialize first"));
    const session = sessions.get(String(sid));
    if (!session) return reply(res, 404, rpcError(msg.id, -32001, "no such session: initialize again"));
    session.lastUsed = Date.now();
    try {
      // Connected, still connecting, or connecting again (with the session's initialize) after the broker closed it.
      await (session.ready ?? session.open(true));
    } catch {
      return reply(res, 503, rpcError(msg.id, -32000, "the browser's broker is not running"));
    }
    if (isRequest(msg)) return reply(res, 200, await call(session, msg, req, res));
    if (isNotification(msg)) {
      // The broker sends the server its own notifications/initialized; a cancel is passed on.
      if (msg.method === "notifications/cancelled") {
        session.forget(msg.params?.requestId);
        session.write(msg);
      }
      return reply(res, 202);
    }
    if (isResponse(msg)) return reply(res, 202); // the broker answers the server's requests itself
    return reply(res, 400, rpcError(null, -32600, "not a request, notification or response"));
  }

  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    try {
      if (path === "/healthz" && req.method === "GET") {
        const up = existsSync(socketPath);
        res.writeHead(up ? 200 : 503, { "content-type": "text/plain" });
        return res.end(up ? "ok\n" : "starting\n");
      }
      if (path !== "/mcp") return reply(res, 404, rpcError(null, -32601, "not found"));
      const origin = req.headers.origin;
      if (origin !== undefined && !origins.includes(origin)) return reply(res, 403, rpcError(null, -32600, "this origin is not allowed"));
      if (!authorized(req)) return reply(res, 401, rpcError(null, -32600, "a valid bearer token is required"), { "www-authenticate": "Bearer" });
      if (req.method === "POST") return await onPost(req, res);
      if (req.method === "DELETE") {
        const session = sessions.get(String(req.headers["mcp-session-id"] ?? ""));
        if (!session) return reply(res, 404, rpcError(null, -32001, "no such session"));
        session.close();
        sessions.delete(session.id);
        log("ended session", session.id.slice(0, 8));
        return reply(res, 204);
      }
      return reply(res, 405, rpcError(null, -32601, "only POST and DELETE"), { allow: "POST, DELETE" });
    } catch (err) {
      log("error", err.message);
      reply(res, 500, rpcError(null, -32603, "internal error"));
    }
  });
  // Calls may take minutes (a first page waits for the browser); the front's own limit is callMs.
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 60_000;

  return {
    server,
    sessions,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve(server.address()));
      });
    },
    close() {
      clearInterval(sweep);
      for (const s of sessions.values()) s.close();
      sessions.clear();
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function main() {
  let settings;
  try {
    settings = readSettings();
  } catch (err) {
    log(err.message);
    process.exit(64);
  }
  const front = createFront(settings);
  const addr = await front.listen();
  log(`listening on http://${addr.address.includes(":") ? `[${addr.address}]` : addr.address}:${addr.port}/mcp for ${settings.socketPath}`);
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, async () => {
      await front.close();
      process.exit(0);
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    log(err.message);
    process.exit(1);
  });
}

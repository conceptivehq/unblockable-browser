#!/usr/bin/env node
// A loopback-only HTTP proxy for the browsers (the unblockable browser kit). It forwards every request, CONNECT
// tunnels and plain HTTP alike, to the upstream residential proxy PROXY_SERVER (host:port) and adds
// Proxy-Authorization from PROXY_USERNAME and PROXY_PASSWORD, so those never reach a browser, a PAC file or a log.
// fleet-proxy.service starts it with EnvironmentFile= the proxy env file. It logs only method, host and status.
// Settings: FORWARD_BIND (default 127.0.0.1, loopback only), FORWARD_PORT (default 3128; 0 picks a free port).
// No dependencies; Node 18 or newer.
import http from "node:http";
import net from "node:net";
import { pathToFileURL } from "node:url";

const HOST_PORT = /^([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\]):([0-9]{1,5})$/;
const HOP_HEADERS = new Set(["proxy-authorization", "proxy-connection", "connection", "keep-alive", "te", "trailer", "upgrade"]);

const isLoopback = (host) => host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

/** Reads and checks the settings. Throws a message that never holds a credential. */
export function readSettings(env = process.env) {
  const bind = env.FORWARD_BIND || "127.0.0.1";
  if (!isLoopback(bind)) throw new Error(`FORWARD_BIND must be a loopback address, not ${bind}`);
  const port = Number(env.FORWARD_PORT ?? 3128);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("FORWARD_PORT must be an integer from 0 to 65535");
  const server = (env.PROXY_SERVER || "").trim();
  const match = HOST_PORT.exec(server);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) throw new Error("PROXY_SERVER must be set to host:port");
  const user = env.PROXY_USERNAME || "";
  const pass = env.PROXY_PASSWORD || "";
  if (!user || !pass) throw new Error("PROXY_USERNAME and PROXY_PASSWORD must be set (from the proxy env file)");
  return {
    bind,
    port,
    upstreamHost: match[1].replace(/^\[|\]$/g, ""),
    upstreamPort: Number(match[2]),
    auth: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
  };
}

const say = (log, method, host, status) => log(`${method} ${String(host).slice(0, 255)} ${status}`);

/** Starts the forwarder; resolves to the listening server. */
export function startForwarder(settings, log = (line) => console.log(line)) {
  const server = http.createServer((req, res) => {
    let target;
    try {
      target = new URL(req.url);
    } catch {
      target = null;
    }
    if (!target || target.protocol !== "http:") {
      say(log, req.method, "-", 400);
      res.writeHead(400, { "content-type": "text/plain" }).end("This proxy forwards absolute http:// URLs and CONNECT only.\n");
      return;
    }
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) if (!HOP_HEADERS.has(name)) headers[name] = value;
    headers["proxy-authorization"] = settings.auth;
    const upstream = http.request(
      { host: settings.upstreamHost, port: settings.upstreamPort, method: req.method, path: req.url, headers },
      (up) => {
        say(log, req.method, target.host, up.statusCode);
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      say(log, req.method, target.host, 502);
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("The upstream proxy could not be reached.\n");
    });
    req.pipe(upstream);
  });

  server.on("connect", (req, client, head) => {
    const authority = req.url || "";
    if (!HOST_PORT.test(authority)) {
      say(log, "CONNECT", "-", 400);
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const upstream = net.connect(settings.upstreamPort, settings.upstreamHost);
    let buffered = Buffer.alloc(0);
    let done = false;
    const fail = (status) => {
      if (done) return;
      done = true;
      say(log, "CONNECT", authority, status);
      client.end(`HTTP/1.1 ${status} ${status === 504 ? "Gateway Timeout" : "Bad Gateway"}\r\n\r\n`);
      upstream.destroy();
    };
    upstream.setTimeout(30_000, () => fail(504));
    upstream.on("error", () => fail(502));
    client.on("error", () => upstream.destroy());
    upstream.on("connect", () => {
      upstream.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: ${settings.auth}\r\n\r\n`);
    });
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buffered.length > 16_384) fail(502);
        return;
      }
      upstream.off("data", onData);
      upstream.setTimeout(0);
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(buffered.subarray(0, end).toString("latin1"))?.[1] ?? 502);
      done = true;
      say(log, "CONNECT", authority, status);
      if (status !== 200) {
        client.end(`HTTP/1.1 ${status} Upstream Refused\r\n\r\n`);
        upstream.destroy();
        return;
      }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const rest = buffered.subarray(end + 4);
      if (rest.length) client.write(rest);
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    };
    upstream.on("data", onData);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(settings.port, settings.bind, () => {
      const address = server.address();
      if (!address || typeof address === "string" || !isLoopback(address.address)) {
        server.close();
        reject(new Error("the forwarder is not bound to a loopback address"));
        return;
      }
      log(`listening on ${address.address}:${address.port}`);
      resolve(server);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let settings;
  try {
    settings = readSettings();
  } catch (err) {
    console.error(`proxy-forward: ${err.message}`);
    process.exit(64);
  }
  startForwarder(settings).catch((err) => {
    console.error(`proxy-forward: cannot listen: ${err.code ?? err.message}`);
    process.exit(1);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));
}

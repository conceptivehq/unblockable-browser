// Tests for the unblockable browser kit's proxy-forward.mjs. Run: node --test kits/unblockable-browser/test/proxy-forward.test.mjs
// A fake upstream proxy and a fake origin listen on loopback; nothing leaves the machine.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { readSettings, startForwarder } from "../bin/proxy-forward.mjs";

const SCRIPT = fileURLToPath(new URL("../bin/proxy-forward.mjs", import.meta.url));
const USER = "browser-user";
const PASS = "pa55-not-logged";
const EXPECTED = `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`;

/** A fake upstream proxy: records what it saw, answers CONNECT with 200 and pipes to an echo, answers plain HTTP itself. */
async function fakeUpstream({ connectStatus = 200 } = {}) {
  const seen = [];
  const echo = net.createServer((sock) => sock.pipe(sock));
  echo.listen(0, "127.0.0.1");
  await once(echo, "listening");
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers["proxy-authorization"] });
    res.writeHead(203, { "content-type": "text/plain" }).end(`upstream saw ${req.url}`);
  });
  server.on("connect", (req, sock, head) => {
    seen.push({ method: "CONNECT", url: req.url, auth: req.headers["proxy-authorization"] });
    if (connectStatus !== 200) {
      sock.end(`HTTP/1.1 ${connectStatus} Nope\r\n\r\n`);
      return;
    }
    const target = net.connect(echo.address().port, "127.0.0.1", () => {
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) target.write(head);
      target.pipe(sock);
      sock.pipe(target);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    seen,
    port: server.address().port,
    close: () => {
      server.closeAllConnections?.();
      server.close();
      echo.close();
    },
  };
}

async function withForwarder(upstream, fn) {
  const lines = [];
  const settings = readSettings({
    FORWARD_PORT: "0",
    PROXY_SERVER: `127.0.0.1:${upstream.port}`,
    PROXY_USERNAME: USER,
    PROXY_PASSWORD: PASS,
  });
  const server = await startForwarder(settings, (line) => lines.push(line));
  try {
    await fn(server.address().port, lines);
  } finally {
    server.closeAllConnections?.();
    server.close();
    upstream.close();
  }
  for (const line of lines) {
    assert.ok(!line.includes(PASS) && !line.includes(USER) && !line.includes(EXPECTED), `a log line holds a credential: ${line}`);
  }
}

function connectThrough(port, authority, extraHeaders = "") {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${extraHeaders}\r\n`);
    });
    let data = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.includes("\r\n\r\n")) {
        sock.removeAllListeners("data");
        resolve({ sock, head: data.toString("latin1") });
      }
    });
    sock.on("error", reject);
  });
}

test("CONNECT is tunnelled through the upstream with Proxy-Authorization added", async () => {
  const upstream = await fakeUpstream();
  await withForwarder(upstream, async (port, lines) => {
    const { sock, head } = await connectThrough(port, "example.com:443", "Proxy-Authorization: Basic Zm9vOmJhcg==\r\n");
    assert.match(head, /^HTTP\/1\.1 200 /);
    sock.write("ping");
    const [echoed] = await once(sock, "data");
    assert.equal(echoed.toString(), "ping");
    sock.destroy();
    assert.deepEqual(upstream.seen, [{ method: "CONNECT", url: "example.com:443", auth: EXPECTED }]);
    assert.ok(lines.includes("CONNECT example.com:443 200"), lines.join("\n"));
  });
});

test("an upstream refusal is passed back and logged with its status", async () => {
  const upstream = await fakeUpstream({ connectStatus: 407 });
  await withForwarder(upstream, async (port, lines) => {
    const { sock, head } = await connectThrough(port, "example.com:443");
    assert.match(head, /^HTTP\/1\.1 407 /);
    sock.destroy();
    assert.ok(lines.includes("CONNECT example.com:443 407"), lines.join("\n"));
  });
});

test("plain HTTP is forwarded with the client's own Proxy-Authorization replaced", async () => {
  const upstream = await fakeUpstream();
  await withForwarder(upstream, async (port, lines) => {
    const body = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, method: "GET", path: "http://example.com/x?y=1", headers: { "proxy-authorization": "Basic Zm9vOmJhcg==" } },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode, text }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(body.status, 203);
    assert.equal(body.text, "upstream saw http://example.com/x?y=1");
    assert.deepEqual(upstream.seen, [{ method: "GET", url: "http://example.com/x?y=1", auth: EXPECTED }]);
    assert.ok(lines.includes("GET example.com 203"), lines.join("\n"));
  });
});

test("readSettings refuses missing credentials, a bad server and a non-loopback bind", () => {
  const ok = { PROXY_SERVER: "proxy.example.net:8000", PROXY_USERNAME: USER, PROXY_PASSWORD: PASS };
  assert.equal(readSettings(ok).port, 3128);
  assert.equal(readSettings(ok).bind, "127.0.0.1");
  for (const [change, word] of [
    [{ PROXY_PASSWORD: "" }, /PROXY_USERNAME and PROXY_PASSWORD/],
    [{ PROXY_USERNAME: undefined }, /PROXY_USERNAME and PROXY_PASSWORD/],
    [{ PROXY_SERVER: "" }, /PROXY_SERVER/],
    [{ PROXY_SERVER: "http://proxy.example.net:8000" }, /PROXY_SERVER/],
    [{ PROXY_SERVER: "proxy.example.net:0" }, /PROXY_SERVER/],
    [{ FORWARD_BIND: "0.0.0.0" }, /loopback/],
    [{ FORWARD_BIND: "192.168.1.5" }, /loopback/],
    [{ FORWARD_PORT: "http" }, /FORWARD_PORT/],
  ]) {
    assert.throws(() => readSettings({ ...ok, ...change }), (err) => {
      assert.match(err.message, word);
      assert.ok(!err.message.includes(PASS));
      return true;
    });
  }
});

test("the script refuses to start without the env and never echoes the password", () => {
  const env = { PATH: process.env.PATH, PROXY_SERVER: "proxy.example.net:8000", PROXY_PASSWORD: PASS };
  const run = spawnSync(process.execPath, [SCRIPT], { env, encoding: "utf8", timeout: 10_000 });
  assert.equal(run.status, 64);
  assert.match(run.stderr, /PROXY_USERNAME and PROXY_PASSWORD must be set/);
  assert.ok(!run.stderr.includes(PASS) && !run.stdout.includes(PASS));
  const wide = spawnSync(process.execPath, [SCRIPT], {
    env: { ...env, PROXY_USERNAME: USER, FORWARD_BIND: "0.0.0.0" },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(wide.status, 64);
  assert.match(wide.stderr, /loopback/);
});

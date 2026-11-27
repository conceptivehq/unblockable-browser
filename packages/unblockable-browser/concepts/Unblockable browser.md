---
name: Unblockable browser
description: A visible Chromium in one container that Strut drives through Browser MCP over HTTP (BROWSER_MCP_URL and BROWSER_MCP_TOKEN) instead of a Playwright server.
---
The unblockable browser gives Strut a real browser of its own on a headless server, without ever running the browser headless. Sites see an ordinary desktop Chrome: a visible window, a real extension, a normal profile that keeps its cookies, and (where you name one) a residential address.

Everything the browser needs is in one container image:

- **Chromium** runs visibly on a virtual display (Xvfb) as an unprivileged user, with its sandbox on. Its profile lives on a volume, so sign-ins and cookies survive restarts and image updates.
- **The extension** is a copy of Browser MCP's extension, stamped for the image's profile and port and refusing any other server.
- **Browser MCP's server** listens only on the container's loopback, started by the kit's broker.
- **The HTTP front** serves MCP's Streamable HTTP at `POST /mcp` on port 8930 behind a bearer token of 32 or more characters, and answers `/healthz` for the container's health check. It never logs the token or a call's arguments.

To use it, run the container and give Strut two settings: `BROWSER_MCP_URL` (for example `http://127.0.0.1:8930/mcp`) and `BROWSER_MCP_TOKEN`. Strut then picks `McpBrowser` (Strut `b235947` or newer), which keeps one MCP session and opens a new one if the container drops it. Each run gets a window of its own, closed when the run ends.

The chain: a `browser/*` step → Strut (`McpBrowser`) → HTTP with the token → the container's front → the broker → Browser MCP's server ⇄ the extension in Chromium on Xvfb.

The browser never uses `--headless`, `--remote-debugging-port` or `--remote-debugging-pipe`, and never puts a credential on a command line. Publish the front on loopback or a private network, never on a public address. Every workflow in this package drives it with the [[Unblockable browser steps]].

---
name: Unblockable browser
description: Strut's own visible Chromium on a Linux host, which Strut drives through Browser MCP and its extension instead of a Playwright server.
---
The unblockable browser gives Strut a real browser of its own on a headless Linux server, without ever running the browser headless. Sites see an ordinary desktop Chrome: a visible window, a real extension, a normal profile that keeps its cookies, and (where a browser names one) a residential address.

- **Chromium** runs visibly on a virtual display (Xvfb, display :100 by default) under the systemd user unit `fleet-browser@<profile>.service` (profile `strut`), with its own user-data folder. Its first window is 1600×1000, so each run's window gets desktop layouts.
- **The extension** is a physical copy of Browser MCP's extension, stamped for Strut's browser and its port and loaded with `--load-extension`. It refuses a server for another browser.
- **The server** is Browser MCP's Node server, run by the browser's broker (`fleet-browser-mcp@<profile>.service`) on 127.0.0.1:<port> only.
- **Strut's host** spawns the kit's stdio adapter `browser-mcp` once and keeps it. Each run gets a window of its own (`BROWSER_MCP_PAGE_ISOLATION=window`), closed when the run ends.

The chain: a `browser/*` step → Strut's host (`Browser`) → stdio `browser-mcp` → the broker → the server on 127.0.0.1:<port> ⇄ the extension in Strut's Chromium on Xvfb.

The browser never uses `--headless`, `--remote-debugging-port` or `--remote-debugging-pipe`, never shares a profile folder, and never puts a credential on a command line. The kit's `kits/unblockable-browser/unblockable_browser.py` installs it from a config file (a browser with `"client": "strut"`), and the host uses it when `BROWSER_PROFILE` and `BROWSER_PORT` are set. Every workflow in this package drives it with the [[Unblockable browser steps]].

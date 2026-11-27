# Changelog

## 0.3.0 (November 27, 2026)

- The container is the setup. The package README and Concepts now describe running the container and giving Strut `BROWSER_MCP_URL` and `BROWSER_MCP_TOKEN`, which Strut's own `McpBrowser` (Strut `b235947` or newer) uses. The systemd install through the kit stays available and is described as the way without Docker.
- The package `conceptive/unblockable-browser` 0.3.0 drops `requires.binaries`: Chromium, Xvfb and Browser MCP live in the container, so the Strut server needs none of them.
- The container is published on GitHub's container registry for amd64 and arm64, tagged by version (`ghcr.io/conceptivehq/unblockable-browser:0.3.0`, `:0.3` and `:latest`), by `.github/workflows/image.yml` when a version tag is pushed.
- The setup recommends a `BROWSER_URL_DENY` that also keeps pages off loopback and private networks, since Strut's default list covers only `file:` and cloud metadata.

## 0.2.0 (November 20, 2026)

- MCP over HTTP: `kits/unblockable-browser/bin/browser-mcp-http.mjs` serves a browser's MCP as Streamable HTTP at `POST /mcp` behind a bearer token, through the browser's broker. Plain Node, no packages.
- The whole browser as one container, `kits/unblockable-browser/docker/`: Xvfb, a visible Chromium, Browser MCP and its stamped extension, the broker and MCP over HTTP on port 8930, with an optional proxy. `chromium-seccomp.json` is Docker's default seccomp profile plus the namespace calls Chromium's sandbox makes, so the browser keeps its sandbox.
- Strut's browser over HTTP: `BROWSER_MCP_URL` and `BROWSER_MCP_TOKEN` point `Browser` at a browser such as the container, in place of `BROWSER_PROFILE` and the rest.
- `bin/browser-server` takes `BROWSER_SUPERVISOR=none` for a browser supervised by something other than systemd.
- The Concept *Browser steps* is now *Unblockable browser steps*.

## 0.1.0 (November 20, 2026)

The first release.

- The installer kit, `kits/unblockable-browser/`: plan, apply, verify and remove visible Chromium browsers driven through Browser MCP, with a broker, a proxy forwarder and a VNC view.
- Strut's browser, `strut/`: `Browser` implements Strut's `StrutBrowser` (Strut `d4e6595`), with the fifteen research steps plus `evaluate` and `capture`. Playwright-only selector chains are refused with the reason, and Chrome's element errors come back in plain words.
- The Strut package `conceptive/unblockable-browser` 0.2.3 with four workflows, and `packages/check-package.mjs`.
- The example config's proxied sites are placeholders (`reviews.example`, `jobs.example`) beside `challenges.cloudflare.com`.

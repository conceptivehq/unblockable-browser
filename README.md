# Unblockable browser

A real, visible Chromium on a Linux server that sites treat like a person's browser, for AI agents and for the [Strut](https://github.com/stakwork/strut) workflow engine. It is driven from inside the browser by [Browser MCP](https://github.com/getcabal/browser-mcp)'s extension, never headless and with no remote-debugging port, and an optional residential proxy carries only the sites that refuse a cloud server's address.

"Unblockable" means it gets past blocks on cloud addresses and on automation tools. It never solves a CAPTCHA and never signs in on its own: at a human check a step times out and says so, and on a browser installed with the kit a person can answer the check over a loopback VNC view.

Version 0.3.0. See [CHANGELOG.md](CHANGELOG.md). Apache License 2.0.

## Quick start with Strut

1. Run the container, published for amd64 and arm64 as `ghcr.io/conceptivehq/unblockable-browser:0.3.0`. The token file holds 32 or more random characters, outside Git, readable by uid 10001:

   ```sh
   openssl rand -base64 33 | tr -d '\n' > browser-mcp-token
   sudo install -m 400 -o 10001 -g 10001 browser-mcp-token /srv/secrets/browser-mcp-token
   docker run -d --name unblockable-browser --restart unless-stopped --shm-size 1g \
     --security-opt seccomp=kits/unblockable-browser/docker/chromium-seccomp.json --security-opt no-new-privileges \
     -p 127.0.0.1:8930:8930 -v unblockable-browser-profile:/opt/unblockable-browser/profiles \
     -v /srv/secrets/browser-mcp-token:/run/secrets/browser-mcp-token:ro \
     -e BROWSER_MCP_TOKEN_FILE=/run/secrets/browser-mcp-token ghcr.io/conceptivehq/unblockable-browser:0.3.0
   ```

   Or build it yourself: `docker build -t unblockable-browser -f kits/unblockable-browser/docker/Dockerfile kits/unblockable-browser`, and run `unblockable-browser` in its place.

2. Give Strut (`b235947` or newer) `BROWSER_MCP_URL=http://127.0.0.1:8930/mcp` and `BROWSER_MCP_TOKEN`, and widen its `BROWSER_URL_DENY` to loopback and private ranges (the package README gives a value). Strut's `McpBrowser` then drives the container, each run in a window of its own.
3. Install `packages/unblockable-browser` and run its `check` workflow.

The seccomp profile is Docker's default plus the namespace calls Chromium's sandbox needs, so the browser keeps its sandbox. The profile volume keeps sign-ins and cookies across restarts and image updates. The guide's *MCP over HTTP* and *The container* have the details: the proxy, and what the container does not do yet. Any MCP client that speaks Streamable HTTP can use the container the same way.

## What is here

| Path | What it is |
|---|---|
| `kits/unblockable-browser/docker/` | The whole browser as one container: Xvfb, a visible Chromium, Browser MCP and its stamped extension, the broker, and MCP over HTTP behind a bearer token (`bin/browser-mcp-http.mjs`). See *Quick start with Strut* above. |
| `kits/unblockable-browser/` | The installer kit. `unblockable_browser.py` plans, applies, verifies and removes browsers from one JSON file: a virtual screen (Xvfb), one Chromium per browser with its own profile, a stamped copy of Browser MCP's extension and its own loopback port, a broker that lets several MCP clients share one server, an optional proxy forwarder and an optional VNC view, all as systemd user services. Python standard library and plain Node, no packages. |
| `strut/` | Strut's side: `Browser`, an implementation of Strut's `StrutBrowser` interface, so Strut's own `browser/*` steps drive this browser in place of a Playwright server, and `browserOptionsFromEnv` and `researchBrowser`, which pick the browser from a host's `BROWSER_*` settings. Strut `b235947` and newer carry its HTTP half as `McpBrowser`, so a plain Strut needs only the container; this adapter is for a host that builds Strut with its own browser or uses the kit over stdio. See [strut/README.md](strut/README.md). |
| `packages/unblockable-browser/` | The Strut package `conceptive/unblockable-browser`: four workflows built from Strut's `browser/*` steps (check, read-page, search-site, explore) and the Concepts that explain them. `packages/check-package.mjs` proves a package against a Strut checkout. |
| `.github/workflows/image.yml` | Builds the container for amd64 and arm64 on a version tag and pushes it to `ghcr.io`. |
| `docs/unblockable-browser.md` | The full guide: how a browser fits together, the config file, install, verify, the proxy, CAPTCHA help and what the kit never does. |

## Install a browser without Docker

On a Debian server with systemd, Chromium, Xvfb, Node 22 or newer, Python 3, Git and npm, as the user who runs your agents (with `loginctl enable-linger` so user services run without a login):

1. Copy `kits/unblockable-browser/browsers.example.json` to `browsers.json` and edit it: one entry per browser, each with its own profile name and port, and a full Browser MCP commit to build.
2. `python3 kits/unblockable-browser/unblockable_browser.py plan --config browsers.json` prints every action and changes nothing.
3. `python3 kits/unblockable-browser/unblockable_browser.py apply --config browsers.json --execute` builds Browser MCP at the pinned commit, stamps each browser's extension copy, and writes the services and scripts. It prints the MCP block for each agent and, for Strut's browser, the settings to give Strut's host. It never edits an agent's config or restarts anything.
4. `python3 kits/unblockable-browser/unblockable_browser.py verify --config browsers.json --mcp` checks every part and exits 1 on any failure.

For the proxy, write its env file yourself (mode 600, outside Git): `PROXY_SERVER`, and for a password proxy `PROXY_USERNAME` and `PROXY_PASSWORD`. The kit never prints it, and the sign-in never reaches Chromium, a command line or a log.

## Strut's browser on the kit

A browser with `"client": "strut"` belongs to Strut. Give Strut's host the settings `plan` prints (`BROWSER_ROOT`, `BROWSER_PROFILE`, `BROWSER_PORT`, `BROWSER_NODE`), hand `researchBrowser(browserOptionsFromEnv(process.env))` to Strut as its browser service, and Strut's `browser/*` steps drive the visible Chromium, each run in a window of its own. [strut/README.md](strut/README.md) shows the wiring and lists where it differs from Strut's Playwright browser. The same `Browser` also speaks HTTP (`BROWSER_MCP_URL` and `BROWSER_MCP_TOKEN`), for a host that builds Strut with its own browser.

## The Strut package

`packages/unblockable-browser/` installs on a Strut that installs packages. A host that hands Strut its own step registry (`createStrut({ registry })`) cannot install it: Strut then refuses every package install (`409 Installing is disabled when the registry is provided at construction time`). On such a host, publish each file in `packages/unblockable-browser/workflows/` as plain YAML, the way the host publishes its other workflows. The workflows are the same either way.

## Tests

```sh
python3 -m unittest discover -s kits/unblockable-browser/test       # the installer
node --test kits/unblockable-browser/test/*.test.mjs                  # the broker, MCP over HTTP and the proxy forwarder
cd strut && npm run setup && npm run typecheck && npm test           # Strut's browser over stdio and HTTP, on a stand-in browser
node --import ./.strut/node_modules/tsx/dist/esm/index.mjs \
  ../packages/check-package.mjs .strut ../packages/unblockable-browser   # the package, on a real Strut (from strut/)
```

`npm run setup` fetches Strut from its public repository at the commit `strut/` is built against, into `strut/.strut` (ignored by Git). No test starts a browser.

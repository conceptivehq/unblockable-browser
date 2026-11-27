# conceptive/unblockable-browser

A Strut package for the unblockable browser: a visible Chromium in one container that Strut drives through Browser MCP and its extension, in place of a Playwright server. Sites see an ordinary desktop Chrome with a real profile and, where you name one, a residential address. The browser never runs headless and has no remote-debugging port.

The container holds the whole browser and serves MCP over HTTP behind a bearer token. Strut's `McpBrowser` connects Strut's `browser/*` steps to it. This package holds four workflows built from those steps and the Concepts that explain them.

## Setting it up

1. **Run the container** on the Strut server or a machine it can reach, with a token file of 32 or more random characters that uid 10001 can read. The image is published for amd64 and arm64 as `ghcr.io/conceptivehq/unblockable-browser:0.3.0`. The run needs the seccomp profile from the unblockable-browser repository (`kits/unblockable-browser/docker/chromium-seccomp.json`):

   ```sh
   docker run -d --name unblockable-browser --restart unless-stopped --shm-size 1g \
     --security-opt seccomp=kits/unblockable-browser/docker/chromium-seccomp.json \
     --security-opt no-new-privileges \
     -p 127.0.0.1:8930:8930 \
     -v unblockable-browser-profile:/opt/unblockable-browser/profiles \
     -v /srv/secrets/browser-mcp-token:/run/secrets/browser-mcp-token:ro \
     -e BROWSER_MCP_TOKEN_FILE=/run/secrets/browser-mcp-token \
     ghcr.io/conceptivehq/unblockable-browser:0.3.0
   ```

   To build the image yourself instead, from a checkout of the repository: `docker build -t unblockable-browser -f kits/unblockable-browser/docker/Dockerfile kits/unblockable-browser`.

2. **Point Strut at it** and give it no other browser (`BROWSER_WS_URL` and `BROWSER_CDP_URL` unset):

   | Setting | Value |
   | --- | --- |
   | `BROWSER_MCP_URL` | `http://127.0.0.1:8930/mcp` |
   | `BROWSER_MCP_TOKEN` | the token in the file |
   | `BROWSER_URL_DENY` | recommended: `file:,localhost,0.0.0.0/8,127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,::1,fc00::/7,fe80::/10` |

   Strut's default deny list covers `file:` and cloud metadata only. The longer list also keeps pages off loopback and private networks, which from inside the container include the browser's own ports.

3. **Restart Strut** when no run is active, install this package and run `check`.

That is the whole setup. Strut picks `McpBrowser` when `BROWSER_MCP_URL` is set (Strut `b235947` or newer). The volume keeps the browser's profile, cookies and sign-ins across restarts and image updates. To send some sites through a residential proxy, see *Residential proxy*.

## How a step reaches the browser

```
browser/* step ─▶ Strut (McpBrowser) ─HTTP + bearer token─▶ container :8930/mcp
                                                              │
         Chromium on Xvfb ◀─ extension ◀─ws─ Browser MCP server ◀─ broker
```

- Strut opens one MCP session on the first call and keeps it. If the container drops the session (a restart, or its idle limit), Strut opens a new one and sends that call once more.
- Each run gets a window of its own, closed when the run ends. A run's calls take turns in the order they were sent.
- Addresses are checked against Strut's deny list (`BROWSER_URL_DENY`) before each navigation and again where the page landed. It matches IP addresses written in the URL and exact host names, and does no DNS lookups.
- The first call after the container starts waits about ten seconds for the browser; later calls answer at once.

## The steps

Every workflow here is made of Strut's own `browser/*` steps, so the same toolset works in any workflow: as declared steps with selectors, or as an agent's tools with refs. See the Concept *Unblockable browser steps* for what each one does on the browser.

| Read | Act | Wait and keep |
| --- | --- | --- |
| `browser/open`, `browser/goto`, `browser/back` | `browser/click`, `browser/fill`, `browser/type` | `browser/wait` (text, url, ref, selector or ms) |
| `browser/snapshot` (tree with `[ref=eN]`) | `browser/press`, `browser/select`, `browser/hover` | `browser/screenshot` (`shots/*.png`) |
| `browser/text` (page, ref or selector) | `browser/scroll` | `browser/close` |

Selectors are CSS, `text=…` or `role=…[name=…]`. `browser/evaluate` and `browser/capture` work too. The browser refuses, with the reason: kept pages across runs (`session`), a Playwright `storageState`, a right click and Playwright-only selector chains. A screenshot is always the window's view, also when `fullPage` or an element is asked for.

## The workflows

| Workflow | Kind | Input | Output |
| --- | --- | --- | --- |
| `check` | declared | `probe_url?`, `expect_text?`, `wait_ms?`, `ip_url?` | `outcome` (ok, changed, no_ip), `egress_ip`, `title`, `tree_chars`, `screenshot`, `error` |
| `read-page` | declared | `url`, `selector?`, `wait_for?` | `url`, `title`, `status`, `text`, `screenshot` |
| `search-site` | declared | `url`, `search_box`, `query`, `results?`, `expect_text?` | `url`, `text`, `screenshot` |
| `explore` | agent | `goal`, `url` | `answer`, `evidence`, `pages`, `blocked`, `error`, `cost` |

- `check` opens a probe page, waits for its text, reads its tree, photographs it, reads the address the web sees and closes. Run it after starting or updating the container.
- `read-page` and `search-site` are declared routes: no model, the author names the elements.
- `explore` hands the fifteen steps to an `agent` as tools and nothing else (`toolFilter: ["none"]`, `mcp: false`). It reads with `browser_snapshot`, acts on refs and photographs its evidence.

None of them signs in, buys, posts or changes a setting, and none solves a CAPTCHA: a declared wait times out and says so; the agent stops and reports the page in `blocked` (see *CAPTCHA help*).

## Without Docker

The repository's installer kit (`kits/unblockable-browser`, see `docs/unblockable-browser.md`) can install the same browser as systemd user services on a Linux server instead. A host that builds Strut with its own browser can then use the repository's `strut/` adapter over stdio. The workflows are the same either way.

## On a host that hands Strut its own step registry

A host that builds Strut with its own step registry (`createStrut({ registry })`) cannot install this package: Strut then refuses every package install (`409 Installing is disabled when the registry is provided at construction time`). On such a host, publish each file in `workflows/` as plain YAML, the way the host publishes its other workflows, and keep the Concepts as documentation. The workflows are the same either way; the package is the form for a Strut that installs packages.

## Requirements

A Strut with `McpBrowser` (`b235947` or newer) and Docker where the browser runs. Nothing else is needed on the Strut server: Chromium, Xvfb and Browser MCP live in the container. The workflows use Strut's `browser/*` steps, `agent` (for `explore`), `if` and `pack`. A host with its own step list must include them. On a Strut without a browser every browser step fails, naming the missing service.

`node --import <strut>/node_modules/tsx/dist/esm/index.mjs ../check-package.mjs <strut> .` (from this folder) reads, installs, dry-run builds and runs the package against a Strut checkout, with a stand-in browser.

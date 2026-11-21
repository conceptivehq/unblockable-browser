# Unblockable browser

The unblockable browser gives each Hermes agent a real browser of its own that sites treat like a person's: a visible Chromium on a Linux server, driven through [Browser MCP](https://github.com/getcabal/browser-mcp) (Apache-2.0). The kit in `kits/unblockable-browser/` installs and checks browsers from one config file; the Strut package in `packages/unblockable-browser/` holds workflows for Strut's browser, built from Strut's `browser/*` steps. Installed names keep their earlier `browser-browser` and `unblockable-browser` forms (programs, units, folders, `BROWSER_*` settings), so hosts installed before the rename keep working unchanged.

## How a browser fits together

```
Hermes gateway (profile <p>)     Codex threads (when <p> runs on Codex's app-server)
  │  stdio MCP: mcp_servers.browser, one process per client
  ▼
<root>/bin/browser-mcp            checks its env, starts fleet-browser-mcp@<p>.service if it is not running,
  │                                    then relays stdio to the broker's socket
  ▼  unix socket <root>/run/<p>.sock (mode 600, folder 700)
Broker (browser-broker.mjs serve)  fleet-browser-mcp@<p>.service: one upstream server shared by every client
  │  stdio; started when the first client arrives
  ▼
<root>/bin/browser-server          checks its env, starts fleet-browser@<p>.service if it is not running
  │  exec
  ▼
Browser MCP server (node cli.js start)  listens on 127.0.0.1:<port> only, --profile <p> --require-extension
  ⇅  WebSocket on loopback
Browser MCP extension, stamped <p>:<port>, a physical copy in <root>/extensions/<p>
  │  loaded by
  ▼
Chromium for <p>                        fleet-browser@<p>.service, --user-data-dir=<root>/profiles/<p>
  │  draws on
  ▼
Xvfb :100                               fleet-xvfb@<display>.service, -nolisten tcp
```

Each browser has its own user-data folder, its own extension copy and its own port; the extension refuses a server stamped for another profile. Chromium opens a 1600x1000 first window at the display's corner, and job windows cascade inside it, so pages get desktop layouts.

Browser MCP serves one MCP client per process over stdio, and its server holds the browser's port while it runs. An agent can have several clients at once: the Hermes gateway's own and, when the profile runs on Codex's app-server, one per Codex thread, each started as soon as the thread opens. The broker lets them all share one server: it answers every client's `initialize` from the server's one answer, gives each forwarded request its own id and routes the answer back, answers the server's own requests (`ping`, `roots/list`) itself, and passes list-changed notices to every client. A client leaving keeps the server; the server ending fails what is pending and closes every client, and the next client starts a new server. Clients share the one browser, so two at once see each other's tabs, as two people at one browser would. With `vnc: true`, `fleet-vnc@<display>.service` shows the display on 127.0.0.1:5900+display for a person helping through an SSH tunnel. With a password proxy, `fleet-proxy.service` runs the forwarder on 127.0.0.1:3128.

## The config file

`kits/unblockable-browser/browsers.example.json` is a complete example. Every key is required unless marked; unknown keys are refused, and every problem is reported at once.

| Key | Meaning |
|---|---|
| `schema_version` | `1`. |
| `display` | The Xvfb display number, 1 to 999 (`100` is usual). |
| `vnc` | `true` adds the loopback VNC view for CAPTCHA help. |
| `chromium` | The Chromium binary, such as `/usr/lib/chromium/chromium` (the binary, not Debian's wrapper). |
| `node` | Node.js, such as `~/.local/bin/node`. |
| `root` | The kit's own folder, at least two levels inside the home folder, such as `~/.local/share/unblockable-browser`. Everything the kit writes is under it or in `~/.config/systemd/user/`. |
| `browser_mcp.repo`, `browser_mcp.commit` | An `https://` Git URL and the full 40-character commit to build. |
| `browsers[]` | `profile` (the Hermes profile, `^[a-z0-9][a-z0-9-]{0,40}$`), `port` (1024 to 65535, one per browser, not 3128 or the VNC port), `client` (optional: `hermes`, the default, or `strut` for Strut's browser, at most one), `hermes_home` (that profile's Hermes folder, used only in the printed block; a `strut` browser has none), `proxy` (`none` or a proxy's name), `timezone` (optional, default `UTC`). |
| `proxies.<name>` | `env_file` (outside `root`, written by a person), `pac_hosts` (domains sent through the proxy, with their subdomains), `auth` (`allowlist` or `password`; at most one password proxy). |

In the example, `reviews.example` and `jobs.example` stand for the sites your browsers need that refuse a cloud server's address (often review sites, job and social networks, and pages behind a bot check); list your own there. Keep `challenges.cloudflare.com` beside them so a Cloudflare check leaves from the same address as its page (see "Residential proxy"). Every other host goes direct, which keeps the proxy's traffic, and its bill, small.

## Install

On the server, as the user who runs the Hermes gateway (with `loginctl enable-linger` so user units run without a login):

1. `python3 kits/unblockable-browser/unblockable_browser.py plan --config browsers.json` prints every action and changes nothing. It also prints, per browser, the Hermes block to paste.
2. `python3 kits/unblockable-browser/unblockable_browser.py apply --config browsers.json --execute` clones Browser MCP at the pinned commit into `<root>/browser-mcp/<commit>` and checks its HEAD, runs `npm ci --ignore-scripts` and `npm run build` (once per commit; `--rebuild` forces it), packages every browser in one `npm run package` call, copies each browser's extension physically into `<root>/extensions/<p>`, runs Browser MCP's doctor on each copy, writes the browser env files, PAC files, scripts and units, and runs `systemctl --user daemon-reload`. It starts nothing unless `--start` is given; the first MCP client starts a browser's broker, server and browser. `--with-tests` also runs Browser MCP's tests that start no browser (never its `browser-e2e` suite, which is headless).
3. Paste each browser's printed block into that profile's `config.yaml` under `mcp_servers` (the kit never edits Hermes config):

   ```yaml
   mcp_servers:
     browser:
       command: <root>/bin/browser-mcp
       args: []
       env:
         BROWSER_ROOT: <root>
         BROWSER_PROFILE: <p>
         BROWSER_PORT: "<port>"
         BROWSER_NODE: <node>
       connect_timeout: 150
   ```

4. Restart each profile's gateway the way its host documents (drain-aware, no run in flight). On Codex's app-server, Hermes passes the profile's `mcp_servers` to each Codex thread only with a change to Hermes itself; without it, Codex sees only `~/.codex/config.toml`.
5. `python3 kits/unblockable-browser/unblockable_browser.py verify --config browsers.json --mcp` prints a named PASS, FAIL or INFO line per check and exits 1 on any FAIL: the unit files exist and are active (an inactive broker is INFO: it starts on demand); the doctor passes on each extension copy; each browser's port listens on loopback only (from `ss -ltnH`; nothing listening is INFO, since Hermes starts the server on demand); the profile's `Preferences` holds the extension enabled from the browser's own folder; the proxy env file exists with mode 600 (its contents are never printed); with `--mcp`, `browser-mcp` answers MCP `initialize` and `tools/list` through the broker, sharing any server a gateway already holds, and reports the tool count.
6. Ask each agent in chat to open a page with its browser tools; for Strut's browser, run the package's `check` workflow (below).

`remove --config browsers.json --execute` stops and disables the kit's units, deletes only unit files that carry the kit's marker line and the kit's own folders under `root`, and keeps the browser profiles unless `--purge-profiles` is given. Without `--execute` it prints what it would do.

## Strut's browser

A browser with `"client": "strut"` is Strut's: Strut's host is its only client, and its research verbs (`browser/*`) drive it instead of a Playwright server (`strut/README.md`). The kit gives it `BROWSER_MCP_PAGE_ISOLATION=window`, so each run works in a window of its own, and prints the host settings to add (`BROWSER_ROOT`, `BROWSER_PROFILE`, `BROWSER_PORT`, `BROWSER_NODE`) instead of a Hermes block. Restart Strut once `/runs/active` is `[]`.

Strut's host can instead reach a browser over HTTP, such as the container below: set `BROWSER_MCP_URL` (`http://127.0.0.1:8930/mcp`) and `BROWSER_MCP_TOKEN` in place of `BROWSER_PROFILE` and the rest. The host then speaks MCP's Streamable HTTP to it with the token, and the verbs work as they do over stdio. Setting both kinds refuses to start.

## MCP over HTTP

`bin/browser-mcp-http.mjs` serves a browser's MCP over HTTP, for a client on another machine or in another container: MCP's Streamable HTTP at `POST /mcp`, behind a bearer token. It is plain Node with no packages, and it talks to the browser's broker, so its clients share the browser's one Browser MCP server with any stdio client. The container below runs it; on a host with the kit installed, run it as the browser's user beside the broker.

| Setting | Value |
|---|---|
| `BROWSER_MCP_TOKEN_FILE` or `BROWSER_MCP_TOKEN` | the bearer token, 32 or more characters without spaces. Prefer the file (the token then stays out of the process environment); either way it is never logged or printed. |
| `BROWSER_MCP_SOCKET` | optional: the broker's socket, default `<BROWSER_ROOT>/run/<BROWSER_PROFILE>.sock` |
| `BROWSER_MCP_HTTP_HOST`, `BROWSER_MCP_HTTP_PORT` | optional: where it listens, default `127.0.0.1` and `8930` |
| `BROWSER_MCP_SESSIONS` | optional: the most sessions open at once, default 16 |
| `BROWSER_MCP_IDLE_MS`, `BROWSER_MCP_CALL_MS` | optional: a session's idle limit (default 30 minutes) and a call's (default 10 minutes; a call past it is cancelled on the server) |
| `BROWSER_MCP_ALLOWED_ORIGINS` | optional: browser origins allowed to call, comma separated; a request with any other `Origin` header is refused |

What a client sees:

- `initialize` without a session opens one and answers with its `Mcp-Session-Id`; every later message carries it. `DELETE /mcp` with the header ends it. An unknown session gets 404, so the client initializes again.
- Every answer is one JSON body (`application/json`). There is no server stream: `GET /mcp` gets 405, and the server's own notices are not passed on. Batches are refused (400), and a body over 4 MB gets 413.
- A wrong or missing token gets 401, compared in constant time.
- `GET /healthz` (no token) answers 200 once the broker's socket exists, else 503.
- Each session is one connection to the broker. If the browser's server ends, pending calls fail and the next call reconnects in the same session; the broker starts a new server.
- The log names each call's method or tool, whether it worked and how long it took, never its arguments or answer.

It is plain HTTP: keep it on loopback, a private network, or behind a TLS proxy that keeps the `Authorization` header.

## The container

`kits/unblockable-browser/docker/Dockerfile` builds the whole browser as one image: Xvfb, Debian's Chromium (visible on the virtual screen, never headless, no remote-debugging port or pipe), Browser MCP at a pinned commit with its extension stamped for the image's profile and port, the broker, and MCP over HTTP on port 8930. The extension's port stays on the container's loopback; only the HTTP front is published. A Strut server reaches it with `BROWSER_MCP_URL` and `BROWSER_MCP_TOKEN` (*Strut's browser*, above), and any MCP client that speaks Streamable HTTP can use it the same way.

Build it from the kit's folder (the build fetches Browser MCP from its public repository):

```sh
docker build -t unblockable-browser -f kits/unblockable-browser/docker/Dockerfile kits/unblockable-browser
```

Build arguments: `BROWSER_MCP_COMMIT` (a full commit), `BROWSER_MCP_REPO`, and `BROWSER_PROFILE` and `BROWSER_PORT` (default `browser` and `21300`), which are stamped into the extension and so fixed for the image. `NODE_IMAGE` picks the base, default `node:22-bookworm-slim`.

Run it with a token file the container's user (uid 10001) can read, and the kit's seccomp profile:

```sh
openssl rand -base64 33 | tr -d '\n' > browser-mcp-token        # outside Git
sudo install -m 400 -o 10001 -g 10001 browser-mcp-token /srv/secrets/browser-mcp-token
docker run -d --name unblockable-browser --restart unless-stopped \
  --shm-size 1g \
  --security-opt seccomp=kits/unblockable-browser/docker/chromium-seccomp.json \
  --security-opt no-new-privileges \
  -p 127.0.0.1:8930:8930 \
  -v unblockable-browser-profile:/opt/unblockable-browser/profiles \
  -v /srv/secrets/browser-mcp-token:/run/secrets/browser-mcp-token:ro \
  -e BROWSER_MCP_TOKEN_FILE=/run/secrets/browser-mcp-token \
  unblockable-browser
```

- **The seccomp profile.** Chromium's sandbox makes user, PID and network namespaces as the unprivileged browser user, which Docker's default profile refuses ("No usable sandbox"). `chromium-seccomp.json` is Docker's default profile (moby/profiles at `a0fa708`) with one rule added that allows `clone`, `setns` and `unshare`; everything else is as Docker ships it. The browser keeps its sandbox: the image never passes `--no-sandbox`. With `no-new-privileges` nothing in the container can gain privileges.
- **`--shm-size 1g`.** Docker's 64 MB `/dev/shm` is too small for Chromium's renderers.
- **The profile volume** keeps sign-ins and cookies across restarts and image updates. Only one container may use it at a time; the container clears Chromium's stale single-instance lock when it starts.
- **The first `initialize`** waits for Browser MCP's server to start and the extension to connect, about ten seconds on a cold start; later ones answer at once.
- **Restarts.** The container restarts Chromium itself when it exits. If the broker, the HTTP front or the proxy forwarder ends, the container ends and its restart policy starts it again. The health check reads `/healthz`.
- **Logs** (`docker logs`) carry the front's call lines and Chromium's own messages; nothing writes the token or the proxy's sign-in.

**The proxy.** Set `PROXY_HOSTS` (comma separated, as `pac_hosts`) and either mount an env file and point `PROXY_ENV_FILE` at it (`PROXY_SERVER`, and `PROXY_USERNAME` and `PROXY_PASSWORD` for a password proxy; readable by uid 10001), or set `PROXY_SERVER` directly for an allowlist proxy. A password proxy runs through the kit's forwarder on the container's loopback (`FORWARD_PORT`, default 3128), so the sign-in never reaches Chromium or its PAC file, and the file keeps it out of the container's environment. As on a host, only the listed hosts and their subdomains use the proxy.

**Not yet in the container:** a VNC view for CAPTCHA help (at a human check a step times out and says so, as everywhere), several browsers in one container (run one container per browser, each with its own volume and port), and the kit's `verify`. On Linux with the default bridge network, `-p 127.0.0.1:8930:8930` publishes the front on the host's loopback only; with `--network host`, set `BROWSER_MCP_HTTP_HOST=127.0.0.1` so the front does not listen on every address.


## Older names

Earlier releases called a browser a *lane*, and then an *own browser* (`OWN_BROWSER_*`, `bin/own-browser-*`); now it is a browser. The *own browser* names are not read. For one more release the lane names still work: `BROWSER_LANE_ROOT`, `BROWSER_LANE_PROFILE`, `BROWSER_LANE_PORT` and `BROWSER_LANE_NODE` where the `BROWSER_*` one is unset (in `browser-mcp` and in Strut's host), a config file's `lanes` list in place of `browsers`, and `verify` and `remove` recognise units written with an earlier marker line. A host installed earlier moves over by stopping its units, renaming `~/.local/share/fleet-browser-lane` to `~/.local/share/unblockable-browser` and `~/.config/fleet-browser-lane` to `~/.config/unblockable-browser` (profiles and cookies move with them), setting `root` and `env_file` in the config file, applying, pointing each profile's `mcp_servers.browser` at `<root>/bin/browser-mcp` with the new names, and restarting the units; then delete the old `bin/browser-lane-*` (or `bin/own-browser-*`) files and `<root>/lanes`. A host on the *own browser* names renames `OWN_BROWSER_*` to `BROWSER_*` in its settings and profiles, applies, and deletes `bin/own-browser-*`; its folders already have their names.

## Updating Browser MCP

Change `browser_mcp.commit`, apply, then restart each browser's two units when its agent is idle: `systemctl --user restart fleet-browser-mcp@<p>.service fleet-browser@<p>.service`. The launcher clears the profile's service worker storage when the extension copy changed since the profile's last start, because Chromium otherwise keeps running the previous build's cached worker (the extension's version number stays the same between builds). Sign-ins and cookies stay.

## Residential proxy

Only the hosts in `pac_hosts` and their subdomains go through the proxy; everything else is `DIRECT`. A person writes the env file, mode 600, outside Git and outside the kit's root:

- `PROXY_SERVER=host:port` (both kinds).
- `PROXY_USERNAME=…` and `PROXY_PASSWORD=…` (password kind only).

**allowlist**: the provider trusts the server's IP. `apply` reads `PROXY_SERVER` and writes `PROXY host:port` into the browser's PAC file. If the value is missing, `plan` says so and `apply` refuses that browser (the others go ahead, and the run exits 1).

**password**: `fleet-proxy.service` runs `bin/proxy-forward.mjs`, a dependency-free forwarder on 127.0.0.1:3128 that tunnels CONNECT and forwards plain HTTP to `PROXY_SERVER`, adding `Proxy-Authorization` from the env file through systemd's `EnvironmentFile=`. The credentials never reach Chromium, a PAC file, a command line or a log; it logs only method, host and status, and refuses to start without its env or on a non-loopback address. The PAC file sends the listed hosts to `PROXY 127.0.0.1:3128`.

The browser gets the browser's PAC file as a `data:` URL built from the file when it starts (`--proxy-pac-url=data:…`): Chromium no longer loads a PAC script from `file://` and gives no sign when it ignores one. The script holds host names and the forwarder's address only. Restart `fleet-browser@<profile>` after a change to `pac_hosts`.

Use a sticky session if the provider rotates addresses: a new address for every connection fails Cloudflare's checks, because the check and the page come from different addresses. With ScrapeOps' Residential Proxy Aggregator, for example, `PROXY_USERNAME=scrapeops.country=us.sticky_session=<n>`. Add `challenges.cloudflare.com` to `pac_hosts` so a challenge leaves from the same address as its page.

The package's `check` workflow reports Strut's browser's egress IP, which shows whether it leaves through the proxy (api.ipify.org is not in `pac_hosts` unless added).

## CAPTCHA help

Agents stop at a CAPTCHA or human check and say so; they never solve or get around one. To help, set `vnc: true` and apply: `fleet-vnc@<display>.service` runs x11vnc on 127.0.0.1 port 5900+display (6000 for :100) with `-localhost`. From a workstation, `ssh -L 6000:127.0.0.1:6000 <server>`, point a VNC viewer at `localhost:6000`, answer the check in the agent's window, and tell the agent to continue. Set `vnc: false` and apply again afterwards.

## The Strut package

`packages/unblockable-browser/` is the Strut package `conceptive/unblockable-browser` 0.2.3, for Strut's browser. Its four workflows are made of Strut's `browser/*` steps (the host's `research` plugin registers them, beside the restricted `agent`), so the same toolset works in any workflow:

| Workflow | Kind | What it does |
| --- | --- | --- |
| `check` | declared | Opens a probe page, waits for its text, reads its tree, photographs it, reads the egress IP from an IP echo page and closes: `outcome` ok, changed or no_ip. Run it after installing or updating the browser. |
| `read-page` | declared | Opens a page, optionally waits for text, reads the page or one region (selector) and photographs it. |
| `search-site` | declared | Fills a search box by selector, presses Enter, waits, reads and photographs the results. |
| `explore` | agent | An `agent` whose only tools are the fifteen `browser/*` steps (`toolFilter: ["none"]`, `mcp: false`) answers a goal with screenshots as evidence, and reports any CAPTCHA page in `blocked`. |

None signs in, buys, posts, changes a setting or solves a CAPTCHA. The Concept *Unblockable browser steps* lists what each step does on the browser.

`node --import <strut>/node_modules/tsx/dist/esm/index.mjs packages/check-package.mjs <strut> packages/unblockable-browser` proves the package against a Strut checkout: it reads it, installs it, dry-runs its build and runs each workflow with a stand-in browser (and a stand-in agent). On a host that hands Strut its own step registry, Strut refuses every package install (`409 Installing is disabled when the registry is provided at construction time`); on such a host, publish the workflow YAML the way the org publishes its other workflows. The package is the portable form for a Strut that installs packages.

To see a Hermes agent's browser work, ask the agent in chat to open a page with its `mcp__browser__*` tools.

## What it never does

- Never runs Chromium headless and never opens a remote-debugging port or pipe; the launcher refuses either flag even if one reached its command line, and the unit renderer refuses a template carrying one.
- Never shares a user-data folder, extension copy or port between profiles.
- Never listens off loopback (the MCP server, the forwarder and VNC). The one exception is the container's HTTP front, which listens on the container's own network behind its token; publish it on the host's loopback or a private network.
- Never puts a credential on a command line, in Git, in a log or in its output.
- Never writes outside `root` and `~/.config/systemd/user/`, never follows or writes a symlink there, and copies files physically.
- Never edits Hermes config, never restarts a gateway, and never starts a unit without `--start`.
- Never acts without `--execute`.

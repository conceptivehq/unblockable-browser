# conceptive/unblockable-browser

A Strut package for Strut's own unblockable browser: a visible Chromium on a Linux server's virtual display that Strut drives through Browser MCP and its extension, in place of a Playwright server. Sites see an ordinary desktop Chrome with a real profile and, where the browser names one, a residential address. The browser never runs headless and has no remote-debugging port.

The kit (`kits/unblockable-browser`) installs the browser, and Strut's browser (`Browser`, handed to Strut by its host) connects Strut's `browser/*` steps to it. This package holds four workflows built from those steps and the Concepts that explain them.

## How a step reaches the browser

```
browser/* step ─▶ Strut host (Browser) ─stdio─▶ browser-mcp ─unix socket─▶ broker
                                                                                     │
          Chromium on Xvfb :100 (fleet-browser@strut) ◀─ extension ◀─ws─ Browser MCP server 127.0.0.1:<port>
```

- The host spawns the kit's adapter once and keeps it. The adapter starts the browser's broker, the broker its one server, the server the browser's Chromium.
- Each run gets a window of its own (`BROWSER_MCP_PAGE_ISOLATION=window`), closed when the run ends. A run's calls take turns in the order they were sent.
- Addresses are checked against a deny list (file:, loopback, private networks, cloud metadata) before each navigation and again where the page landed.

## The steps

Every workflow here is made of Strut's own `browser/*` steps, so the same toolset works in any workflow: as declared steps with selectors, or as an agent's tools with refs. See the Concept *Unblockable browser steps* for what each one does on the browser.

| Read | Act | Wait and keep |
| --- | --- | --- |
| `browser/open`, `browser/goto`, `browser/back` | `browser/click`, `browser/fill`, `browser/type` | `browser/wait` (text, url, ref, selector or ms) |
| `browser/snapshot` (tree with `[ref=eN]`) | `browser/press`, `browser/select`, `browser/hover` | `browser/screenshot` (`shots/*.png`) |
| `browser/text` (page, ref or selector) | `browser/scroll` | `browser/close` |

Selectors are CSS, `text=…` or `role=…[name=…]`. On a Strut whose step list has them, `browser/evaluate` and `browser/capture` work too. The browser refuses, with the reason: kept pages across runs (`session`), a Playwright `storageState`, a right click and Playwright-only selector chains. A screenshot is always the window's view, also when `fullPage` or an element is asked for.

## The workflows

| Workflow | Kind | Input | Output |
| --- | --- | --- | --- |
| `check` | declared | `probe_url?`, `expect_text?`, `wait_ms?`, `ip_url?` | `outcome` (ok, changed, no_ip), `egress_ip`, `title`, `tree_chars`, `screenshot`, `error` |
| `read-page` | declared | `url`, `selector?`, `wait_for?` | `url`, `title`, `status`, `text`, `screenshot` |
| `search-site` | declared | `url`, `search_box`, `query`, `results?`, `expect_text?` | `url`, `text`, `screenshot` |
| `explore` | agent | `goal`, `url` | `answer`, `evidence`, `pages`, `blocked`, `error`, `cost` |

- `check` opens a probe page, waits for its text, reads its tree, photographs it, reads the address the web sees and closes. Run it after installing or updating the browser.
- `read-page` and `search-site` are declared routes: no model, the author names the elements.
- `explore` hands the fifteen steps to an `agent` as tools and nothing else (`toolFilter: ["none"]`, `mcp: false`). It reads with `browser_snapshot`, acts on refs and photographs its evidence.

None of them signs in, buys, posts or changes a setting, and none solves a CAPTCHA: a declared wait times out and says so; the agent stops and reports the page in `blocked` (see *CAPTCHA help*).

## Setting it up

1. Add Strut's browser to the kit's config file and apply it on the server (see `docs/unblockable-browser.md`, "Strut's browser"):

   ```json
   {"profile": "strut", "port": 21203, "client": "strut", "proxy": "residential", "timezone": "America/Los_Angeles"}
   ```

   `proxy` is optional (see *Residential proxy*). A `client: strut` browser gets no Hermes block; `plan` prints the Strut settings instead.

2. Give Strut's host the browser in its env file, and no other browser (`BROWSER_WS_URL`, `BROWSER_WS_PATH` and `BROWSER_CDP_URL` unset):

   | Setting | Value |
   | --- | --- |
   | `BROWSER_PROFILE` | `strut` |
   | `BROWSER_PORT` | the browser's port |
   | `BROWSER_ROOT` | the kit's root (default `~/.local/share/unblockable-browser`) |
   | `BROWSER_NODE` | Node 22 or newer |
   | `BROWSER_RUN_BUDGET_MS` | optional: one run's browser time |

3. Turn on the host's `research` plugin (it registers the browser steps and the restricted `agent`), restart Strut when no run is active, and run `check`.

## On a host that hands Strut its own step registry

A host that builds Strut with its own step registry (`createStrut({ registry })`) cannot install this package: Strut then refuses every package install (`409 Installing is disabled when the registry is provided at construction time`). On such a host, publish each file in `workflows/` as plain YAML, the way the host publishes its other workflows, and keep the Concepts as documentation. The workflows are the same either way; the package is the form for a Strut that installs packages.

## Requirements

The workflows use Strut's `browser/*` steps, `agent` (for `explore`), `if` and `pack`. A host with its own step list must include them. On a Strut without a browser service every browser step fails, naming the missing service.

`node --import <strut>/node_modules/tsx/dist/esm/index.mjs ../check-package.mjs <strut> .` (from this folder) reads, installs, dry-run builds and runs the package against a Strut checkout, with a stand-in browser. On the server the browser needs `chromium`, `Xvfb`, `node`, `python3`, `git` and `npm`.

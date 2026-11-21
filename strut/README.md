# Strut's browser

`src/browser.ts` is `Browser`, an implementation of Strut's `StrutBrowser` interface (Strut `d4e6595` and later). Hand it to Strut as its browser service and Strut's own `browser/*` steps, in declared steps or as an agent's tools, drive a browser from the kit (`"client": "strut"` in the kit's config file) instead of a Playwright server. `src/browser-env.ts` picks the browser from a host's `BROWSER_*` settings.

## Wiring it into a Strut host

```ts
import { createStrut } from "strut";
import { browserOptionsFromEnv, researchBrowser } from "./browser-env.js";

const browser = researchBrowser(browserOptionsFromEnv(process.env, { home: process.env.HOME, path: process.env.PATH }));
const strut = await createStrut({
  // …your other options
  services: {
    browser,
    // close each run's window when the run ends
    onRunEnd: async (runId: string) => browser.dispose(runId),
  },
});
// on shutdown: await browser.close();
```

`researchBrowser` gives Strut's browser when `BROWSER_PROFILE` is set, a Playwright server when `BROWSER_WS_URL` or `BROWSER_CDP_URL` is set (refusing both at once), and otherwise a browser that refuses every call with the reason. It never launches a headless browser.

| Setting | Value |
|---|---|
| `BROWSER_PROFILE`, `BROWSER_PORT` | the browser's profile and port from the kit's config file, such as `strut` and `21203` |
| `BROWSER_ROOT` | optional, default `~/.local/share/unblockable-browser` |
| `BROWSER_NODE` | optional: the Node.js the browser's broker runs on |
| `BROWSER_RUN_BUDGET_MS`, `BROWSER_STEP_TIMEOUT_MS`, `BROWSER_URL_DENY` | as for Strut's Playwright browser |

The kit's `plan` prints the first four for a `client: strut` browser. Restart Strut only when no run is active.

## How it reaches the page

The host spawns the kit's stdio adapter (`<root>/bin/browser-mcp`) once and keeps it. The adapter starts the browser's broker, the broker its one Browser MCP server, and the server the browser's Chromium. Each run gets a window of its own and every call names its tab; a run's calls take turns in the order they were sent.

## Where it differs from Strut's Playwright browser

- `browser/snapshot` is the browser's accessibility tree in Strut's form (`- role "name" [ref=eN]`), at most 800 lines. Refs work for every node and are dropped when the page loads a new document.
- Selectors are `text=…`, `role=…[name=…]` or CSS. Playwright's chains (`>>`, whatever comes first), `:has-text()`, `:text()`, `:visible`, `nth=` and XPath are refused with the reason, so prefer refs.
- Chrome's element errors come back in plain words: a hidden element is "not visible on the page", and a removed one "no longer on the page".
- A click is a real press at the element's centre; a right click is refused, and a double click is two clicks.
- Kept pages (`session`) and `storageState` are refused: the browser keeps its own profile, and runs share it the way two people share one browser.
- A screenshot is always the window's view, also when `fullPage` or an element is asked for.
- `evaluate` runs a script in the page and answers its JSON, cut at 50,000 characters. `capture` opens a page, runs its steps and photographs the window; it refuses `keydown` and `keyup`, and its `errors` are always empty.
- `observe`, `state`, `tap`, `keydown`, `keyup`, `captcha`, `verify`, `walkthrough`, app `look` and `keep` are refused, each with its reason.
- Every navigation is checked against the deny list (file:, loopback, private networks, cloud metadata) before it starts and again where the page landed; a page that lands on a denied address is closed.

## Building and testing

```sh
npm run setup       # npm ci, then Strut fetched at its pinned commit into .strut and linked as node_modules/strut
npm run typecheck
npm test            # on a stand-in browser (test/fixtures/fake-browser.mjs); no Chromium starts
```

Strut is not an npm dependency. `scripts/setup-strut.mjs` clones it from its public repository at the commit this code is built against, installs its own locked dependencies and builds it, so Strut loads one copy of `zod` and `ai` with this code.

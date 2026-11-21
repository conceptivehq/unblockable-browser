/**
 * The browser Strut's browser steps drive on this host, chosen from the BROWSER_* environment: Strut's unblockable
 * browser on this host (BROWSER_PROFILE and BROWSER_PORT, browser.ts) or over HTTP, such as the kit's container
 * (BROWSER_MCP_URL and BROWSER_MCP_TOKEN), a Playwright server (BROWSER_WS_URL and BROWSER_WS_PATH) or a real Chrome
 * (BROWSER_CDP_URL). Strut's own fallback, a local headless launch, is never used: without one of them
 * every browser verb fails with the reason.
 */
import { join } from "node:path";
import { BrowserService, type BrowserServiceOptions, type StrutBrowser } from "strut";
import { HOST_URL_DENY, Browser, type BrowserOptions } from "./browser.js";

/** Strut's BrowserServiceOptions, or Strut's unblockable browser (`unblockable`). */
export type ResearchBrowserOptions = BrowserServiceOptions & { unblockable?: BrowserOptions };

/** The browser the host hands Strut (`services.browser`): Strut's verbs, and `close` for the host's shutdown. */
export type HostBrowser = StrutBrowser & { close(): Promise<void> };

/** A browser that refuses every call, with the reason. */
export function refusingBrowser(reason: string): HostBrowser {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") return undefined;
        // Cleanup has nothing to do: no page was ever opened.
        if (prop === "dispose" || prop === "close") return async () => {};
        return () => {
          throw new Error(reason);
        };
      },
    },
  ) as HostBrowser;
}

/** The research browser: Strut's browser, a Playwright server or a real Chrome, never a local launch. */
export function researchBrowser(opts: ResearchBrowserOptions): HostBrowser {
  if (opts.unblockable) {
    if (opts.wsUrl || opts.cdpUrl) throw new Error("browser: set BROWSER_PROFILE or BROWSER_MCP_URL (Strut's browser) or BROWSER_WS_URL / BROWSER_CDP_URL, not both");
    // Browser implements StrutBrowser, the verbs Strut's browser steps call (browser.ts).
    return new Browser(opts.unblockable);
  }
  if (!opts.wsUrl && !opts.cdpUrl) {
    return refusingBrowser("Strut's browser is not set up on this host: BROWSER_PROFILE (Strut's browser here), BROWSER_MCP_URL (Strut's browser over HTTP) or BROWSER_WS_URL (a visible Playwright server) is missing. Strut never launches a headless browser of its own.");
  }
  return new BrowserService(opts);
}

/** The research browser's options from the BROWSER_* environment: the names Strut's own BrowserService.fromEnv
 *  reads, and BROWSER_* for Strut's browser (the block the unblockable browser kit prints for it). `host` gives
 *  the browser's adapter its HOME and PATH. */
export function browserOptionsFromEnv(env: Record<string, string | undefined>, host: { home?: string; path?: string } = {}): ResearchBrowserOptions {
  const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const [width, height] = (env.BROWSER_VIEWPORT ?? "1280x800").split("x").map(Number);
  const stepTimeoutMs = num(env.BROWSER_STEP_TIMEOUT_MS, 15_000);
  const runBudgetMs = num(env.BROWSER_RUN_BUDGET_MS, 4 * 60 * 60 * 1000);
  const deny = env.BROWSER_URL_DENY || HOST_URL_DENY;
  const home = host.home ?? "";
  // BROWSER_*, or the BROWSER_LANE_* names from before 0.8.0 (read for one more release; 0.8.0's OWN_BROWSER_* are not).
  const setting = (key: string) => env[`BROWSER_${key}`] || env[`BROWSER_LANE_${key}`];
  const profile = setting("PROFILE");
  const node = setting("NODE");
  const mcpUrl = env.BROWSER_MCP_URL;
  // Over HTTP the browser needs only its URL and token. With BROWSER_PROFILE set too, Browser refuses both.
  const unblockable: BrowserOptions | undefined = mcpUrl
    ? { mcp: { url: mcpUrl, token: env.BROWSER_MCP_TOKEN ?? "" }, ...(profile ? { profile } : {}), stepTimeoutMs, runBudgetMs, deny }
    : profile
    ? {
        root: setting("ROOT") || join(home, ".local", "share", "unblockable-browser"),
        profile,
        port: Number(setting("PORT")),
        ...(node ? { node } : {}),
        env: { ...(host.path ? { PATH: host.path } : {}), ...(home ? { HOME: home } : {}) },
        stepTimeoutMs,
        runBudgetMs,
        deny,
      }
    : undefined;
  return {
    ...(unblockable ? { unblockable } : {}),
    ...(env.BROWSER_WS_URL ? { wsUrl: env.BROWSER_WS_URL } : {}),
    ...(env.BROWSER_WS_PATH ? { wsPath: env.BROWSER_WS_PATH } : {}),
    ...(env.BROWSER_CDP_URL ? { cdpUrl: env.BROWSER_CDP_URL } : {}),
    viewport: { width: width || 1280, height: height || 800 },
    stepTimeoutMs,
    runBudgetMs,
    deny,
  };
}

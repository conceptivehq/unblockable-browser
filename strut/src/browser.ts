/**
 * Strut's browser verbs on Strut's unblockable browser (kits/unblockable-browser, the browser with
 * `client: strut`). The research steps (browser/open, goto, snapshot, text, click, fill, type, press, scroll,
 * select, hover, back, wait, screenshot, close) keep their inputs and outputs; only the browser behind them changes:
 * instead of a Playwright server, a visible Chromium the host drives through the browser's Browser MCP server and its
 * extension, the same way the fleet's agents drive theirs.
 *
 * The chain: this host spawns the kit's stdio adapter (<root>/bin/browser-mcp) once and keeps it; the adapter
 * starts the browser's broker if it is not running, the broker its one Browser MCP server, the server the browser's
 * Chromium. Or, for the kit's container (or any browser behind the kit's bin/browser-mcp-http.mjs), the host speaks
 * MCP's Streamable HTTP to its /mcp URL with a bearer token (BROWSER_MCP_URL, BROWSER_MCP_TOKEN). The browser runs in
 * window mode (BROWSER_MCP_PAGE_ISOLATION=window), so each run's page is a window of its own and every call names its
 * tab.
 *
 * What differs from the Playwright service, by design or because the browser has no such tool:
 *   - refs come from the browser's own snapshot (`[ref=eN]`, as Strut's); a page longer than the browser's 800 lines lists
 *     its first 800 (browser/text still reads the whole page).
 *   - selectors are `text=…`, `role=…[name=…]` or CSS, found in the page; Playwright's chains and pseudo-classes are
 *     refused with that reason.
 *   - kept pages (`session`) and storageState are refused: the browser signs in with its own profile.
 *   - screenshots are the window's viewport (fullPage and an element crop are not available); the viewport is the
 *     window's own size, not BROWSER_VIEWPORT.
 *   - a right-click is refused; a double-click is two clicks.
 *   - capture runs, but its `errors` are always empty, and its steps cannot hold keys (keydown, keyup).
 *   - observe, state, tap, keydown, keyup, captcha, verify, walkthrough, app look and keep are refused, each with why.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserService, jobFileUrl, type ShotSink, type StrutBrowser } from "strut";

type Target = { ref?: string; selector?: string };
type Navigated = { url: string; title: string; status: number };

export interface BrowserOptions {
  /** The kit's root (BROWSER_ROOT), Strut's browser (BROWSER_PROFILE, BROWSER_PORT) and Node: the browser on this host. */
  root?: string;
  profile?: string;
  port?: number;
  node?: string;
  /** Or the browser over MCP's Streamable HTTP (BROWSER_MCP_URL, BROWSER_MCP_TOKEN), such as the kit's container. */
  mcp?: { url: string; token: string };
  /** PATH and HOME for the adapter: the host's own environment is cleared before the host is built. */
  env?: Record<string, string>;
  stepTimeoutMs?: number;
  runBudgetMs?: number;
  /** BROWSER_URL_DENY, as Strut reads it (default HOST_URL_DENY). */
  deny?: string;
  /** Tests: a command that speaks MCP on stdio in place of the adapter. */
  command?: { file: string; args: string[] };
  /** Tests: the pause after each action (default 150 ms) and the DOM-quiet wait (default on). */
  settle?: { fixedMs?: number; quiet?: boolean };
}

/** Strut's default (file:, the cloud metadata range) and this host's own loopback and private networks. */
export const HOST_URL_DENY = "file:,169.254.0.0/16,fd00::/8,127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,::1/128,0.0.0.0/8,localhost";

export const BROWSER_TREE_CAP = 100_000;
export const BROWSER_TEXT_CAP = 50_000;
/** The verbs a capture's steps may name: Strut's CAPTURE_VERBS without keydown and keyup. */
export const CAPTURE_STEPS = ["goto", "click", "fill", "type", "press", "select", "hover", "scroll", "wait", "text", "evaluate", "back"] as const;
type CaptureStepVerb = (typeof CAPTURE_STEPS)[number];
/** The first new_page may wait for the browser's Chromium to start and its extension to connect (90 s). */
const FIRST_PAGE_MS = 120_000;
/** Each call's slack over its own timeout, for the round trip through the adapter. */
const SLACK_MS = 5_000;
const MODEL_SCALE = 0.6;
const MARK = "data-fleet-browser";

interface ToolAnswer {
  text: string;
  images: Array<{ data: string; mimeType: string }>;
}

/** What Browser needs of an MCP client: tool calls, and closing. */
interface McpClient {
  call(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<ToolAnswer>;
  close(): void;
}

/** A tool call's result, as both clients read it. */
function toolAnswer(name: string, result: any): ToolAnswer {
  const content: any[] = Array.isArray(result?.content) ? result.content : [];
  const text = content.filter((c) => c.type === "text").map((c) => String(c.text ?? "")).join("\n");
  if (result?.isError) throw new Error(plainError(text.replace(/^Error:\s*/, "").split("\n")[0] || `${name} failed`));
  const images = content.filter((c) => c.type === "image" && typeof c.data === "string").map((c) => ({ data: c.data as string, mimeType: String(c.mimeType ?? "") }));
  return { text, images };
}

/** A minimal MCP client on the adapter's stdio: one JSON-RPC message per line. */
class BrowserClient implements McpClient {
  private child?: ChildProcess;
  private ready?: Promise<void>;
  private buf = "";
  private next = 0;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly start: () => ChildProcess) {}

  private connect(): Promise<void> {
    if (this.ready) return this.ready;
    const child = this.start();
    this.child = child;
    this.buf = "";
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => (stderr = (stderr + d).slice(-2000)));
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => this.onData(d));
    child.stdin!.on("error", () => {});
    const gone = (why: string) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.ready = undefined;
      const last = stderr.trim().split("\n").pop();
      const err = new Error(`the browser's MCP adapter ${why}${last ? `: ${last}` : ""}`);
      for (const w of this.waiting.values()) {
        clearTimeout(w.timer);
        w.reject(err);
      }
      this.waiting.clear();
    };
    child.on("exit", (code, signal) => gone(`exited (${code ?? signal})`));
    child.on("error", (e) => gone(`could not start (${e.message})`));
    const ready = (async () => {
      await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "strut-browser", version: "1" } }, 30_000);
      this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    })();
    this.ready = ready;
    ready.catch(() => {
      if (this.child === child) child.kill();
    });
    return ready;
  }

  private send(msg: unknown): void {
    this.child?.stdin?.write(`${JSON.stringify(msg)}\n`);
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.method && msg.id !== undefined) {
        // A request from the server (ping, roots): answer it empty.
        this.send({ jsonrpc: "2.0", id: msg.id, result: {} });
        continue;
      }
      const w = msg.id !== undefined ? this.waiting.get(msg.id) : undefined;
      if (!w) continue;
      this.waiting.delete(msg.id);
      clearTimeout(w.timer);
      if (msg.error) w.reject(new Error(String(msg.error.message ?? JSON.stringify(msg.error))));
      else w.resolve(msg.result);
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async call(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<ToolAnswer> {
    await this.connect();
    return toolAnswer(name, await this.request("tools/call", { name, arguments: args }, timeoutMs));
  }

  close(): void {
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
    if (!child) return;
    child.stdin?.end();
    setTimeout(() => child.kill(), 500).unref();
  }
}

/** The session is gone on the server (404): the request never ran, so it may be sent again in a new session. */
class SessionGone extends Error {}

/**
 * A minimal MCP client on Streamable HTTP: one POST per message, the session in Mcp-Session-Id, the bearer token in
 * Authorization. An answer comes back as JSON or as a server-sent event stream; both are read. A session the server
 * no longer knows is opened again once (the call never ran in it). The token is never part of an error.
 */
class HttpBrowserClient implements McpClient {
  private session?: string;
  private protocol?: string;
  private ready?: Promise<void>;
  private next = 0;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private async post(msg: { id?: number; method: string; params?: unknown }, timeoutMs: number): Promise<any> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${this.token}`,
          ...(this.session ? { "mcp-session-id": this.session } : {}),
          ...(this.protocol ? { "mcp-protocol-version": this.protocol } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", ...msg }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } };
      if (err.name === "TimeoutError" || err.name === "AbortError") throw new Error(`timed out after ${timeoutMs} ms`);
      throw new Error(`the browser's MCP server is not reachable (${err.cause?.code ?? err.message})`);
    }
    if (res.status === 404 && this.session) {
      this.session = undefined;
      this.ready = undefined;
      throw new SessionGone("the browser's MCP session ended");
    }
    if (res.status === 401 || res.status === 403) throw new Error(`the browser's MCP server refused this host (${res.status}): check BROWSER_MCP_TOKEN`);
    if (msg.id === undefined) {
      if (res.status >= 300) throw new Error(`the browser's MCP server answered ${res.status} to ${msg.method}`);
      return undefined;
    }
    const type = res.headers.get("content-type") ?? "";
    const body = await res.text();
    let answer: any;
    if (type.startsWith("text/event-stream")) {
      for (const event of body.split(/\r?\n\r?\n/)) {
        const data = event
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        try {
          const m = JSON.parse(data);
          if (m?.id === msg.id) answer = m;
        } catch {}
      }
    } else {
      try {
        answer = JSON.parse(body);
      } catch {}
    }
    if (!answer || answer.id !== msg.id) throw new Error(`the browser's MCP server answered ${res.status} without an answer to ${msg.method}`);
    if (answer.error) throw new Error(String(answer.error.message ?? JSON.stringify(answer.error)));
    if (msg.method === "initialize") {
      this.session = res.headers.get("mcp-session-id") ?? undefined;
      this.protocol = typeof answer.result?.protocolVersion === "string" ? answer.result.protocolVersion : undefined;
    }
    return answer.result;
  }

  private connect(): Promise<void> {
    if (this.ready) return this.ready;
    const ready = (async () => {
      this.session = undefined;
      this.protocol = undefined;
      // The first initialize may wait for the browser's server to start and its extension to connect.
      await this.post({ id: ++this.next, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "strut-browser", version: "1" } } }, 120_000);
      await this.post({ method: "notifications/initialized" }, 30_000);
    })();
    this.ready = ready;
    ready.catch(() => {
      if (this.ready === ready) this.ready = undefined;
    });
    return ready;
  }

  async call(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<ToolAnswer> {
    for (let attempt = 0; ; attempt++) {
      await this.connect();
      try {
        return toolAnswer(name, await this.post({ id: ++this.next, method: "tools/call", params: { name, arguments: args } }, timeoutMs));
      } catch (e) {
        if (e instanceof SessionGone && attempt === 0) continue;
        throw e;
      }
    }
  }

  close(): void {
    const session = this.session;
    this.session = undefined;
    this.ready = undefined;
    if (!session) return;
    fetch(this.url, { method: "DELETE", headers: { authorization: `Bearer ${this.token}`, "mcp-session-id": session }, signal: AbortSignal.timeout(5_000) }).catch(() => {});
  }
}

interface Line {
  uid: string;
  depth: number;
  role: string;
  name: string;
}

interface Run {
  tab?: number;
  startedAt: number;
  refs: Set<string>;
  lines: Line[];
  /** performance.timeOrigin of the page the refs were read on: a new document resets them. */
  doc?: number;
}

/** The page lines every tool answers with. */
export function pageOf(text: string): { tab?: number; title: string; url: string } {
  const tab = /^Tab ID: (\d+)$/m.exec(text)?.[1];
  return { tab: tab ? Number(tab) : undefined, title: /^Title: (.*)$/m.exec(text)?.[1] ?? "", url: /^URL: (.*)$/m.exec(text)?.[1] ?? "" };
}

/** The browser's aria snapshot (`role "name" [uid=@eN]`, indented two spaces a level) as Strut's tree (`- role "name"
 *  [ref=eN]`), with its lines for browser/text on a ref. */
export function treeOf(text: string): { tree: string; lines: Line[]; refs: Set<string> } {
  const out: string[] = [];
  const lines: Line[] = [];
  const refs = new Set<string>();
  // The browser indents by every DOM ancestor, the unnamed wrappers too; the tree nests by the lines it shows.
  const open: { depth: number; name: string }[] = [];
  let body = false;
  for (const raw of text.split("\n")) {
    if (!body) {
      if (/^Page changed: /.test(raw)) body = true;
      continue;
    }
    // A link's address (Browser MCP cbb07a1 and later) goes under the link, as Playwright's tree has it.
    const url = /^ *\/url: (\S+)$/.exec(raw);
    if (url) {
      out.push(`${"  ".repeat(open.length)}- /url: ${url[1]}`);
      continue;
    }
    const m = /^( *)(\S+) ("(?:[^"\\]|\\.)*") \[uid=@(e\d+)\]$/.exec(raw);
    if (!m) {
      if (raw.trim()) out.push(`# ${raw.trim()}`);
      continue;
    }
    const depth = m[1]!.length / 2;
    const role = m[2]!;
    let name = "";
    try {
      name = JSON.parse(m[3]!) as string;
    } catch {
      name = m[3]!.slice(1, -1);
    }
    const uid = m[4]!;
    lines.push({ uid, depth, role, name });
    while (open.length && open[open.length - 1]!.depth >= depth) open.pop();
    const pad = "  ".repeat(open.length);
    if (role === "StaticText") {
      // A button's or link's own words come again as its text: the line above already says them.
      if (name && name !== open[open.length - 1]?.name) out.push(`${pad}- text: ${JSON.stringify(name)}`);
      continue;
    }
    refs.add(uid);
    out.push(`${pad}- ${role}${name ? ` ${JSON.stringify(name)}` : ""} [ref=${uid}]`);
    open.push({ depth, name });
  }
  return { tree: out.join("\n"), lines, refs };
}

/** The element's own name and its descendants' names, from the last snapshot. */
export function textUnder(lines: Line[], uid: string): string | undefined {
  const at = lines.findIndex((l) => l.uid === uid);
  if (at < 0) return undefined;
  const parts = [lines[at]!.name];
  for (let i = at + 1; i < lines.length && lines[i]!.depth > lines[at]!.depth; i++) parts.push(lines[i]!.name);
  return parts.filter(Boolean).join("\n");
}

/** Finds the selector's element in the page and marks it (MARK=token); answers whether it found one. Selectors:
 *  `text=Annual` (contains, any case), `text="Annual"` (exact), `role=button[name="Save"]` (contains, any case), CSS. */
export const FIND_FN = String.raw`(sel, token) => {
  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const quoted = (s) => { const m = /^(["'])([\s\S]*)\1([is])?$/.exec(s.trim()); return m ? { v: m[2], exact: m[3] !== "i" } : { v: s.trim(), exact: false }; };
  const matches = (hay, q) => q.exact ? norm(hay) === norm(q.v) : norm(hay).toLowerCase().includes(norm(q.v).toLowerCase());
  const visible = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none"; };
  const name = (el) => {
    const by = el.getAttribute("aria-labelledby");
    if (by) { const t = by.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => n.innerText).join(" "); if (norm(t)) return t; }
    for (const v of [el.getAttribute("aria-label"), el.labels && el.labels[0] && el.labels[0].innerText, el.getAttribute("alt"), el.getAttribute("title")]) if (norm(v)) return v;
    if (el.tagName === "INPUT" && ["button", "submit", "reset"].includes(el.type)) return el.value;
    const t = el.innerText; if (norm(t)) return t;
    return el.getAttribute("placeholder") || el.value || "";
  };
  const IMPLICIT = { button: "button,input[type=button],input[type=submit],input[type=reset],summary", link: "a[href],area[href]",
    textbox: "input:not([type]),input[type=text],input[type=email],input[type=tel],input[type=url],input[type=password],input[type=number],textarea,[contenteditable=''],[contenteditable=true]",
    searchbox: "input[type=search]", checkbox: "input[type=checkbox]", radio: "input[type=radio]", combobox: "select", listbox: "select[multiple]",
    heading: "h1,h2,h3,h4,h5,h6", img: "img", list: "ul,ol", listitem: "li", option: "option", navigation: "nav", main: "main", dialog: "dialog", article: "article", row: "tr", cell: "td" };
  let found = null;
  const s = sel.trim();
  // Playwright's chains (a >> b), xpath and nth are refused whatever the first part is: text=… >> … is not a text.
  if (/>>|^xpath=|^nth=|^\/\//.test(s)) throw new Error("selector " + JSON.stringify(sel) + " is not supported on the browser: use text=…, role=…[name=…] or CSS");
  if (/^text=/.test(s)) {
    const q = quoted(s.slice(5));
    const all = [...document.body.querySelectorAll("*")].filter((el) => !["SCRIPT", "STYLE", "NOSCRIPT"].includes(el.tagName) && matches(el.innerText || "", { v: q.v, exact: false }));
    const deepest = all.filter((el) => ![...el.children].some((c) => all.includes(c)));
    found = deepest.find((el) => visible(el) && matches(el.innerText || "", q)) || deepest.find((el) => matches(el.innerText || "", q)) || null;
  } else if (/^role=/.test(s)) {
    const m = /^role=([a-z]+)(?:\[name=([\s\S]*)\])?$/.exec(s);
    if (!m) throw new Error("role selectors are role=<role> or role=<role>[name=\"…\"] on the browser");
    const css = '[role~="' + m[1] + '"]' + (IMPLICIT[m[1]] ? "," + IMPLICIT[m[1]] : "");
    const q = m[2] === undefined ? null : quoted(m[2]);
    const all = [...document.querySelectorAll(css)].filter((el) => !q || matches(name(el), q));
    found = all.find(visible) || all[0] || null;
  } else {
    const css = s.replace(/^css=/, "");
    if (/:has-text\(|:text\(|:visible|nth=|xpath=/.test(css)) throw new Error("selector " + JSON.stringify(sel) + " is not supported on the browser: use text=…, role=…[name=…] or CSS");
    const all = [...document.querySelectorAll(css)];
    found = all.find(visible) || all[0] || null;
  }
  for (const old of document.querySelectorAll("[${MARK}]")) old.removeAttribute("${MARK}");
  if (!found) return false;
  found.setAttribute("${MARK}", token);
  return true;
}`;

/** In-page: give a <select> the option whose value or visible label is `want`, as a person picking it would. */
const SELECT_FN = `(el, want) => {
  if (!el || el.tagName !== "SELECT") throw new Error("the element is not a <select>");
  const norm = (s) => String(s).replace(/\\s+/g, " ").trim();
  const opt = [...el.options].find((o) => o.value === want) || [...el.options].find((o) => norm(o.label) === norm(want));
  if (!opt) throw new Error("no option with value or label " + JSON.stringify(want));
  el.value = opt.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}`;

/** In-page: a text field's value, set the way a person's typing ends. */
const FILL_FN = `(el, value) => {
  if (!el) throw new Error("no element");
  el.focus();
  if (el.isContentEditable) { el.textContent = value; el.dispatchEvent(new InputEvent("input", { bubbles: true })); return true; }
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}`;

const HOVER_FN = `(el) => {
  el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) el.dispatchEvent(new (t.startsWith("pointer") ? PointerEvent : MouseEvent)(t, o));
  return true;
}`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Chrome's protocol errors about an element, as Browser MCP passes them on, in words a workflow's agent can act on. */
const ELEMENT_ERRORS: Array<[RegExp, string]> = [
  [/Could not compute box model|Node does not have a layout object/i, "the element is not visible on the page (hidden, collapsed or of no size); take a new snapshot and use a visible element, or open what hides it first"],
  [/Node is detached|No node with given id|Could not find node with given id/i, "the element is no longer on the page; take a new snapshot"],
];
export function plainError(text: string): string {
  let said = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && typeof (parsed as { message?: unknown }).message === "string") said = (parsed as { message: string }).message;
  } catch {
    // not JSON: the text as it is
  }
  for (const [pattern, words] of ELEMENT_ERRORS) if (pattern.test(said)) return words;
  return text;
}
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Loads sharp from Strut's own dependencies (a native module, so a host without it fails a screenshot, not the boot). */
function sharpOf(): any {
  const strutEntry = fileURLToPath(import.meta.resolve("strut"));
  return createRequire(strutEntry)("sharp");
}

/** Strut's browser verbs (`StrutBrowser`, Strut d4e6595 and later): a change to a verb in Strut fails this build. */
export class Browser implements StrutBrowser {
  private readonly client: McpClient;
  private readonly runs = new Map<string, Run>();
  private readonly stepTimeoutMs: number;
  private readonly runBudgetMs: number;
  /** Strut's own denylist check (the service is built for it only: it connects to nothing). */
  private readonly denier: BrowserService;
  private readonly fixedMs: number;
  private readonly quiet: boolean;
  private token = 0;

  constructor(private readonly opts: BrowserOptions) {
    if (opts.mcp) {
      if (opts.profile || opts.command) throw new Error("browser: set BROWSER_MCP_URL (a browser over HTTP) or BROWSER_PROFILE (the browser on this host), not both");
      let url: URL;
      try {
        url = new URL(opts.mcp.url);
      } catch {
        throw new Error("BROWSER_MCP_URL must be an http:// or https:// URL");
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("BROWSER_MCP_URL must be an http:// or https:// URL");
      if (url.username || url.password) throw new Error("BROWSER_MCP_URL must not hold a sign-in: the token goes in BROWSER_MCP_TOKEN");
      if (!opts.mcp.token || /\s/.test(opts.mcp.token)) throw new Error("BROWSER_MCP_TOKEN must be set (the browser's bearer token, without spaces)");
    } else {
      if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(opts.profile ?? "")) throw new Error("BROWSER_PROFILE must match ^[a-z0-9][a-z0-9-]{0,40}$");
      if (!Number.isInteger(opts.port) || opts.port! < 1024 || opts.port! > 65535) throw new Error("BROWSER_PORT must be a port from 1024 to 65535");
      if (!opts.root?.startsWith("/")) throw new Error("BROWSER_ROOT must be an absolute path");
    }
    this.stepTimeoutMs = opts.stepTimeoutMs ?? 15_000;
    this.runBudgetMs = opts.runBudgetMs ?? 4 * 60 * 60 * 1000;
    this.denier = new BrowserService({ deny: opts.deny ?? HOST_URL_DENY });
    this.fixedMs = opts.settle?.fixedMs ?? 150;
    this.quiet = opts.settle?.quiet ?? true;
    if (opts.mcp) {
      this.client = new HttpBrowserClient(opts.mcp.url, opts.mcp.token);
      return;
    }
    const env: Record<string, string> = {
      ...(opts.env ?? {}),
      BROWSER_ROOT: opts.root!,
      BROWSER_PROFILE: opts.profile!,
      BROWSER_PORT: String(opts.port),
      ...(opts.node ? { BROWSER_NODE: opts.node } : {}),
    };
    const command = opts.command ?? { file: join(opts.root!, "bin", "browser-mcp"), args: [] };
    this.client = new BrowserClient(() => spawn(command.file, command.args, { env, stdio: ["pipe", "pipe", "pipe"] }));
  }

  // ── Shared ────────────────────────────────────────────────────────────────

  /** Throws when the denylist refuses `url`. */
  check(url: string): void {
    this.denier.check(url);
  }

  remaining(runId: string): number {
    const run = this.runs.get(runId);
    if (!run) return this.runBudgetMs;
    return Math.max(0, this.runBudgetMs - (Date.now() - run.startedAt));
  }

  private runOf(runId: string): Run {
    let run = this.runs.get(runId);
    if (!run) {
      run = { startedAt: Date.now(), refs: new Set(), lines: [] };
      this.runs.set(runId, run);
    }
    return run;
  }

  private live(runId: string): Run & { tab: number } {
    const run = this.runs.get(runId);
    if (!run?.tab) throw new Error("browser: this run has no page — call browser/open (with a url) first");
    return run as Run & { tab: number };
  }

  private tool(name: string, args: Record<string, unknown>, ms: number): Promise<ToolAnswer> {
    return this.client.call(name, args, ms);
  }

  private async evalIn<T = unknown>(tab: number, expression: string, ms: number): Promise<T> {
    const { text } = await this.tool("evaluate", { tabId: tab, expression: `JSON.stringify(${expression})` }, ms);
    return (text === "" || text === "undefined" ? undefined : JSON.parse(text)) as T;
  }

  /** One verb: the run's budget, the call's own timeout, and Strut's error form (`browser/<verb>: …`). */
  private async call<T>(runId: string, verb: string, timeoutMs: number | undefined, fn: (ms: number) => Promise<T>, extraMs = 0): Promise<T> {
    if (this.runs.has(runId) && this.remaining(runId) <= 0) throw new Error(`browser/${verb}: the run's browser budget is spent`);
    const ms = timeoutMs ?? this.stepTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const lost = Symbol("timeout");
    const race = new Promise<typeof lost>((r) => (timer = setTimeout(() => r(lost), ms + SLACK_MS + Math.max(0, extraMs))));
    const work = fn(ms);
    work.catch(() => {});
    try {
      const out = await Promise.race([work, race]);
      if (out === lost) throw new Error(`timed out after ${ms} ms`);
      return out as T;
    } catch (e) {
      const m = message(e);
      throw new Error(m.startsWith("browser") ? m : `browser/${verb}: ${m}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** After an action: the DOM quiet for a moment (bounded), then a short fixed pause. */
  private async settle(tab: number, extraMs = 0): Promise<void> {
    if (this.quiet) await this.tool("wait_for_network_idle", { tabId: tab, idleMs: 300, timeout: 3_000 }, 3_000 + SLACK_MS).catch(() => {});
    await sleep(this.fixedMs + Math.max(0, extraMs));
  }

  /** Where the page is now; refuses (and closes) a page that landed on a denied address; a new document resets the refs. */
  private async landed(runId: string, run: Run & { tab: number }): Promise<{ url: string; title: string }> {
    const at = await this.evalIn<[string, number, string]>(run.tab, "[location.href, performance.timeOrigin, document.title]", this.stepTimeoutMs);
    const [url, doc, title] = at ?? ["", 0, ""];
    try {
      this.check(url);
    } catch (e) {
      await this.closeRun(runId).catch(() => {});
      throw new Error(`browser: refused, the page landed on ${url}: ${message(e).replace(/^browser: refused \S+: /, "")}`);
    }
    if (run.doc !== doc) {
      run.doc = doc;
      run.refs = new Set();
      run.lines = [];
    }
    return { url, title };
  }

  private async status(tab: number): Promise<number> {
    const s = await this.evalIn<number>(tab, "(performance.getEntriesByType('navigation')[0] || {}).responseStatus || 0", this.stepTimeoutMs).catch(() => 0);
    return typeof s === "number" ? s : 0;
  }

  private uid(run: Run, ref: string): string {
    const r = ref.replace(/^@|^ref=/, "");
    if (!run.refs.has(r)) throw new Error(`browser: unknown ref "${r}" — call browser/snapshot first (refs reset on every navigation)`);
    return `@${r}`;
  }

  /** Marks the selector's element; answers the CSS that names it. */
  private async find(tab: number, selector: string, ms: number): Promise<string> {
    const token = `t${++this.token}`;
    const ok = await this.evalIn<boolean>(tab, `(${FIND_FN})(${JSON.stringify(selector)}, ${JSON.stringify(token)})`, ms);
    if (!ok) throw new Error(`no element matches ${JSON.stringify(selector)}`);
    return `[${MARK}="${token}"]`;
  }

  private target(input: Target): "ref" | "selector" {
    if (input.ref && input.selector) throw new Error("browser: give ref OR selector, not both");
    if (input.ref) return "ref";
    if (input.selector) return "selector";
    throw new Error("browser: give exactly one of ref or selector");
  }

  /** Focuses a ref's element (press_key focuses its index before the key; Shift alone types nothing). */
  private async focusRef(tab: number, uid: string, ms: number): Promise<void> {
    await this.tool("press_key", { tabId: tab, index: Number(uid.replace("@e", "")), keys: "Shift" }, ms);
  }

  // ── The verbs ─────────────────────────────────────────────────────────────

  async open(
    runId: string,
    input: { url?: string; viewport?: unknown; storageState?: unknown; timeoutMs?: number; session?: unknown } = {},
  ): Promise<Navigated & { resumed: boolean }> {
    if (input.session) throw new Error("browser/open: a kept page (session) is not available on Strut's browser");
    if (input.storageState) throw new Error("browser/open: storageState is not used on Strut's browser: it signs in with its own profile");
    if (input.url) this.check(input.url);
    const resumed = !!this.runs.get(runId)?.tab;
    this.runOf(runId);
    if (input.url) return { ...(await this.goto(runId, { url: input.url, timeoutMs: input.timeoutMs })), resumed };
    if (resumed) {
      const run = this.live(runId);
      return { ...(await this.call(runId, "open", input.timeoutMs, () => this.landed(runId, run))), status: 0, resumed };
    }
    return { url: "about:blank", title: "", status: 0, resumed };
  }

  async goto(runId: string, input: { url: string; wait?: number; timeoutMs?: number }): Promise<Navigated> {
    this.check(input.url);
    const run = this.runOf(runId);
    return this.call(
      runId,
      "goto",
      input.timeoutMs,
      async (ms) => {
        if (!run.tab) {
          const { text } = await this.tool("new_page", { url: input.url }, Math.max(ms, FIRST_PAGE_MS));
          const tab = pageOf(text).tab;
          if (!tab) throw new Error("the browser opened no page");
          run.tab = tab;
        } else {
          await this.tool("navigate_page", { pageId: run.tab, type: "url", url: input.url, timeoutMs: ms }, ms + SLACK_MS);
        }
        const live = run as Run & { tab: number };
        await this.settle(live.tab, input.wait);
        const at = await this.landed(runId, live);
        return { ...at, status: await this.status(live.tab) };
      },
      FIRST_PAGE_MS + (input.wait ?? 0),
    );
  }

  async snapshot(runId: string): Promise<{ url: string; title: string; tree: string }> {
    const run = this.live(runId);
    return this.call(runId, "snapshot", undefined, async (ms) => {
      const { text } = await this.tool("take_snapshot", { pageId: run.tab, format: "aria", compact: true }, ms);
      const page = pageOf(text);
      const { tree, lines, refs } = treeOf(text);
      run.refs = refs;
      run.lines = lines;
      run.doc = (await this.evalIn<number>(run.tab, "performance.timeOrigin", ms).catch(() => run.doc)) ?? run.doc;
      return { url: page.url, title: page.title, tree: tree.length > BROWSER_TREE_CAP ? tree.slice(0, BROWSER_TREE_CAP) : tree };
    });
  }

  async text(runId: string, input: Target & { timeoutMs?: number } = {}): Promise<{ text: string }> {
    const run = this.live(runId);
    return this.call(runId, "text", input.timeoutMs, async (ms) => {
      let text: string;
      if (input.ref) {
        const uid = this.uid(run, input.ref).slice(1);
        text = textUnder(run.lines, uid) ?? "";
      } else if (input.selector) {
        const css = await this.find(run.tab, input.selector, ms);
        text = (await this.evalIn<string>(run.tab, `document.querySelector(${JSON.stringify(css)}).innerText`, ms)) ?? "";
      } else {
        text = (await this.tool("get_text", { tabId: run.tab }, ms)).text;
      }
      return { text: text.length > BROWSER_TEXT_CAP ? text.slice(0, BROWSER_TEXT_CAP) : text };
    });
  }

  async click(runId: string, input: Target & { button?: "left" | "right" | "middle"; double?: boolean; timeoutMs?: number }): Promise<{ url: string }> {
    const run = this.live(runId);
    if (input.button && input.button !== "left") throw new Error(`browser/click: a ${input.button} click is not available on Strut's browser`);
    return this.call(runId, "click", input.timeoutMs, async (ms) => {
      const times = input.double ? 2 : 1;
      if (this.target(input) === "ref") {
        const uid = this.uid(run, input.ref!);
        for (let i = 0; i < times; i++) await this.tool("click", { tabId: run.tab, uid }, ms);
      } else {
        const css = await this.find(run.tab, input.selector!, ms);
        // drag from the element to itself: a real press and release at its centre, i.e. a click.
        for (let i = 0; i < times; i++) await this.tool("drag", { tabId: run.tab, source: css, target: css, duration: 50 }, ms);
      }
      await this.settle(run.tab);
      return { url: (await this.landed(runId, run)).url };
    });
  }

  async fill(runId: string, input: Target & { value: string; timeoutMs?: number }): Promise<{ ok: true }> {
    const run = this.live(runId);
    return this.call(runId, "fill", input.timeoutMs, async (ms) => {
      if (this.target(input) === "ref") await this.tool("fill", { tabId: run.tab, uid: this.uid(run, input.ref!), value: input.value }, ms);
      else {
        const css = await this.find(run.tab, input.selector!, ms);
        await this.evalIn(run.tab, `(${FILL_FN})(document.querySelector(${JSON.stringify(css)}), ${JSON.stringify(input.value)})`, ms);
      }
      await this.settle(run.tab);
      return { ok: true as const };
    });
  }

  async type(runId: string, input: { text: string; delay?: number; timeoutMs?: number }): Promise<{ ok: true }> {
    const run = this.live(runId);
    return this.call(runId, "type", input.timeoutMs, async (ms) => {
      await this.tool("type_text", { tabId: run.tab, text: input.text }, ms);
      await this.settle(run.tab);
      return { ok: true as const };
    });
  }

  async press(runId: string, input: { key: string; timeoutMs?: number }): Promise<{ url: string }> {
    const run = this.live(runId);
    return this.call(runId, "press", input.timeoutMs, async (ms) => {
      await this.tool("press_key", { tabId: run.tab, keys: input.key }, ms);
      await this.settle(run.tab);
      return { url: (await this.landed(runId, run)).url };
    });
  }

  async select(runId: string, input: Target & { value: string; timeoutMs?: number }): Promise<{ ok: true }> {
    const run = this.live(runId);
    return this.call(runId, "select", input.timeoutMs, async (ms) => {
      let el: string;
      if (this.target(input) === "ref") {
        await this.focusRef(run.tab, this.uid(run, input.ref!), ms);
        el = "document.activeElement";
      } else el = `document.querySelector(${JSON.stringify(await this.find(run.tab, input.selector!, ms))})`;
      await this.evalIn(run.tab, `(${SELECT_FN})(${el}, ${JSON.stringify(input.value)})`, ms);
      await this.settle(run.tab);
      return { ok: true as const };
    });
  }

  async hover(runId: string, input: Target & { timeoutMs?: number }): Promise<{ ok: true }> {
    const run = this.live(runId);
    return this.call(runId, "hover", input.timeoutMs, async (ms) => {
      if (this.target(input) === "ref") await this.tool("hover", { tabId: run.tab, index: Number(this.uid(run, input.ref!).replace("@e", "")), duration: 300 }, ms);
      else {
        const css = await this.find(run.tab, input.selector!, ms);
        await this.evalIn(run.tab, `(${HOVER_FN})(document.querySelector(${JSON.stringify(css)}))`, ms);
      }
      await this.settle(run.tab);
      return { ok: true as const };
    });
  }

  async scroll(runId: string, input: Target & { y?: number; timeoutMs?: number }): Promise<{ ok: true }> {
    const run = this.live(runId);
    return this.call(runId, "scroll", input.timeoutMs, async (ms) => {
      if (input.ref && !input.selector) {
        // hover scrolls its element into view first, then rests the pointer on it briefly.
        await this.tool("hover", { tabId: run.tab, index: Number(this.uid(run, input.ref).replace("@e", "")), duration: 100 }, ms);
      } else if (input.selector && !input.ref) {
        const css = await this.find(run.tab, input.selector, ms);
        await this.evalIn(run.tab, `document.querySelector(${JSON.stringify(css)}).scrollIntoView({ block: "center" })`, ms);
      } else if (typeof input.y === "number" && !input.ref && !input.selector) {
        await this.evalIn(run.tab, `window.scrollBy(0, ${Math.trunc(input.y)})`, ms);
      } else throw new Error("give ref, selector, or y");
      await this.settle(run.tab);
      return { ok: true as const };
    });
  }

  async back(runId: string, input: { timeoutMs?: number } = {}): Promise<{ url: string; title: string }> {
    const run = this.live(runId);
    return this.call(runId, "back", input.timeoutMs, async (ms) => {
      await this.tool("navigate_page", { pageId: run.tab, type: "back", timeoutMs: ms }, ms + SLACK_MS);
      await this.settle(run.tab);
      return this.landed(runId, run);
    });
  }

  /** Its cap is the run's remaining budget, as in Strut: outlasting a slow page is its job. */
  async wait(runId: string, input: Target & { text?: string; url?: string; ms?: number; timeoutMs?: number }): Promise<{ ok: true; waitedMs: number }> {
    const run = this.live(runId);
    const budget = input.timeoutMs ?? this.remaining(runId);
    return this.call(runId, "wait", budget, async (ms) => {
      const t0 = Date.now();
      const until = async (tool: string, args: Record<string, unknown>, what: string) => {
        for (;;) {
          const left = ms - (Date.now() - t0);
          if (left <= 0) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
          const slice = Math.min(left, 60_000);
          try {
            await this.tool(tool, { tabId: run.tab, ...args, timeout: slice }, slice + SLACK_MS);
            return;
          } catch (e) {
            if (!/Timed out/i.test(message(e))) throw e;
          }
        }
      };
      const condition = (expression: string, what: string) => until("wait_for_condition", { expression, pollMs: 250 }, what);
      if (typeof input.ms === "number") await sleep(Math.min(input.ms, ms));
      else if (input.text) {
        const want = JSON.stringify(input.text.toLowerCase());
        await condition(`document.body && document.body.innerText.toLowerCase().includes(${want})`, `text ${JSON.stringify(input.text)}`);
      } else if (input.url) {
        // contains, or a glob with * (anchored), as the browser's wait_for_url reads it.
        await until("wait_for_url", { pattern: input.url }, `URL ${JSON.stringify(input.url)}`);
      } else if (input.ref) this.uid(run, input.ref);
      else if (input.selector) {
        const token = `t${++this.token}`;
        await condition(`(${FIND_FN})(${JSON.stringify(input.selector)}, ${JSON.stringify(token)})`, JSON.stringify(input.selector));
      } else throw new Error("give ref, selector, text, url, or ms");
      return { ok: true as const, waitedMs: Date.now() - t0 };
    });
  }

  /** The window's viewport to shots/NNN.png (Strut's sink), with the 0.6× copy for the model. */
  async screenshot(runId: string, input: Target & { fullPage?: boolean; name?: string; timeoutMs?: number }, sink: ShotSink) {
    const run = this.live(runId);
    return this.call(runId, "screenshot", input.timeoutMs, async (ms) => {
      // quality 90 is the browser's PNG; maxWidth past the window keeps the frame at its CSS size.
      const { images } = await this.tool("take_screenshot", { tabId: run.tab, quality: 90, detail: "high", maxWidth: 8_192 }, ms);
      const image = images[0];
      if (!image) throw new Error("the browser answered no image");
      const sharp = sharpOf();
      let png = Buffer.from(image.data, "base64");
      if (image.mimeType !== "image/png") png = await sharp(png).png().toBuffer();
      return saveBrowserShot(sink, png, input.name, sharp);
    });
  }

  async closeRun(runId: string): Promise<{ ok: true }> {
    const run = this.runs.get(runId);
    if (run?.tab) {
      const tab = run.tab;
      run.tab = undefined;
      run.refs = new Set();
      run.lines = [];
      await this.tool("close_page", { pageId: tab }, this.stepTimeoutMs).catch(() => {});
    }
    return { ok: true };
  }

  async closeKept(_job: string, _name: string): Promise<{ ok: true }> {
    return { ok: true };
  }

  kept(): Array<{ job: string; name: string }> {
    return [];
  }

  /**
   * JavaScript in the run's page, never in this host, as Strut's service runs it: an expression, or a function that
   * is called with no arguments; a promise is awaited. The answer is its JSON (undefined is null), cut at
   * BROWSER_TEXT_CAP characters with `truncated`. A page the script sends to a denied address is closed, as after any
   * other verb. The host's research steps leave browser/evaluate out (registry.ts); this serves a Strut that has it.
   */
  async evaluate(runId: string, input: { expression: string; timeoutMs?: number }): Promise<{ result: unknown; truncated?: true }> {
    const run = this.live(runId);
    return this.call(runId, "evaluate", input.timeoutMs, async (ms) => {
      // The newline lets an expression end in a // comment.
      const expression = `(async () => { const v = (${input.expression}\n); const r = typeof v === "function" ? await v() : await v; return JSON.stringify(r ?? null) ?? "null"; })()`;
      const { text } = await this.tool("evaluate", { tabId: run.tab, expression }, ms);
      await this.landed(runId, run);
      if (text.length <= BROWSER_TEXT_CAP) return { result: JSON.parse(text) as unknown };
      return { result: text.slice(0, BROWSER_TEXT_CAP), truncated: true as const };
    });
  }

  /**
   * Strut's capture: open the url, run the declared steps, settle (`wait` more milliseconds), and photograph the
   * window. The list is checked before anything opens; a step that fails fails the capture, naming the step. The
   * steps are Strut's capture verbs except keydown and keyup (this browser holds no key; use press). `errors` is
   * always empty: this browser collects no console or network errors (`observe`).
   */
  async capture(
    runId: string,
    input: Parameters<StrutBrowser["capture"]>[1],
    sink: ShotSink,
  ): ReturnType<StrutBrowser["capture"]> {
    const steps = input.steps ?? [];
    for (const [i, s] of steps.entries()) {
      if ((CAPTURE_STEPS as readonly string[]).includes(s.do)) continue;
      const why = s.do === "keydown" || s.do === "keyup" ? `"${s.do}" is not available on Strut's browser (use press)` : `unknown verb "${s.do}" (one of ${CAPTURE_STEPS.join(", ")})`;
      throw new Error(`capture: step ${i + 1}: ${why}`);
    }
    await this.open(runId, { url: input.url, timeoutMs: input.timeoutMs });
    const verbs = this as unknown as Record<CaptureStepVerb, (runId: string, args: unknown) => Promise<unknown>>;
    for (const [i, { do: verb, ...args }] of steps.entries()) {
      try {
        await verbs[verb as CaptureStepVerb].call(this, runId, args);
      } catch (e) {
        throw new Error(`capture: step ${i + 1} (${verb} ${JSON.stringify(args)}) failed: ${message(e)}`);
      }
    }
    const run = this.live(runId);
    await this.settle(run.tab, input.wait);
    const shot = await this.screenshot(runId, { fullPage: input.fullPage, timeoutMs: input.timeoutMs }, sink);
    const at = await this.landed(runId, run);
    return { ...shot, errors: [], pageUrl: at.url, title: at.title };
  }

  // ── Verbs this browser refuses ────────────────────────────────────────────
  // StrutBrowser lists every verb Strut's browser/* steps and app/look call. The research steps (registry.ts) use
  // fifteen of the verbs above; these throw, saying why, and the step fails with that message. Of the browser
  // workflows Strut seeds, browser-capture and browser-watch run on this browser, browser-explore runs until it would
  // keep a page (after a CAPTCHA), and browser-captcha is refused.

  observe(..._: Parameters<StrutBrowser["observe"]>): ReturnType<StrutBrowser["observe"]> {
    throw refused("observe", "console and network observations are not collected here");
  }

  async state(..._: Parameters<StrutBrowser["state"]>): ReturnType<StrutBrowser["state"]> {
    throw refused("state", "the profile keeps its own cookies; no storage state is exported");
  }

  async tap(..._: Parameters<StrutBrowser["tap"]>): ReturnType<StrutBrowser["tap"]> {
    throw refused("tap", "use browser/click");
  }

  async keydown(..._: Parameters<StrutBrowser["keydown"]>): ReturnType<StrutBrowser["keydown"]> {
    throw refused("keydown", "use browser/press");
  }

  async keyup(..._: Parameters<StrutBrowser["keyup"]>): ReturnType<StrutBrowser["keyup"]> {
    throw refused("keyup", "use browser/press");
  }

  async captcha(..._: Parameters<StrutBrowser["captcha"]>): ReturnType<StrutBrowser["captcha"]> {
    throw refused("captcha", "a human check is reported as blocked, and a person answers it over VNC");
  }

  async verify(..._: Parameters<StrutBrowser["verify"]>): ReturnType<StrutBrowser["verify"]> {
    throw refused("verify", "a signed-out check session needs Strut's Playwright browser");
  }

  async walkthrough(..._: Parameters<StrutBrowser["walkthrough"]>): ReturnType<StrutBrowser["walkthrough"]> {
    throw refused("walkthrough", "a recorded walkthrough needs Strut's Playwright browser");
  }

  async lookAtApp(..._: Parameters<StrutBrowser["lookAtApp"]>): ReturnType<StrutBrowser["lookAtApp"]> {
    throw refused("look", "an app's page is served in process to Strut's own browser only");
  }

  async keep(..._: Parameters<StrutBrowser["keep"]>): ReturnType<StrutBrowser["keep"]> {
    throw refused("keep", "a kept page (session) is not available on Strut's browser");
  }

  /** The run's window closes when the run ends. */
  async dispose(runId: string): Promise<void> {
    await this.closeRun(runId);
    this.runs.delete(runId);
  }

  /** Every run's window, then the adapter. The browser (broker, server, Chromium) keeps running: it is the kit's. */
  async close(): Promise<void> {
    for (const id of [...this.runs.keys()]) await this.dispose(id).catch(() => {});
    this.client.close();
  }
}

/** Strut's error form for a verb this browser refuses (`browser/<verb>: …`). */
function refused(verb: string, why: string): Error {
  return new Error(`browser/${verb}: not available on Strut's browser (${why})`);
}

/** Strut's saveShot (vendor/strut/src/browser/shot.ts), which its index does not export: the job's directory or the
 *  run's artifacts, a counter or the given name. */
export async function saveBrowserShot(sink: ShotSink, png: Buffer, name: string | undefined, sharp: any) {
  const fileName = (count: number) => (name ? `${name.replace(/\.png$/i, "").replace(/[^\w.-]+/g, "_")}.png` : `${String(count + 1).padStart(3, "0")}.png`);
  let path: string;
  let dir: string;
  let url: string;
  if (sink.job) {
    const shotsDir = join(sink.job.root, "shots");
    let count = 0;
    try {
      count = (await readdir(shotsDir)).filter((f) => f.endsWith(".png")).length;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
    }
    const file = fileName(count);
    await mkdir(shotsDir, { recursive: true });
    await writeFile(join(shotsDir, file), png);
    path = `shots/${file}`;
    dir = sink.job.root;
    url = jobFileUrl(sink.job.name, path);
    sink.notify?.({ kind: "image", url, state: "done", title: path });
  } else {
    const count = (await sink.artifacts.list(sink.runId)).filter((p) => p.startsWith("shots/") && p.endsWith(".png")).length;
    path = `shots/${fileName(count)}`;
    await sink.artifacts.write(sink.runId, path, png);
    dir = await sink.artifacts.dir(sink.runId);
    url = `/artifacts/${sink.runId}/${path}`;
  }
  const meta = await sharp(png).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const small: Buffer = await sharp(png).resize({ width: Math.max(1, Math.round(width * MODEL_SCALE)) }).png().toBuffer();
  return { path, dir, url, bytes: png.length, width, height, small };
}

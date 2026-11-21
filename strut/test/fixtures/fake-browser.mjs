// A stand-in for Strut's browser in tests: a stdio MCP server that answers the Browser MCP tools Strut's browser calls,
// with one page, and writes each call to FAKE_BROWSER_LOG (one JSON line each).
import { appendFileSync } from "node:fs";
import vm from "node:vm";

const log = process.env.FAKE_BROWSER_LOG;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const page = { tab: 0, url: "", title: "", doc: 1 };
let tabs = 0;

const lines = (p) => `Tab ID: ${p.tab}\nTitle: ${p.title}\nURL: ${p.url}`;
const go = (url) => {
  // "redirect-private" lands on a private address, as a redirect would.
  page.url = url.includes("redirect-private") ? "http://10.0.0.5/inside" : url;
  page.title = `Title of ${new URL(page.url).pathname}`;
  page.doc += 1;
};
const text = (t) => ({ content: [{ type: "text", text: t }] });
const fail = (t) => ({ content: [{ type: "text", text: `Error: ${t}` }], isError: true });

function tool(name, a) {
  switch (name) {
    case "new_page":
      tabs += 1;
      page.tab = 100 + tabs;
      go(a.url);
      return text(`Opened new page in its own window 9, not brought to the front\n${lines(page)}`);
    case "navigate_page":
      if (a.type === "url") go(a.url);
      else if (a.type === "back") go("https://example.com/before");
      return text(`Navigated page ${a.pageId} (${a.type})\n${lines(page)}`);
    case "take_snapshot":
      return text(
        `${lines(page)}\nFormat: aria\nPage changed: true\n` +
          'RootWebArea "Home" [uid=@e1]\n  navigation "" [uid=@e2]\n    link "Pricing" [uid=@e3]\n      /url: https://example.com/pricing\n  main "" [uid=@e4]\n' +
          '    heading "Plans" [uid=@e5]\n      StaticText "Plans" [uid=@e6]\n    combobox "Billing" [uid=@e7]\n    button "Go" [uid=@e8]',
      );
    case "evaluate": {
      const e = String(a.expression);
      // browser/evaluate's own script: run for real in a sandbox with this page's location, as the browser's
      // Runtime.evaluate (awaitPromise) would; a string answer comes back as it is.
      if (e.includes('typeof v === "function"')) {
        return Promise.resolve()
          .then(() => vm.runInNewContext(e, { location: { href: page.url }, go }, { timeout: 1_000 }))
          .then((v) => text(typeof v === "string" ? v : String(v)), (err) => fail(`Uncaught ${err.message}`));
      }
      if (e.includes("location.href, performance.timeOrigin")) return text(JSON.stringify([page.url, page.doc, page.title]));
      if (e.includes("responseStatus")) return text("200");
      if (e.includes("performance.timeOrigin")) return text(String(page.doc));
      if (e.includes("nothing-here")) return text("false");
      if (e.includes("innerText")) return text(JSON.stringify("selected text"));
      return text("true");
    }
    case "get_text":
      // An IP echo page's whole text is the caller's address.
      return text(page.url.includes("ipify") ? "203.0.113.7" : "Hello from the page");
    case "take_screenshot":
      return { content: [{ type: "image", mimeType: "image/png", data: PNG }] };
    case "wait_for_condition":
      if (String(a.expression).includes("never there")) return fail(`Timed out after ${a.timeout}ms waiting for condition`);
      return text("Condition is truthy");
    case "wait_for_url":
      return text(`URL is now ${page.url}`);
    case "close_page":
      return text(`Closed page ${a.pageId}`);
    case "click":
    case "fill":
    case "press_key":
    case "hover":
    case "drag":
    case "type_text":
    case "wait_for_network_idle":
      return text("ok");
    default:
      return fail(`unknown tool ${name}`);
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    let result;
    if (m.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-browser", version: "0" } };
    else if (m.method === "tools/call") {
      if (log) appendFileSync(log, `${JSON.stringify({ name: m.params.name, args: m.params.arguments, env: m.params.name === "new_page" ? { profile: process.env.BROWSER_PROFILE, port: process.env.BROWSER_PORT } : undefined })}\n`);
      result = await tool(m.params.name, m.params.arguments ?? {});
    } else result = {};
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, result })}\n`);
  }
});
process.stdin.on("end", () => process.exit(0));

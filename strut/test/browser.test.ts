import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { Browser, FIND_FN, pageOf, plainError, textUnder, treeOf } from "../src/browser.js";
import { browserOptionsFromEnv, researchBrowser } from "../src/browser-env.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-browser.mjs", import.meta.url));

describe("Strut's browser: the browser verbs through the browser's Browser MCP server", () => {
  let dir: string;
  let logPath: string;
  let browser: Browser;
  const calls = async () =>
    (await readFile(logPath, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { name: string; args: Record<string, any>; env?: Record<string, string> });
  const named = async (name: string) => (await calls()).filter((c) => c.name === name);
  const sink = (runId: string) => {
    const files = new Map<string, Buffer>();
    return {
      files,
      sink: {
        runId,
        artifacts: {
          write: async (_r: string, path: string, data: Buffer) => void files.set(path, data),
          list: async () => [...files.keys()],
          dir: async () => join(dir, "artifacts", runId),
        },
      } as any,
    };
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "browser-"));
    logPath = join(dir, "calls.jsonl");
    browser = new Browser({
      root: dir,
      profile: "strut",
      port: 21203,
      env: { FAKE_BROWSER_LOG: logPath, PATH: process.env.PATH ?? "" },
      command: { file: process.execPath, args: [FAKE] },
      settle: { fixedMs: 0, quiet: false },
    });
  });
  after(async () => {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("opens each run's page as a window of the browser, with the browser's settings", async () => {
    const out = await browser.open("run-1", { url: "https://example.com/pricing" });
    assert.deepEqual(out, { url: "https://example.com/pricing", title: "Title of /pricing", status: 200, resumed: false });
    const [opened] = await named("new_page");
    assert.equal(opened!.args.url, "https://example.com/pricing");
    assert.deepEqual(opened!.env, { profile: "strut", port: "21203" });
    const again = await browser.open("run-1", { url: "https://example.com/next" });
    assert.equal(again.resumed, true);
    assert.equal((await named("new_page")).length, 1, "the run keeps its one page");
    assert.equal((await named("navigate_page")).at(-1)!.args.url, "https://example.com/next");
  });

  it("refuses denied addresses before and after a navigation", async () => {
    await assert.rejects(browser.open("run-2", { url: "http://127.0.0.1:4190/runs" }), /refused/);
    await assert.rejects(browser.goto("run-1", { url: "file:///etc/passwd" }), /refused/);
    await assert.rejects(browser.goto("run-1", { url: "https://example.com/redirect-private" }), /landed on http:\/\/10\.0\.0\.5/);
    assert.ok((await named("close_page")).length >= 1, "the page that landed inside is closed");
    await assert.rejects(browser.snapshot("run-1"), /call browser\/open/);
  });

  it("answers Strut's snapshot tree and acts on its refs", async () => {
    await browser.open("run-3", { url: "https://example.com/" });
    const snap = await browser.snapshot("run-3");
    assert.equal(
      snap.tree,
      [
        '- RootWebArea "Home" [ref=e1]',
        '  - navigation [ref=e2]',
        '    - link "Pricing" [ref=e3]',
        '      - /url: https://example.com/pricing',
        '  - main [ref=e4]',
        '    - heading "Plans" [ref=e5]',
        '    - combobox "Billing" [ref=e7]',
        '    - button "Go" [ref=e8]',
      ].join("\n"),
    );
    assert.deepEqual(await browser.click("run-3", { ref: "e8" }), { url: "https://example.com/" });
    assert.equal((await named("click")).at(-1)!.args.uid, "@e8");
    await browser.fill("run-3", { ref: "@e7", value: "x" });
    assert.equal((await named("fill")).at(-1)!.args.uid, "@e7");
    await browser.hover("run-3", { ref: "e3" });
    assert.equal((await named("hover")).at(-1)!.args.index, 3);
    await browser.select("run-3", { ref: "e7", value: "Annual" });
    const focus = (await named("press_key")).at(-1)!.args;
    assert.deepEqual([focus.index, focus.keys], [7, "Shift"]);
    assert.match((await named("evaluate")).at(-1)!.args.expression, /document\.activeElement, "Annual"/);
    assert.deepEqual(await browser.text("run-3", { ref: "e5" }), { text: "Plans\nPlans" });
    assert.deepEqual(await browser.text("run-3"), { text: "Hello from the page" });
    await assert.rejects(browser.click("run-3", { ref: "e99" }), /unknown ref "e99"/);
    await assert.rejects(browser.click("run-3", { ref: "e1", button: "right" }), /right click is not available/);
    // A navigation is a new document: the refs go with it.
    await browser.goto("run-3", { url: "https://example.com/other" });
    await assert.rejects(browser.click("run-3", { ref: "e8" }), /call browser\/snapshot first/);
  });

  it("finds a selector's element in the page and clicks it with a real press", async () => {
    await browser.click("run-3", { selector: "text=Annual" });
    const find = (await named("evaluate")).find((c) => String(c.args.expression).includes('"text=Annual"'));
    assert.ok(find, "the finder ran on the page");
    const drag = (await named("drag")).at(-1)!.args;
    assert.match(drag.source, /^\[data-fleet-browser="t\d+"\]$/);
    assert.equal(drag.source, drag.target);
    await assert.rejects(browser.click("run-3", { selector: "#nothing-here" }), /no element matches/);
    await assert.rejects(browser.click("run-3", {}), /exactly one of ref or selector/);
  });

  it("types, presses, scrolls, goes back and waits", async () => {
    await browser.type("run-3", { text: "hello" });
    assert.equal((await named("type_text")).at(-1)!.args.text, "hello");
    assert.deepEqual(await browser.press("run-3", { key: "Enter" }), { url: "https://example.com/other" });
    await browser.scroll("run-3", { y: 600 });
    assert.match((await named("evaluate")).at(-1)!.args.expression, /scrollBy\(0, 600\)/);
    assert.deepEqual(await browser.back("run-3"), { url: "https://example.com/before", title: "Title of /before" });
    const waited = await browser.wait("run-3", { text: "Plans" });
    assert.equal(waited.ok, true);
    assert.match((await named("wait_for_condition")).at(-1)!.args.expression, /includes\("plans"\)/);
    await browser.wait("run-3", { url: "/pricing" });
    assert.equal((await named("wait_for_url")).at(-1)!.args.pattern, "/pricing");
    await assert.rejects(browser.wait("run-3", { text: "never there", timeoutMs: 300 }), /timed out after 300 ms/);
  });

  it("saves a screenshot as Strut does, with the model's copy", async () => {
    const { files, sink: s } = sink("run-3");
    const shot = await browser.screenshot("run-3", {}, s);
    assert.equal(shot.path, "shots/001.png");
    assert.equal(shot.url, "/artifacts/run-3/shots/001.png");
    assert.deepEqual([shot.width, shot.height], [1, 1]);
    assert.ok(files.get("shots/001.png")!.length > 0);
    assert.ok(Buffer.isBuffer(shot.small));
    const named2 = await browser.screenshot("run-3", { name: "pricing page" }, s);
    assert.equal(named2.path, "shots/pricing_page.png");
    const jobRoot = join(dir, "job-1");
    const jobShot = await browser.screenshot("run-3", {}, { ...s, job: { name: "job-1", root: jobRoot } });
    assert.equal(jobShot.path, "shots/001.png");
    assert.ok((await stat(join(jobRoot, "shots", "001.png"))).size > 0);
  });

  it("refuses what the browser does not do, and closes the run's window when it ends", async () => {
    await assert.rejects(browser.open("run-4", { session: { job: "j", name: "captcha" } }), /kept page/);
    await assert.rejects(browser.open("run-4", { url: "https://example.com/", storageState: {} }), /storageState/);
    const before = (await named("close_page")).length;
    await browser.dispose("run-3");
    assert.equal((await named("close_page")).length, before + 1);
    await assert.rejects(browser.snapshot("run-3"), /call browser\/open/);
  });

  it("refuses the StrutBrowser verbs it does not do, in Strut's error form, without touching the browser", async () => {
    const before = (await calls()).length;
    const s = sink("run-5").sink;
    const refusals: Array<[string, () => unknown]> = [
      ["state", () => browser.state("run-5", s.artifacts)],
      ["tap", () => browser.tap("run-5", { points: [{ nx: 0.5, ny: 0.5 }] })],
      ["keydown", () => browser.keydown("run-5", { key: "Shift" })],
      ["keyup", () => browser.keyup("run-5", { key: "Shift" })],
      ["captcha", () => browser.captcha("run-5", {} as any, s)],
      ["verify", () => browser.verify("run-5", {} as any, s)],
      ["walkthrough", () => browser.walkthrough("run-5", {} as any, s)],
      ["look", () => browser.lookAtApp("run-5", {} as any, s)],
      ["keep", () => browser.keep("run-5", { job: "j", name: "n" } as any)],
    ];
    for (const [verb, call] of refusals) {
      await assert.rejects(async () => call(), new RegExp(`^Error: browser/${verb}: not available on Strut's browser \\(`), verb);
    }
    assert.throws(() => browser.observe("run-5"), /^Error: browser\/observe: not available on Strut's browser/);
    assert.equal((await calls()).length, before, "no call reached the browser");
  });

  it("evaluates in the page as Strut does: expressions, functions, promises, undefined as null, the cap", async () => {
    await browser.open("run-6", { url: "https://example.com/data" });
    assert.deepEqual(await browser.evaluate("run-6", { expression: "location.href" }), { result: "https://example.com/data" });
    assert.deepEqual(await browser.evaluate("run-6", { expression: "() => ({ n: 2, list: [1, 'a'] })" }), { result: { n: 2, list: [1, "a"] } });
    assert.deepEqual(await browser.evaluate("run-6", { expression: "Promise.resolve(42) // the answer" }), { result: 42 });
    assert.deepEqual(await browser.evaluate("run-6", { expression: "undefined" }), { result: null });
    const big = await browser.evaluate("run-6", { expression: "'x'.repeat(60000)" });
    assert.equal(big.truncated, true);
    assert.equal((big.result as string).length, 50_000);
    await assert.rejects(browser.evaluate("run-6", { expression: "(() => { throw new Error('boom') })()" }), /^Error: browser\/evaluate: .*boom/);
  });

  it("closes a page a script sends to a denied address", async () => {
    await browser.open("run-7", { url: "https://example.com/" });
    await assert.rejects(browser.evaluate("run-7", { expression: "go('https://example.com/redirect-private')" }), /10\.0\.0\.5|denied|not allowed/i);
  });

  it("captures: opens, runs the steps, photographs the window, and names a step that fails", async () => {
    const { files, sink: s } = sink("run-8");
    const out = await browser.capture(
      "run-8",
      { url: "https://example.com/pricing", steps: [{ do: "click", selector: "text=Plans" }, { do: "evaluate", expression: "1 + 1" }, { do: "wait", ms: 1 }] },
      s,
    );
    assert.deepEqual(out.errors, []);
    assert.equal(out.pageUrl, "https://example.com/pricing");
    assert.equal(out.title, "Title of /pricing");
    assert.ok(out.small.length > 0);
    assert.equal(files.size > 0, true);
    const opened = (await named("new_page")).at(-1)!;
    assert.equal(opened.args.url, "https://example.com/pricing");

    const before = (await calls()).length;
    await assert.rejects(browser.capture("run-9", { url: "https://example.com/", steps: [{ do: "keydown", key: "Shift" }] }, s), /^Error: capture: step 1: "keydown" is not available on Strut's browser \(use press\)/);
    await assert.rejects(browser.capture("run-9", { url: "https://example.com/", steps: [{ do: "solve" }] }, s), /capture: step 1: unknown verb "solve"/);
    assert.equal((await calls()).length, before, "a wrong list opens nothing");
    await assert.rejects(
      browser.capture("run-9", { url: "https://example.com/", steps: [{ do: "evaluate", expression: "(() => { throw new Error('nope') })()" }] }, s),
      /^Error: capture: step 1 \(evaluate .*\) failed: browser\/evaluate: .*nope/,
    );
  });
});

describe("Strut's browser: parsing and settings", () => {
  it("reads the browser's page lines and its aria snapshot", () => {
    assert.deepEqual(pageOf("Navigated page 5 (url)\nTab ID: 5\nTitle: A\nURL: https://a.test/"), { tab: 5, title: "A", url: "https://a.test/" });
    const { tree, refs, lines } = treeOf(
      'Tab ID: 5\nTitle: A\nURL: u\nFormat: aria\nPage changed: false\nbutton "Say \\"hi\\"" [uid=@e1]\n      StaticText "hi" [uid=@e2]\n' +
        '      StaticText "Say \\"hi\\"" [uid=@e3]\n        link "x" [uid=@e4]\n... (3 more node(s) omitted; use compact/maxDepth/scopeSelector to narrow)',
    );
    assert.equal(tree, '- button "Say \\"hi\\"" [ref=e1]\n  - text: "hi"\n  - link "x" [ref=e4]\n# ... (3 more node(s) omitted; use compact/maxDepth/scopeSelector to narrow)');
    assert.deepEqual([...refs], ["e1", "e4"]);
    assert.equal(textUnder(lines, "e1"), 'Say "hi"\nhi\nSay "hi"\nx');
  });

  it("uses the browser when BROWSER_PROFILE is set, and only one browser", () => {
    const opts = browserOptionsFromEnv({ BROWSER_PROFILE: "strut", BROWSER_PORT: "21203" }, { home: "/home/fleet", path: "/usr/bin:/bin" });
    assert.deepEqual(
      { root: opts.unblockable!.root, profile: opts.unblockable!.profile, port: opts.unblockable!.port, env: opts.unblockable!.env },
      { root: "/home/fleet/.local/share/unblockable-browser", profile: "strut", port: 21203, env: { PATH: "/usr/bin:/bin", HOME: "/home/fleet" } },
    );
    assert.match(opts.unblockable!.deny!, /127\.0\.0\.0\/8/);
    assert.ok(researchBrowser(opts) instanceof Browser);
    assert.throws(() => researchBrowser({ ...opts, wsUrl: "ws://127.0.0.1:4191" }), /not both/);
    assert.equal(browserOptionsFromEnv({ BROWSER_WS_URL: "ws://127.0.0.1:4191" }).unblockable, undefined);
    assert.throws(() => new Browser({ root: "/x", profile: "Bad Name", port: 21203 }), /BROWSER_PROFILE/);
    assert.throws(() => new Browser({ root: "/x", profile: "strut", port: 80 }), /BROWSER_PORT/);
    // The names from before 0.8.0 still work for one release.
    const old = browserOptionsFromEnv({ ["BROWSER_" + "LANE_PROFILE"]: "strut", ["BROWSER_" + "LANE_PORT"]: "21203", ["BROWSER_" + "LANE_ROOT"]: "/srv/old" }, { home: "/home/fleet" });
    assert.deepEqual({ root: old.unblockable!.root, profile: old.unblockable!.profile, port: old.unblockable!.port }, { root: "/srv/old", profile: "strut", port: 21203 });
  });

  it("names the browser when no browser is set up", () => {
    const browser = researchBrowser({});
    assert.throws(() => (browser as any).open("run"), /BROWSER_PROFILE/);
  });
});

describe("the browser's selectors and errors", () => {
  // FIND_FN runs in the page; here in a sandbox with an empty page.
  const find = (sel: string) => {
    const none = () => [];
    const document = { body: { querySelectorAll: none }, querySelectorAll: none, getElementById: () => null };
    return vm.runInNewContext(`(${FIND_FN})(${JSON.stringify(sel)}, "t1")`, { document });
  };

  it("refuses Playwright's chains, xpath and nth whatever the first part is", () => {
    for (const sel of ["text=Frequently asked questions >> xpath=..", "text=Photos >> nth=0", "role=button[name=\"Go\"] >> nth=1", "xpath=//a", "//div[@id='x']", "nth=0", "div.card >> text=Pro", "button:has-text(\"Go\")"]) {
      assert.throws(() => find(sel), (e: any) => /is not supported on the browser: use text=…, role=…\[name=…\] or CSS/.test(e.message), sel);
    }
    for (const sel of ["text=Annual", "role=button[name=\"Go\"]", "div.card > a", "#nothing-here"]) assert.equal(find(sel), false, sel);
  });

  it("says Chrome's element errors in words a workflow's agent can act on", () => {
    assert.match(plainError(JSON.stringify({ code: -32000, message: "Could not compute box model." })), /^the element is not visible on the page/);
    assert.match(plainError("Node does not have a layout object"), /^the element is not visible on the page/);
    assert.match(plainError(JSON.stringify({ code: -32000, message: "No node with given id found" })), /^the element is no longer on the page/);
    assert.equal(plainError("Timed out after 500ms waiting for condition"), "Timed out after 500ms waiting for condition");
    assert.equal(plainError("{not json"), "{not json");
  });
});

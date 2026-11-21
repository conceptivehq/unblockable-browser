// Proves a Strut package in this folder is readable and installable by a real Strut checkout, and dry-runs its build.
// It never touches a running Strut: every Strut it boots lives in a temporary folder and is thrown away.
//
//   node --import <strut>/node_modules/tsx/dist/esm/index.mjs packages/check-package.mjs <strut> packages/<name>
//
// <strut> is a Strut source checkout with its dependencies installed (this code is built against Strut d4e6595). It reports:
//  1. readPackage(dir): the manifest, digest and items Strut reads.
//  2. An install on a plain Strut (its own core and library steps): what Strut says.
//  3. An install on a Strut built the way a host with its own step list builds it (a registry handed to createStrut: the host's
//     core steps plus hermes/ask and hermes/send): what Strut says.
//  3b. An install on a Strut whose workspace holds custom steps named hermes/ask and hermes/send (stand-ins), so the
//     package's step names resolve as they would on a Strut that has them: what Strut says.
//  4. A dry-run buildPackage of every installed workflow (and its Concepts) from the Strut of 3b.
//  5. A run of each workflow through Strut's runner with the host's step list (its core steps, the two Hermes steps
//     and, as with the host's research plugin, Strut's browser/* steps and agent), the Hermes steps and agent answered
//     by stand-ins and the browser steps driving a stand-in browser, so templates and control flow are evaluated for
//     real.
// Exit 0 when 1, 3b, 4 and 5 succeed (2 and 3 are reported either way).
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [strutArg, pkgArg] = process.argv.slice(2);
if (!strutArg || !pkgArg) {
  console.error("usage: check-package.mjs <strut checkout> <package folder>");
  process.exit(64);
}
const strutDir = resolve(strutArg);
const pkgDir = resolve(pkgArg);
const load = (rel) => import(pathToFileURL(join(strutDir, "src", rel)).href);

delete process.env.STRUT_API_KEY;
const { createStrut } = await load("createStrut.ts");
const { WorkspaceManager } = await load("workspace.ts");
const { MemoryRunStore } = await load("store.ts");
const { coreRegistry, createRegistry } = await load("steps/registry.ts");
const { defineStep } = await load("core.ts");
const { runWorkflow } = await load("runner.ts");
const { flowFromYaml } = await load("workspace.ts");
const { readPackage } = await load("packages/format.ts");
const { buildPackage } = await load("packages/build.ts");
const { packageCache } = await load("packages/cache.ts");
const { z } = await import(pathToFileURL(join(strutDir, "node_modules", "zod", "index.js")).href).catch(() =>
  load("index.ts"),
);

const HOST_CORE = ["log", "if", "loop", "foreach", "subflow", "wait", "pack", "llm"];
/** strut-host's registry.ts RESEARCH_BROWSER_STEPS: what its research plugin adds, beside a restricted agent. */
const HOST_BROWSER = ["open", "goto", "snapshot", "text", "click", "fill", "type", "press", "scroll", "select", "hover", "back", "wait", "screenshot", "close"].map((v) => `browser/${v}`);
/** The inputs each workflow is run with in 5, by the workflow's file name; expect is the run's status (default success). */
const RUNS = {
  check: [
    { input: {} },
    { input: { probe_url: "https://example.org", expect_text: "never there" } },
    { input: { ip_url: "https://blocked.example/ip" } },
  ],
  "read-page": [
    { input: { url: "https://example.com/pricing" } },
    { input: { url: "https://example.com/pricing", selector: "main", wait_for: "Plans" } },
    { input: { url: "https://example.com/pricing", wait_for: "never there" }, expect: "error" },
  ],
  "search-site": [
    { input: { url: "https://example.com/", search_box: "input[type=search]", query: "pricing" } },
    { input: { url: "https://example.com/", search_box: "#q", query: "plans", results: "#results", expect_text: "Plans" } },
  ],
  explore: [{ input: { goal: "What does the cheapest plan cost?", url: "https://example.com/pricing" } }],
  // A package of Hermes checks (hermes/ask, hermes/send) uses the agents cases.
  agents: [
    { input: { agents: ["agent-a", "agent-b-blocked"], notify: "ops-channel" } },
    { input: { agents: ["agent-a"], notify: "none" } },
  ],
};
const scratch = await mkdtemp(join(tmpdir(), "check-package-"));
let failed = false;
const show = (title, value) => console.log(`\n== ${title}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);

/** Stand-ins for strut-host's two steps: same names, any config, a canned answer, and a record of each call. */
const calls = [];
const standIns = [
  defineStep({
    type: "hermes/ask",
    input: z.object({ agent: z.string(), prompt: z.string(), outcomes: z.array(z.string()).optional() }).passthrough(),
    output: z.any(),
    async run(cfg) {
      calls.push({ step: "hermes/ask", agent: cfg.agent, promptChars: cfg.prompt.length, outcomes: cfg.outcomes });
      if (cfg.agent.endsWith("-throws")) throw new Error(`the gateway refused ${cfg.agent}`);
      if (cfg.agent.endsWith("-blocked")) {
        return { agent: cfg.agent, status: "completed", text: "A CAPTCHA page stopped me.", outcome: "blocked",
          data: { tools_seen: 24, egress_ip: "", ipify_ok: false, example_ok: false, block_seen: "CAPTCHA on api.ipify.org", error: "" } };
      }
      return { agent: cfg.agent, status: "completed", text: "Both pages opened.", outcome: "ok",
        data: { tools_seen: 24, egress_ip: "203.0.113.7", ipify_ok: true, example_ok: true, block_seen: "", error: "" } };
    },
  }),
  defineStep({
    type: "hermes/send",
    input: z.object({ to: z.string(), text: z.string() }).passthrough(),
    output: z.any(),
    async run(cfg) {
      calls.push({ step: "hermes/send", to: cfg.to, text: cfg.text });
      return { sent: true, messageId: "1" };
    },
  }),
];

/** A stand-in agent: the research plugin's rules (built-ins named, browser verbs only, no MCP), a canned answer. */
const agentStandIn = defineStep({
  type: "agent",
  input: z.object({ prompt: z.string(), agentTools: z.array(z.string()).optional(), toolFilter: z.array(z.string()).optional(), mcp: z.boolean().optional() }).passthrough(),
  output: z.any(),
  async run(cfg) {
    const problems = [];
    if (!(cfg.toolFilter ?? []).length) problems.push("toolFilter must name its built-in tools");
    if ((cfg.agentTools ?? []).some((t) => t !== "browser/*" && !HOST_BROWSER.includes(t))) problems.push("agentTools outside browser/*");
    if (cfg.mcp !== false) problems.push("mcp must be false");
    calls.push({ step: "agent", agentTools: cfg.agentTools, toolFilter: cfg.toolFilter, problems });
    if (problems.length) throw new Error(`agent: refused by the host: ${problems.join("; ")}`);
    return { object: { answer: "Plans start at $10.", evidence: [{ path: "shots/001.png", url: "/artifacts/r/shots/001.png" }], pages: [cfg.prompt.match(/https?:\/\/\S+/)?.[0] ?? ""], blocked: "" }, cost: 0.01 };
  },
});

/** A stand-in browser with the BrowserService verbs the browser steps call, one page per run, and a record of each call. */
function standInBrowser() {
  const pages = new Map();
  const live = (runId) => {
    const p = pages.get(runId);
    if (!p) throw new Error("browser: call browser/open first");
    return p;
  };
  const log = (verb, runId, input) => calls.push({ step: `browser/${verb}`, ...(input ?? {}) });
  const nav = (p, url) => Object.assign(p, { url, title: `Title of ${url}` });
  let shots = 0;
  return {
    async open(runId, input) { log("open", runId, { url: input.url }); const resumed = pages.has(runId); const p = pages.get(runId) ?? {}; pages.set(runId, p); if (input.url) nav(p, input.url); return { url: p.url ?? "about:blank", title: p.title ?? "", status: 200, resumed }; },
    async goto(runId, input) { log("goto", runId, { url: input.url }); const p = live(runId); if (input.url.includes("blocked")) throw new Error("goto: net::ERR_TUNNEL_CONNECTION_FAILED"); nav(p, input.url); return { url: p.url, title: p.title, status: 200 }; },
    async snapshot(runId) { log("snapshot", runId); const p = live(runId); return { url: p.url, title: p.title, tree: '- RootWebArea "Example Domain" [ref=e1]\n  - heading "Example Domain" [ref=e2]' }; },
    async text(runId, input) { log("text", runId, { selector: input?.selector }); const p = live(runId); return { text: p.url.includes("ipify") ? "203.0.113.7" : `Text of ${p.url}${input?.selector ? ` at ${input.selector}` : ""}` }; },
    async click(runId) { log("click", runId); return { url: live(runId).url }; },
    async fill(runId, input) { log("fill", runId, { selector: input.selector, value: input.value }); live(runId); return { ok: true }; },
    async type(runId) { log("type", runId); live(runId); return { ok: true }; },
    async press(runId, input) { log("press", runId, { key: input.key }); const p = live(runId); if (input.key === "Enter") nav(p, `${p.url}?q=results`); return { url: p.url }; },
    async select(runId) { log("select", runId); live(runId); return { ok: true }; },
    async hover(runId) { log("hover", runId); live(runId); return { ok: true }; },
    async scroll(runId) { log("scroll", runId); live(runId); return { ok: true }; },
    async back(runId) { log("back", runId); const p = live(runId); return { url: p.url, title: p.title }; },
    async wait(runId, input) { log("wait", runId, { text: input.text, ms: input.ms }); live(runId); if (input.text === "never there") throw new Error("timed out waiting for text"); return { ok: true, waitedMs: 1 }; },
    async screenshot(runId, input, sink) { log("screenshot", runId, { name: input.name }); live(runId); const path = `shots/${input.name ?? String(++shots).padStart(3, "0")}.png`; await sink.artifacts.write(runId, path, Buffer.from("png")); return { path, dir: "/tmp", url: `/artifacts/${runId}/${path}`, width: 1585, height: 857, bytes: 3, small: Buffer.from("png") }; },
    async closeRun(runId) { log("close", runId); pages.delete(runId); return { ok: true }; },
    async dispose(runId) { pages.delete(runId); },
    async close() { pages.clear(); },
  };
}

const boot = (name, registry, workspace) =>
  createStrut({
    workspace: workspace ?? new WorkspaceManager(join(scratch, name)),
    dataDir: join(scratch, `${name}-data`),
    store: new MemoryRunStore(),
    ...(registry ? { registry } : {}),
    serveUi: false, scheduler: false, enableChat: false, systemWorkflows: false, browserWorkflows: false,
    privacyWorkflows: false, mediaWorkflows: false, job: false, orchestrator: false, builder: false, views: false,
    earnings: false, concepts: false, stt: false,
  });

async function install(strut) {
  const res = await strut.app.request("/packages/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref: `file:${pkgDir}` }),
  });
  return { status: res.status, body: await res.json() };
}

try {
  // 1. Read.
  let info;
  try {
    info = await readPackage(pkgDir);
    show("1. readPackage", { manifest: info.manifest, digest: info.digest, files: info.files, items: info.items });
  } catch (err) {
    failed = true;
    show("1. readPackage REFUSED", err.message);
  }

  // 2. Plain Strut.
  const plain = await boot("plain");
  const plainInstall = await install(plain);
  show(`2. install on a plain Strut: HTTP ${plainInstall.status}`, plainInstall.body);

  // 3. Host-shaped Strut.
  const core = coreRegistry();
  const library = await createRegistry([]);
  const registry = Object.fromEntries(HOST_CORE.map((t) => [t, core[t]]));
  for (const t of HOST_BROWSER) registry[t] = library[t];
  for (const def of standIns) registry[def.type] = def;
  const hostRegistry = { ...registry, agent: library.agent };
  const host = await boot("host", hostRegistry);
  const hostInstall = await install(host);
  show(`3. install on a Strut with an injected registry, as a host with its own step list makes it: HTTP ${hostInstall.status}`, hostInstall.body);

  // 3b. Workspace stand-ins for the two Hermes steps.
  const standInSource = (type) =>
    `import { z, defineStep } from "strut";\nexport default defineStep({ type: ${JSON.stringify(type)}, input: z.object({}).passthrough(), output: z.any(), async run() { return {}; } });\n`;
  const ws = new WorkspaceManager(join(scratch, "buyer"));
  for (const type of ["hermes/ask", "hermes/send"]) await ws.publishStep(type, standInSource(type));
  const buyer = await boot("buyer", undefined, ws);
  const buyerInstall = await install(buyer);
  show(`3b. install on a Strut whose workspace has steps named hermes/ask and hermes/send: HTTP ${buyerInstall.status}`, buyerInstall.body);
  if (buyerInstall.status !== 201) failed = true;

  // 4. Build, dry run.
  const workflows = (info?.items ?? []).filter((i) => i.kind === "workflow").map((i) => i.name);
  const concepts = (info?.items ?? []).filter((i) => i.kind === "concept").map((i) => i.name);
  try {
    const deps = {
      workspace: buyer.workspace,
      cache: packageCache(buyer.dataDir),
      apps: buyer.apps,
      ...(buyer.workspace.graph ? { graph: buyer.workspace.graph } : {}),
      claims: buyer.claims ? { reader: buyer.claims } : null,
      getRegistry: async () => {
        await buyer.rebuildRegistry();
        return buyer.getRegistry();
      },
    };
    const req = { package: info.manifest.package, version: info.manifest.version, workflows };
    const built = await buildPackage(deps, req, { dryRun: true });
    show(`4. buildPackage dry run of ${workflows.join(", ")}`, built);
    if (concepts.length) {
      try {
        const withConcepts = await buildPackage(deps, { ...req, concepts }, { dryRun: true });
        show(`4b. buildPackage dry run with the Concepts ${concepts.join(", ")}`, withConcepts);
      } catch (err) {
        show("4b. buildPackage with Concepts REFUSED (reported only: this Strut was booted without a Concept graph)", err.message);
      }
    }
  } catch (err) {
    failed = true;
    show("4. buildPackage REFUSED", err.message);
  }

  // 5. Run each workflow with the stand-ins answering.
  const runRegistry = { ...registry, agent: agentStandIn };
  const artifactsStore = new Map();
  const artifacts = {
    write: async (runId, path, data) => void artifactsStore.set(`${runId}/${path}`, data),
    list: async (runId) => [...artifactsStore.keys()].filter((k) => k.startsWith(`${runId}/`)),
    dir: async (runId) => join(scratch, "artifacts", runId),
  };
  for (const item of (info?.items ?? []).filter((i) => i.kind === "workflow")) {
    const flow = flowFromYaml(item.name, "v1", await readFile(join(pkgDir, item.path), "utf-8"));
    const cases = RUNS[item.name.split("/").pop()];
    if (!cases) {
      failed = true;
      show(`5. run ${item.name}: NO CASES`, "check-package.mjs names no inputs for this workflow (RUNS)");
      continue;
    }
    for (const { input, expect } of cases) {
      calls.length = 0;
      const result = await runWorkflow(flow, input, runRegistry, { store: new MemoryRunStore(), services: { browser: standInBrowser(), artifacts } });
      const ok = result.status === (expect ?? "success");
      show(`5. run ${item.name} with ${JSON.stringify(input)}: ${result.status}${ok ? "" : " (UNEXPECTED)"}`, { output: result.output, error: result.error?.message, calls });
      if (!ok) failed = true;
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
console.log(failed ? "\nRESULT: FAIL" : "\nRESULT: PASS");
process.exit(failed ? 1 : 0);

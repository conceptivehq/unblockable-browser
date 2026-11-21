// Fetches Strut at the commit this code is built against into strut/.strut, installs its own locked dependencies,
// builds it, and links node_modules/strut to it. Run again after the commit changes; a checkout already at the commit
// and built is kept.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const STRUT = {
  repo: "https://github.com/stakwork/strut.git",
  commit: "d4e659509c21e7149ab396f3ea8207241949a14d",
};

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(here, ".strut");
const run = (cmd, args, cwd = dir) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
const head = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

if (!existsSync(join(dir, ".git"))) {
  run("git", ["clone", "--quiet", "--no-checkout", STRUT.repo, dir], here);
}
if (!existsSync(join(dir, "package.json")) || head() !== STRUT.commit || !existsSync(join(dir, "build", "index.js"))) {
  run("git", ["fetch", "--quiet", "origin", STRUT.commit]);
  run("git", ["checkout", "--quiet", "--detach", STRUT.commit]);
  if (head() !== STRUT.commit) throw new Error(`Strut checkout is at ${head()}, not ${STRUT.commit}`);
  run("yarn", ["install", "--frozen-lockfile", "--ignore-scripts"]);
  run("yarn", ["build"]);
}

const link = join(here, "node_modules", "strut");
const target = relative(dirname(link), dir);
mkdirSync(dirname(link), { recursive: true });
let linked = false;
try {
  linked = lstatSync(link).isSymbolicLink();
  if (!linked) throw new Error(`${link} exists and is not a link; remove it first`);
  if (readlinkSync(link) !== target) {
    unlinkSync(link);
    linked = false;
  }
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
if (!linked) symlinkSync(target, link);
console.log(`Strut ${STRUT.commit.slice(0, 7)} is in .strut, linked as node_modules/strut`);

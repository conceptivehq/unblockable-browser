"""Tests for the unblockable browser kit. Run: python3 -m unittest discover -s kits/unblockable-browser/test

No systemd, git, npm or browser is used: commands go through a fake runner, and the shell scripts run against stub
`node`, `systemctl` and `chromium` programs in a temporary folder.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
from contextlib import redirect_stdout
from pathlib import Path

KIT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KIT))

import unblockable_browser as bl  # noqa: E402

COMMIT = "0123456789abcdef0123456789abcdef01234567"
AT = chr(64)  # keeps e-mail-shaped text out of this file
MKT, SUP = "examplemarketing", "examplesupport"
NODE = shutil.which("node")


def unit(kind: str, instance: str | int = "") -> str:
    return f"fleet-{kind}{AT}{instance}.service"


def config_file(home: Path, **over) -> dict:
    cfg = {
        "schema_version": 1,
        "display": 100,
        "vnc": False,
        "chromium": "/usr/lib/chromium/chromium",
        "node": "~/.local/bin/node",
        "root": "~/.local/share/unblockable-browser",
        "browser_mcp": {"repo": "https://github.com/example/browser-mcp", "commit": COMMIT},
        "browsers": [
            {"profile": MKT, "port": 21201, "hermes_home": "~/.hermes/profiles/" + MKT, "proxy": "residential",
             "timezone": "America/Los_Angeles"},
            {"profile": SUP, "port": 21202, "hermes_home": "~/.hermes/profiles/" + SUP, "proxy": "none"},
        ],
        "proxies": {"residential": {"env_file": "~/.config/unblockable-browser/proxy.env",
                                    "pac_hosts": ["linkedin.com", "g2.com"], "auth": "allowlist"}},
    }
    cfg.update(over)
    return cfg


class FakeRunner(bl.Runner):
    """Real file effects in the temporary home; commands are recorded and answered here."""

    def __init__(self, home: Path, head: str = COMMIT, ss: str = "", active: str = "active"):
        self.home, self.head, self.ss, self.active = home, head, ss, active
        self.calls: list[list[str]] = []
        self.probes: list[dict] = []

    def run(self, argv, *, cwd=None, env=None, check=True, timeout=None):
        argv = [str(a) for a in argv]
        self.calls.append(argv)
        out, code = "", 0
        name = Path(argv[0]).name
        if name == "git" and argv[1] == "clone":
            Path(argv[-1]).mkdir(parents=True)
        elif name == "git" and "rev-parse" in argv:
            out = self.head + "\n"
        elif name == "npm" and argv[1:3] == ["run", "package"]:
            outdir = Path(argv[argv.index("--output-dir") + 1])
            if outdir.exists():
                shutil.rmtree(outdir)
            profiles = [argv[i + 1] for i, a in enumerate(argv) if a == "--profile"]
            artifacts = {"files": ["config.js", "manifest.json"], "profiles": []}
            for spec in profiles:
                p, port = spec.split(":")
                d = outdir / "profiles" / p
                d.mkdir(parents=True)
                (d / "manifest.json").write_text('{"manifest_version": 3}')
                (d / "config.js").write_text(f'export default Object.freeze({{"port":{port},"profile":"{p}","locked":true}});\n')
                artifacts["profiles"].append({"name": p, "port": int(port)})
            (outdir / "artifacts.json").write_text(json.dumps(artifacts))
        elif argv[1:2] == ["scripts/doctor.mjs"]:
            ext = Path(argv[argv.index("--extension-dir") + 1])
            cfgjs = (ext / "config.js").read_text() if (ext / "config.js").exists() else ""
            if cfgjs:
                route = json.loads(cfgjs.split("freeze(", 1)[1].rsplit(")", 1)[0])
                out = f"PASS  Installed config is inert — effective route is locked to {route['profile']}:{route['port']}\n"
            else:
                out, code = "FAIL  Installed dir readable\n", 1
        elif name == "systemctl" and "is-active" in argv:
            out = self.active + "\n"
            code = 0 if self.active == "active" else 3
        elif name == "ss":
            out = self.ss
        return subprocess.CompletedProcess(argv, code, out, "")

    def mcp_probe(self, argv, env, timeout):
        self.probes.append(env)
        return {"server": "local-browser-mcp", "tools": 24}


class Home:
    """A temporary home with a fake node and npm, and optionally the proxy env file."""

    def __init__(self, proxy_env: str | None = "PROXY_SERVER=proxy.example.net:8000\n", mode: int = 0o600):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(os.path.realpath(self.tmp.name))
        nb = self.home / ".local" / "bin"
        nb.mkdir(parents=True)
        for name in ("node", "npm"):
            (nb / name).write_text("#!/bin/sh\nexit 0\n")
            (nb / name).chmod(0o755)
        if proxy_env is not None:
            d = self.home / ".config" / "unblockable-browser"
            d.mkdir(parents=True)
            (d / "proxy.env").write_text(proxy_env)
            (d / "proxy.env").chmod(mode)
        self.root = self.home / ".local" / "share" / "unblockable-browser"
        self.units = self.home / ".config" / "systemd" / "user"

    def config(self, **over) -> Path:
        path = self.home / "browsers.json"
        path.write_text(json.dumps(config_file(self.home, **over)))
        return path

    def main(self, *args: str, runner: bl.Runner | None = None, **over) -> tuple[int, str]:
        lines: list[str] = []
        code = bl.main([*args, "--config", str(self.config(**over))], runner=runner or FakeRunner(self.home),
                       home=self.home, out=lines.append)
        return code, "\n".join(lines)

    def close(self) -> None:
        self.tmp.cleanup()


class HomeCase(unittest.TestCase):
    def setUp(self):
        self.h = Home()
        self.addCleanup(self.h.close)


# --- The config file ----------------------------------------------------------------------------------------------------


class ConfigTests(HomeCase):
    def problems(self, **over) -> list[str]:
        with self.assertRaises(bl.ConfigError) as ctx:
            bl.parse_config(config_file(self.h.home, **over), self.h.home)
        return ctx.exception.problems

    def test_valid_example_parses(self):
        cfg = bl.load_config(KIT / "browsers.example.json", self.h.home)
        self.assertEqual([browser.profile for browser in cfg.browsers], [MKT, SUP, "strut"])
        self.assertEqual([browser.client for browser in cfg.browsers], ["hermes", "hermes", "strut"])
        self.assertEqual(cfg.root, self.h.home / ".local/share/unblockable-browser")
        self.assertEqual(cfg.display, 100)
        self.assertEqual(cfg.browsers[1].proxy, None)
        self.assertEqual(cfg.browsers[1].timezone, "UTC")

    def test_the_older_lanes_key_still_reads(self):
        raw = config_file(self.h.home)
        raw["lanes"] = raw.pop("browsers")
        self.assertEqual([b.profile for b in bl.parse_config(raw, self.h.home).browsers],
                         [b.profile for b in bl.parse_config(config_file(self.h.home), self.h.home).browsers])
        raw["browsers"] = raw["lanes"]
        with self.assertRaises(bl.ConfigError) as ctx:
            bl.parse_config(raw, self.h.home)
        self.assertIn("not both", " | ".join(ctx.exception.problems))

    def test_unknown_keys_are_refused_at_every_level(self):
        raw = config_file(self.h.home, extra=1)
        raw["browsers"][0]["headless"] = True
        raw["browser_mcp"]["branch"] = "main"
        raw["proxies"]["residential"]["password"] = "x"
        with self.assertRaises(bl.ConfigError) as ctx:
            bl.parse_config(raw, self.h.home)
        text = " | ".join(ctx.exception.problems)
        for word in ("unknown keys: extra", "browsers[0]: unknown keys: headless", "browser_mcp: unknown keys: branch",
                     "proxies.residential: unknown keys: password"):
            self.assertIn(word, text)

    def test_commit_must_be_a_full_lowercase_sha(self):
        for commit in ("524a874", COMMIT.upper(), COMMIT[:-1], COMMIT + "0", "", 5):
            with self.subTest(commit=commit):
                probs = self.problems(browser_mcp={"repo": "https://github.com/example/browser-mcp", "commit": commit})
                self.assertTrue(any("full 40-character" in p for p in probs), probs)

    def test_repo_must_be_plain_https(self):
        for repo in ("http://github.com/x/y", "git" + AT + "github.com:x/y", "https://tok" + AT + "host.test/x",
                     "https://github.com/x/y?a=1", "file:///tmp/x"):
            with self.subTest(repo=repo):
                probs = self.problems(browser_mcp={"repo": repo, "commit": COMMIT})
                self.assertTrue(any("browser_mcp.repo" in p for p in probs), probs)

    def test_browser_refusals(self):
        def browsers(*specs):
            return [{"profile": MKT, "port": 21201, "hermes_home": "~/.hermes/a", **s} for s in specs]
        cases = {
            "profile must match": browsers({"profile": "Example"}),
            "port must be an integer": browsers({"port": 80}),
            "port must be an integer ": browsers({"port": True}),
            "port 3128": browsers({"port": 3128}),
            "port 6000": browsers({"port": 6000}),
            "proxy must be none or a name": browsers({"proxy": "missing"}),
            "timezone": browsers({"timezone": "Not A Zone"}),
            "has two browsers": browsers({}, {"port": 21202}),
            "port 21201 is used by two browsers": browsers({}, {"profile": SUP}),
            "must not contain each other": browsers({"hermes_home": "~/.local/share/unblockable-browser/h"}),
            "browsers must be a non-empty list": [],
            "client must be hermes or strut": browsers({"client": "codex"}),
            "is not used by a strut browser": browsers({"client": "strut"}),
            "only one browser may be the strut browser": [{"profile": "strut", "port": 21203, "client": "strut"},
                                                    {"profile": "strut2", "port": 21204, "client": "strut"}],
        }
        for word, value in cases.items():
            with self.subTest(word=word):
                probs = self.problems(browsers=value)
                self.assertTrue(any(word.strip() in p for p in probs), probs)

    def test_path_refusals(self):
        cases = {
            "root": [("relative/path", "absolute"), ("~/../x", "plain path"), ("/opt/browser", "inside the home"),
                     ("~/browser", "two levels"), ("~/.config", "two levels"), ("~/a b/c", "absolute path of letters")],
            "chromium": [("chromium", "absolute")],
        }
        for key, values in cases.items():
            for value, word in values:
                with self.subTest(key=key, value=value):
                    probs = self.problems(**{key: value})
                    self.assertTrue(any(word in p for p in probs), probs)
        bl.parse_config(config_file(self.h.home, root="~/.config/systemd-browser"), self.h.home)  # a sibling is fine
        self.assertTrue(any("systemd" in p for p in self.problems(root="~/.config/systemd")))

    def test_proxy_refusals(self):
        proxies = {
            "a": {"env_file": "~/.config/x/a.env", "pac_hosts": ["example.com"], "auth": "password"},
            "b": {"env_file": "~/.config/x/b.env", "pac_hosts": ["example.org"], "auth": "password"},
            "none": {"env_file": "~/.config/x/c.env", "pac_hosts": ["example.net"], "auth": "allowlist"},
            "c": {"env_file": "~/.local/share/unblockable-browser/p.env", "pac_hosts": ["Example.com", "*.x.com"], "auth": "basic"},
        }
        text = " | ".join(self.problems(proxies=proxies))
        for word in ("only one proxy may use password auth", "proxies.none", "outside the kit's root",
                     "proxies.c.pac_hosts", "proxies.c.auth"):
            self.assertIn(word, text)

    def test_every_problem_is_reported_together(self):
        probs = self.problems(schema_version=2, display=0, vnc="yes")
        self.assertEqual(len(probs), 3, probs)


# --- plan and apply ---------------------------------------------------------------------------------------------------


class PlanTests(HomeCase):
    def test_plan_lists_every_action_and_runs_nothing(self):
        runner = FakeRunner(self.h.home)
        code, out = self.h.main("plan", runner=runner)
        self.assertEqual(code, 0, out)
        self.assertEqual(runner.calls, [], "plan runs no command")
        self.assertFalse(self.h.root.exists(), "plan writes nothing")
        for word in (
            "Plan (dry run",
            f"clone https://github.com/example/browser-mcp into {self.h.root}/browser-mcp/{COMMIT}",
            "npm ci --ignore-scripts",
            f"npm run package -- --output-dir {self.h.root}/package-out --profile {MKT}:21201 --profile {SUP}:21202",
            f"copy {self.h.root}/package-out/profiles/{MKT} physically to {self.h.root}/extensions/{MKT}",
            "run Browser MCP's doctor",
            f"write {self.h.root}/browsers/{MKT}.env",
            f"write {self.h.root}/pac/{MKT}.pac: linkedin.com, g2.com",
            f"write the unit {self.h.units}/{unit('browser')}",
            f"write the unit {self.h.units}/{unit('xvfb')}",
            "systemctl --user daemon-reload",
            "start nothing",
            "mcp_servers:\n  browser:\n",
            f"BROWSER_PROFILE: {MKT}",
            'BROWSER_PORT: "21202"',
            f"hermes -p {MKT} gateway restart",
        ):
            self.assertIn(word, out)
        self.assertNotIn(unit("vnc"), out)
        self.assertNotIn("fleet-proxy.service", out)
        self.assertEqual(out.count("npm run package"), 1, "all browsers are packaged in one call")

    def test_apply_without_execute_is_a_dry_run(self):
        runner = FakeRunner(self.h.home)
        code, out = self.h.main("apply", runner=runner)
        self.assertEqual(code, 0)
        self.assertIn("Plan (dry run", out)
        self.assertEqual(runner.calls, [])
        self.assertFalse(self.h.root.exists())

    def test_plan_refuses_a_browser_whose_proxy_server_is_unknown(self):
        (self.h.home / ".config/unblockable-browser/proxy.env").write_text("PROXY_USERNAME=someone\n")
        code, out = self.h.main("plan")
        self.assertEqual(code, 1)
        self.assertIn(f"REFUSED browser {MKT}: PROXY_SERVER is missing", out)
        self.assertNotIn(f"--profile {MKT}:21201", out)
        self.assertIn(f"--profile {SUP}:21202", out)
        self.assertNotIn(f"BROWSER_PROFILE: {MKT}", out)
        self.assertNotIn("someone", out, "the env file's other values are never printed")

    def test_plan_refuses_a_world_readable_or_missing_env_file(self):
        env = self.h.home / ".config/unblockable-browser/proxy.env"
        env.chmod(0o644)
        self.assertIn("readable by others", self.h.main("plan")[1])
        env.unlink()
        self.assertIn("does not exist", self.h.main("plan")[1])

    def test_password_proxy_adds_the_forwarder_unit_and_a_loopback_pac(self):
        proxies = {"residential": {"env_file": "~/.config/unblockable-browser/proxy.env",
                                   "pac_hosts": ["linkedin.com"], "auth": "password"}}
        (self.h.home / ".config/unblockable-browser/proxy.env").write_text("PROXY_USERNAME=u\nPROXY_PASSWORD=pw-secret\n")
        code, out = self.h.main("apply", "--execute", proxies=proxies, vnc=True)
        self.assertEqual(code, 0, out)
        self.assertIn("PROXY 127.0.0.1:3128", (self.h.root / f"pac/{MKT}.pac").read_text())
        proxy_unit = (self.h.units / "fleet-proxy.service").read_text()
        self.assertIn(f"EnvironmentFile={self.h.home}/.config/unblockable-browser/proxy.env", proxy_unit)
        self.assertIn(f"ExecStart={self.h.home}/.local/bin/node {self.h.root}/bin/proxy-forward.mjs", proxy_unit)
        self.assertIn("-rfbport 6000", (self.h.units / unit("vnc")).read_text())
        self.assertNotIn("pw-secret", out)
        for path in self.h.root.rglob("*"):
            if path.is_file():
                self.assertNotIn("pw-secret", path.read_text(errors="ignore"), path)


class ApplyTests(HomeCase):
    def test_apply_execute_installs_every_browser(self):
        runner = FakeRunner(self.h.home)
        code, out = self.h.main("apply", "--execute", runner=runner)
        self.assertEqual(code, 0, out)
        cmds = [" ".join(Path(c[0]).name if i == 0 else c[i] for i in range(len(c))) for c in runner.calls]
        self.assertTrue(cmds[0].startswith("git clone --quiet --no-checkout https://github.com/example/browser-mcp"))
        self.assertTrue(cmds[1].endswith(f"checkout --quiet --detach {COMMIT}"))
        self.assertIn("rev-parse HEAD", cmds[2])
        self.assertEqual(sum(1 for c in cmds if c.startswith("npm ci --ignore-scripts")), 1)
        self.assertEqual(sum(1 for c in cmds if c.startswith("npm run package")), 1)
        self.assertEqual(sum(1 for c in cmds if "scripts/doctor.mjs" in c), 2)
        self.assertEqual(cmds[-1], "systemctl --user daemon-reload")
        self.assertFalse(any("enable" in c or " start" in c for c in cmds), "nothing is started without --start")
        self.assertFalse(any("test/" in c for c in cmds), "no tests without --with-tests")

        root = self.h.root
        self.assertEqual((root / "current").read_text(), COMMIT + "\n")
        ext = root / "extensions" / MKT
        self.assertTrue(ext.is_dir() and not ext.is_symlink())
        self.assertIn('"profile":"examplemarketing"', (ext / "config.js").read_text())
        self.assertEqual(sorted(p.name for p in (root / "extensions").iterdir()), sorted([MKT, SUP]))
        self.assertFalse(any(p.name.startswith(".") for p in (root / "extensions").iterdir()), "no temporary copies left")
        env = root / "browsers" / f"{MKT}.env"
        self.assertEqual(stat.S_IMODE(env.stat().st_mode), 0o600)
        text = env.read_text()
        for line in ("DISPLAY=:100", "TZ=America/Los_Angeles", f"BROWSER_PAC={root}/pac/{MKT}.pac", "BROWSER_PORT=21201"):
            self.assertIn(line, text)
        self.assertIn("BROWSER_PAC=\n", (root / "browsers" / f"{SUP}.env").read_text())
        self.assertNotIn("PAGE_ISOLATION", text, "an agent's browser keeps Browser MCP's default page mode")
        self.assertIn("PROXY proxy.example.net:8000", (root / "pac" / f"{MKT}.pac").read_text())
        self.assertFalse((root / "pac" / f"{SUP}.pac").exists())
        for name, mode in bl.BIN_FILES:
            path = root / "bin" / name
            self.assertTrue(path.is_file() and not path.is_symlink())
            self.assertEqual(path.read_bytes(), (KIT / "bin" / name).read_bytes())
            self.assertEqual(os.access(path, os.X_OK), bool(mode & 0o100), name)
        self.assertEqual(sorted(p.name for p in (KIT / "bin").iterdir()), sorted(n for n, _ in bl.BIN_FILES),
                         "every program in the kit's bin is copied")
        self.assertTrue((root / "run").is_dir())
        self.assertEqual(sorted(p.name for p in self.h.units.iterdir()),
                         sorted([unit("browser"), unit("browser-mcp"), unit("xvfb")]))
        for path in root.rglob("*"):
            self.assertFalse(path.is_symlink(), path)

    def test_apply_installs_a_strut_browser_in_window_mode(self):
        browsers = config_file(self.h.home)["browsers"] + [{"profile": "strut", "port": 21203, "client": "strut"}]
        code, out = self.h.main("apply", "--execute", browsers=browsers)
        self.assertEqual(code, 0, out)
        text = (self.h.root / "browsers" / "strut.env").read_text()
        self.assertIn("BROWSER_PORT=21203\n", text)
        self.assertIn("BROWSER_MCP_PAGE_ISOLATION=window\n", text)
        self.assertTrue((self.h.root / "extensions" / "strut").is_dir())
        self.assertIn("BROWSER_PROFILE=strut", out)
        self.assertIn("Strut host's browser env file", out)

    def test_apply_is_idempotent(self):
        self.assertEqual(self.h.main("apply", "--execute")[0], 0)
        runner = FakeRunner(self.h.home)
        code, out = self.h.main("apply", "--execute", runner=runner)
        self.assertEqual(code, 0, out)
        cmds = [" ".join(c) for c in runner.calls]
        self.assertFalse(any(" clone " in c for c in cmds), "an existing checkout is checked, not cloned again")
        self.assertFalse(any(" ci " in c for c in cmds), "a built commit is not built again")
        self.assertIn("is already built", out)
        self.assertTrue((self.h.root / "extensions" / MKT / "manifest.json").exists())
        self.assertEqual(self.h.main("apply", "--execute", "--rebuild", runner=(r := FakeRunner(self.h.home)))[0], 0)
        self.assertTrue(any(" ci " in " ".join(c) for c in r.calls))

    def test_start_and_tests_flags(self):
        runner = FakeRunner(self.h.home)
        code, out = self.h.main("apply", "--execute", "--start", "--with-tests", runner=runner)
        self.assertEqual(code, 0, out)
        cmds = [" ".join(c) for c in runner.calls]
        starts = [c.split()[-1] for c in cmds if "enable --now" in c]
        self.assertEqual(starts, [unit("xvfb", 100), unit("browser", MKT), unit("browser-mcp", MKT),
                                  unit("browser", SUP), unit("browser-mcp", SUP)])
        tests = [c for c in cmds if " test/" in c]
        self.assertEqual(len(tests), len(bl.SAFE_TESTS))
        self.assertFalse(any("browser-e2e" in c or "hermes-wrapper" in c for c in cmds), "never the headless suite")

    def test_head_mismatch_refuses_and_cleans_up(self):
        runner = FakeRunner(self.h.home, head="f" * 40)
        code, out = self.h.main("apply", "--execute", runner=runner)
        self.assertEqual(code, 1)
        self.assertIn("not the configured commit", out)
        self.assertEqual(list((self.h.root / "browser-mcp").iterdir()), [], "the clone is removed")
        self.assertFalse((self.h.root / "extensions" / MKT).exists())

    def test_doctor_failure_stops_apply(self):
        class BadDoctor(FakeRunner):
            def run(self, argv, **kw):
                if "scripts/doctor.mjs" in [str(a) for a in argv]:
                    self.calls.append([str(a) for a in argv])
                    return subprocess.CompletedProcess(argv, 1, "FAIL  Installed content hash matches — stale\n", "")
                return super().run(argv, **kw)
        code, out = self.h.main("apply", "--execute", runner=BadDoctor(self.h.home))
        self.assertEqual(code, 1)
        self.assertIn("doctor: FAIL  Installed content hash matches", out)
        self.assertFalse((self.h.units / unit("browser")).exists())


class SafetyTests(HomeCase):
    def kit(self) -> bl.Kit:
        return bl.Kit(bl.load_config(self.h.config(), self.h.home), FakeRunner(self.h.home), lambda s: None)

    def test_guard_refuses_paths_outside_the_roots(self):
        kit = self.kit()
        for path in (self.h.home / ".hermes/profiles" / MKT / "config.yaml", Path("/etc/passwd"),
                     self.h.root.parent / "other", self.h.units.parent / "x.service"):
            with self.subTest(path=path), self.assertRaises(bl.UnsafePath):
                kit.guard(path)
        with self.assertRaises(bl.UnsafePath):
            kit.guard(Path(str(self.h.root) + "/a/../../escape"))
        self.assertEqual(kit.guard(self.h.root / "bin" / "x"), self.h.root / "bin" / "x")

    def test_guard_refuses_symlinks_under_the_roots(self):
        kit = self.kit()
        self.h.root.mkdir(parents=True)
        elsewhere = self.h.home / "elsewhere"
        elsewhere.mkdir()
        (self.h.root / "extensions").symlink_to(elsewhere)
        with self.assertRaises(bl.UnsafePath):
            kit.guard(self.h.root / "extensions" / MKT)
        code, out = self.h.main("apply", "--execute")
        self.assertEqual(code, 1)
        self.assertIn("symlink", out)
        self.assertEqual(list(elsewhere.iterdir()), [], "nothing is written through the link")

    def test_a_symlinked_root_is_refused(self):
        real = self.h.home / "real-root"
        real.mkdir()
        self.h.root.parent.mkdir(parents=True)
        self.h.root.symlink_to(real)
        code, out = self.h.main("apply", "--execute")
        self.assertEqual(code, 1)
        self.assertIn("symlink", out)
        self.assertEqual(list(real.iterdir()), [])

    def test_copy_tree_refuses_a_symlink_inside_the_source(self):
        src = self.h.home / "src"
        src.mkdir()
        (src / "manifest.json").write_text("{}")
        (src / "link.js").symlink_to(src / "manifest.json")
        with self.assertRaises(bl.UnsafePath):
            bl.Runner().copy_tree(src, self.h.home / "dst")

    def test_remove_recognises_units_written_by_earlier_releases(self):
        for marker in ("# Written by example's unblockable browser kit", "# Written by example's browser lane kit"):
            self.assertEqual(self.h.main("apply", "--execute")[0], 0)
            old = self.h.units / "fleet-browser@.service"
            old.write_text(old.read_text().replace(bl.UNIT_MARKER, marker))
            self.assertNotIn(bl.UNIT_MARKER, old.read_text())
            code, out = self.h.main("remove", "--execute", runner=FakeRunner(self.h.home))
            self.assertEqual(code, 0, out)
            self.assertFalse(old.exists(), marker)

    def test_remove_keeps_a_unit_the_kit_did_not_write(self):
        self.assertEqual(self.h.main("apply", "--execute")[0], 0)
        other = self.h.units / "fleet-browser@.service"
        other.write_text(other.read_text().replace(bl.UNIT_MARKER, "# Written by hand"))
        code, out = self.h.main("remove", "--execute", runner=FakeRunner(self.h.home))
        self.assertEqual(code, 0, out)
        self.assertTrue(other.exists())

    def test_remove_deletes_only_the_kits_files(self):
        self.assertEqual(self.h.main("apply", "--execute")[0], 0)
        profile_dir = self.h.root / "profiles" / MKT / "Default"
        profile_dir.mkdir(parents=True)
        (profile_dir / "Preferences").write_text("{}")
        foreign = self.h.units / "other.service"
        foreign.write_text("[Unit]\n")
        runner = FakeRunner(self.h.home)
        code, out = self.h.main("remove", runner=runner)
        self.assertEqual(code, 0)
        self.assertEqual(runner.calls, [], "remove without --execute is a dry run")
        self.assertTrue((self.h.root / "extensions").exists())
        code, out = self.h.main("remove", "--execute", runner=runner)
        self.assertEqual(code, 0, out)
        self.assertEqual(sorted(p.name for p in self.h.root.iterdir()), ["profiles"], "user data dirs are kept")
        self.assertEqual([p.name for p in self.h.units.iterdir()], ["other.service"])
        disabled = [c[-1] for c in runner.calls if "disable" in c]
        self.assertIn(unit("browser", MKT), disabled)
        self.assertEqual(disabled[-1], unit("xvfb", 100))
        code, out = self.h.main("remove", "--execute", "--purge-profiles")
        self.assertEqual(code, 0, out)
        self.assertFalse(self.h.root.exists())


# --- Rendering --------------------------------------------------------------------------------------------------------


class RenderTests(HomeCase):
    def test_units_never_carry_headless_or_remote_debugging(self):
        proxies = {"residential": {"env_file": "~/.config/unblockable-browser/proxy.env", "pac_hosts": ["g2.com"], "auth": "password"}}
        kit = bl.Kit(bl.load_config(self.h.config(vnc=True, proxies=proxies), self.h.home), FakeRunner(self.h.home))
        units = kit.units()
        self.assertEqual(sorted(units), sorted([unit("browser"), unit("browser-mcp"), unit("xvfb"), unit("vnc"),
                                                "fleet-proxy.service"]))
        for name, text in units.items():
            body = "\n".join(line for line in text.splitlines() if not line.startswith("#"))
            self.assertNotRegex(body, r"headless|remote-debugging", name)
            self.assertNotRegex(text, r"@[A-Z_]+@", name)
            self.assertIn(bl.UNIT_MARKER, text)
        browser = units[unit("browser")]
        self.assertIn(f"Requires={unit('xvfb', 100)}", browser)
        self.assertIn(f"After={unit('xvfb', 100)}", browser)
        self.assertIn(f"EnvironmentFile={self.h.root}/browsers/%i.env", browser)
        self.assertIn(f"ExecStart={self.h.root}/bin/browser-chromium %i", browser)
        self.assertIn("Restart=on-failure", browser)
        self.assertIn("ExecStart=/usr/bin/Xvfb :%i -screen 0 1920x1080x24 -nolisten tcp", units[unit("xvfb")])
        broker = units[unit("browser-mcp")]
        self.assertIn(f"EnvironmentFile={self.h.root}/browsers/%i.env", broker)
        self.assertIn(f"ExecStart={self.h.home}/.local/bin/node {self.h.root}/bin/browser-broker.mjs serve", broker)
        self.assertIn("UMask=0077", broker)
        vnc = units[unit("vnc")]
        self.assertIn("-localhost", vnc)
        self.assertIn("-rfbport 6000", vnc)

    def test_render_template_refuses_unfilled_placeholders(self):
        with self.assertRaises(bl.StepFailed):
            bl.render_template("fleet-browser@.service".replace("@", AT), {"ROOT": "/x"})

    def test_pac(self):
        pac = bl.render_pac(("linkedin.com", "g2.com"), "PROXY proxy.example.net:8000")
        self.assertIn('var hosts = ["linkedin.com", "g2.com"]', pac)
        self.assertIn('return "PROXY proxy.example.net:8000"', pac)
        self.assertIn('return "DIRECT"', pac)
        for bad in ("DIRECT", "PROXY a b", "PROXY x:1; DIRECT"):
            with self.assertRaises(bl.StepFailed):
                bl.render_pac(("g2.com",), bad)

    @unittest.skipUnless(NODE, "node is not installed")
    def test_pac_routes_listed_hosts_and_subdomains_only(self):
        pac = bl.render_pac(("linkedin.com", "g2.com"), "PROXY 127.0.0.1:3128")
        script = pac + textwrap.dedent("""
            function dnsDomainIs(h, d) { return h.length >= d.length && h.substring(h.length - d.length) === d; }
            const hosts = ["linkedin.com", "www.LinkedIn.com", "g2.com", "notlinkedin.com", "example.com", "g2.com.evil.test"];
            console.log(JSON.stringify(hosts.map((h) => FindProxyForURL("https://" + h + "/", h))));
        """)
        out = subprocess.run([NODE, "-e", script], capture_output=True, text=True, check=True).stdout
        self.assertEqual(json.loads(out), ["PROXY 127.0.0.1:3128"] * 3 + ["DIRECT"] * 3)

    def test_parse_env_value_reads_one_key(self):
        text = "# c\nexport PROXY_SERVER='gw.example.net:7000'\nPROXY_PASSWORD=x\n"
        self.assertEqual(bl.parse_env_value(text, "PROXY_SERVER"), "gw.example.net:7000")
        self.assertIsNone(bl.parse_env_value("A=1\n", "PROXY_SERVER"))

    def test_strut_browser(self):
        browsers = config_file(self.h.home)["browsers"] + [{"profile": "strut", "port": 21203, "client": "strut", "proxy": "residential"}]
        cfg = bl.load_config(self.h.config(browsers=browsers), self.h.home)
        browser = cfg.browsers[2]
        self.assertEqual((browser.client, browser.hermes_home), ("strut", None))
        self.assertEqual(cfg.browsers[0].client, "hermes")
        block = bl.client_block(cfg, browser)
        self.assertNotIn("mcp_servers", block)
        for line in (f"BROWSER_ROOT={self.h.root}", "BROWSER_PROFILE=strut", "BROWSER_PORT=21203"):
            self.assertIn(line + "\n", block)
        self.assertIn("mcp_servers:", bl.client_block(cfg, cfg.browsers[0]))

    def test_hermes_block(self):
        cfg = bl.load_config(self.h.config(), self.h.home)
        block = bl.hermes_block(cfg, cfg.browsers[0])
        self.assertIn(f"command: {self.h.root}/bin/browser-mcp", block)
        self.assertIn(f"BROWSER_ROOT: {self.h.root}", block)
        self.assertIn('BROWSER_PORT: "21201"', block)
        self.assertIn("connect_timeout: 150", block)


class LauncherTests(HomeCase):
    """The kit's browser-chromium, run with a stub chromium that prints its arguments."""

    def setUp(self):
        super().setUp()
        root = self.h.root
        (root / "extensions" / MKT).mkdir(parents=True)
        (root / "extensions" / MKT / "manifest.json").write_text("{}")
        (root / "pac").mkdir()
        (root / "pac" / f"{MKT}.pac").write_text("function FindProxyForURL(){return 'DIRECT'}")
        self.chromium = self.h.home / "chromium"
        self.chromium.write_text('#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n')
        self.chromium.chmod(0o755)

    def launch(self, *args: str, **env: str) -> subprocess.CompletedProcess:
        base = {"PATH": "/usr/bin:/bin", "BROWSER_ROOT": str(self.h.root), "BROWSER_PROFILE": MKT,
                "BROWSER_CHROMIUM": str(self.chromium), "DISPLAY": ":100", "HOME": str(self.h.home)}
        base.update(env)
        return subprocess.run(["bash", str(KIT / "bin" / "browser-chromium"), *(args or (MKT,))],
                              env=base, capture_output=True, text=True)

    def test_new_extension_clears_cached_service_workers(self):
        workers = self.h.root / "profiles" / MKT / "Default" / "Service Worker" / "ScriptCache"
        stamp = self.h.root / "profiles" / MKT / "fleet-extension.sha256"
        workers.mkdir(parents=True)
        (workers / "old").write_text("the previous build")
        self.assertEqual(self.launch().returncode, 0)
        self.assertFalse(workers.parent.exists(), "a first start with a stamp-less profile clears the cached worker")
        first = stamp.read_text()
        workers.mkdir(parents=True)
        self.assertEqual(self.launch().returncode, 0)
        self.assertTrue(workers.exists(), "the same extension keeps the profile's workers")
        (self.h.root / "extensions" / MKT / "background.js").write_text("// a new build")
        self.assertEqual(self.launch().returncode, 0)
        self.assertFalse(workers.parent.exists(), "a changed extension copy clears them")
        self.assertNotEqual(stamp.read_text(), first)
        self.assertTrue((self.h.root / "profiles" / MKT).is_dir())

    def test_flags(self):
        proc = self.launch()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        argv = proc.stdout.splitlines()
        root = self.h.root
        for flag in (f"--user-data-dir={root}/profiles/{MKT}", f"--load-extension={root}/extensions/{MKT}",
                     f"--disable-extensions-except={root}/extensions/{MKT}", "--disable-backgrounding-occluded-windows",
                     "--no-first-run", "--no-default-browser-check", "--password-store=basic",
                     "--webrtc-ip-handling-policy=disable_non_proxied_udp", "--window-position=0,0",
                     "--window-size=1600,1000", "--new-window", "about:blank"):
            self.assertIn(flag, argv)
        self.assertFalse(any("proxy" in a for a in argv), "no proxy flag without a PAC")
        self.assertFalse(any("headless" in a or "remote-debugging" in a for a in argv))
        self.assertTrue((root / "profiles" / MKT).is_dir())

    def test_pac_flag_only_with_the_browsers_own_pac(self):
        pac = self.h.root / "pac" / f"{MKT}.pac"
        proc = self.launch(BROWSER_PAC=str(pac))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        import base64
        want = "--proxy-pac-url=data:application/x-ns-proxy-autoconfig;base64," + base64.b64encode(pac.read_bytes()).decode()
        self.assertIn(want, proc.stdout.splitlines(), "Chromium ignores file:// PAC URLs; the PAC goes in as data:")
        other = self.h.home / "other.pac"
        other.write_text("x")
        self.assertNotEqual(self.launch(BROWSER_PAC=str(other)).returncode, 0)

    def test_refusals(self):
        self.assertNotEqual(self.launch(SUP).returncode, 0, "the env file must be the browser's own")
        self.assertNotEqual(self.launch("Bad_Name").returncode, 0)
        self.assertNotEqual(self.launch(MKT, "--headless").returncode, 0)
        self.assertNotEqual(self.launch(DISPLAY="remote.example.net:0").returncode, 0)
        self.assertNotEqual(self.launch(BROWSER_ROOT="relative").returncode, 0)
        link = self.h.home / "link-root"
        link.symlink_to(self.h.root)
        self.assertNotEqual(self.launch(BROWSER_ROOT=str(link)).returncode, 0)
        shutil.rmtree(self.h.root / "extensions" / MKT)
        (self.h.root / "extensions" / MKT).symlink_to(self.h.home)
        self.assertNotEqual(self.launch().returncode, 0, "a symlinked extension dir is refused")

    def test_a_forbidden_flag_in_the_command_line_is_refused(self):
        # Defense in depth: a root path naming a forbidden flag makes the launcher refuse rather than pass it on.
        odd = self.h.home / "remote-debugging-port"
        shutil.copytree(self.h.root, odd)
        proc = self.launch(BROWSER_ROOT=str(odd))
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("forbidden flag", proc.stderr)


class ServerTests(HomeCase):
    """The kit's browser-server (what the browser's broker runs), with stub node and systemctl programs."""
    program = "browser-server"

    def setUp(self):
        super().setUp()
        root = self.h.root
        (root / "browsers").mkdir(parents=True)
        (root / "browsers" / f"{MKT}.env").write_text(f"BROWSER_PROFILE={MKT}\nBROWSER_PORT=21201\n")
        cli = root / "browser-mcp" / COMMIT / "server" / "dist" / "cli.js"
        cli.parent.mkdir(parents=True)
        cli.write_text("// stub\n")
        (root / "current").write_text(COMMIT + "\n")
        self.stubs = self.h.home / "stubs"
        self.stubs.mkdir()
        self.log = self.h.home / "systemctl.log"
        (self.stubs / "systemctl").write_text(
            f'#!/bin/sh\necho "$@" >> "{self.log}"\n[ "$2" = "is-active" ] && exit "${{FAKE_ACTIVE:-3}}"\nexit 0\n')
        (self.stubs / "systemctl").chmod(0o755)
        self.node = self.stubs / "node"
        self.node.write_text('#!/bin/sh\necho "node $*"\n')
        self.node.chmod(0o755)

    def adapter(self, **env: str) -> subprocess.CompletedProcess:
        base = {"PATH": f"{self.stubs}:/usr/bin:/bin", "HOME": str(self.h.home), "XDG_RUNTIME_DIR": str(self.h.home),
                "BROWSER_ROOT": str(self.h.root), "BROWSER_PROFILE": MKT, "BROWSER_PORT": "21201",
                "BROWSER_NODE": str(self.node)}
        base.update(env)
        return subprocess.run(["bash", str(KIT / "bin" / self.program)], env=base, capture_output=True, text=True)

    def test_starts_the_browser_unit_then_execs_the_server(self):
        proc = self.adapter()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        cli = self.h.root / "browser-mcp" / COMMIT / "server" / "dist" / "cli.js"
        self.assertEqual(proc.stdout.strip(),
                         f"node {cli} start --extension-port 21201 --profile {MKT} --require-extension --extension-connect-timeout 90000")
        calls = self.log.read_text().splitlines()
        self.assertEqual(calls, [f"--user is-active --quiet {unit('browser', MKT)}", f"--user start {unit('browser', MKT)}"])

    def test_an_active_unit_is_not_started_again(self):
        self.assertEqual(self.adapter(FAKE_ACTIVE="0").returncode, 0)
        self.assertEqual(len(self.log.read_text().splitlines()), 1)

    def test_refusals(self):
        link = self.h.home / "link"
        link.symlink_to(self.h.root)
        cases = {
            "profile": {"BROWSER_PROFILE": "../x"},
            "empty profile": {"BROWSER_PROFILE": ""},
            "port text": {"BROWSER_PORT": "21201; rm"},
            "low port": {"BROWSER_PORT": "80"},
            "high port": {"BROWSER_PORT": "70000"},
            "other browser's port": {"BROWSER_PORT": "21202"},
            "relative root": {"BROWSER_ROOT": "browser"},
            "symlinked root": {"BROWSER_ROOT": str(link)},
            "unknown browser": {"BROWSER_PROFILE": SUP},
        }
        for name, env in cases.items():
            with self.subTest(name=name):
                proc = self.adapter(**env)
                self.assertNotEqual(proc.returncode, 0, proc.stdout)
                self.assertNotIn("node ", proc.stdout, "the server never starts")
        self.assertFalse(self.log.exists(), "no unit is started when the input is refused")

    def test_current_must_be_a_plain_file_with_a_full_sha(self):
        if self.program != "browser-server":
            self.skipTest("only the server reads current")
        current = self.h.root / "current"
        current.write_text("524a874\n")
        self.assertNotEqual(self.adapter().returncode, 0)
        current.unlink()
        (self.h.root / "other").write_text(COMMIT + "\n")
        current.symlink_to(self.h.root / "other")
        self.assertNotEqual(self.adapter().returncode, 0)


class ClientTests(ServerTests):
    """The kit's browser-mcp: the same checks, then the browser's broker unit and the socket relay."""
    program = "browser-mcp"

    def setUp(self):
        super().setUp()
        (self.h.root / "bin").mkdir()
        (self.h.root / "bin" / "browser-broker.mjs").write_text("// stub\n")

    def test_starts_the_browser_unit_then_execs_the_server(self):
        proc = self.adapter()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        root = self.h.root
        self.assertEqual(proc.stdout.strip(), f"node {root}/bin/browser-broker.mjs connect {root}/run/{MKT}.sock")
        calls = self.log.read_text().splitlines()
        self.assertEqual(calls, [f"--user is-active --quiet {unit('browser-mcp', MKT)}",
                                 f"--user start {unit('browser-mcp', MKT)}"])

    def test_sets_xdg_runtime_dir_when_the_caller_does_not(self):
        (self.stubs / "systemctl").write_text(f'#!/bin/sh\necho "$XDG_RUNTIME_DIR" >> "{self.log}"\nexit 0\n')
        env = {"PATH": f"{self.stubs}:/usr/bin:/bin", "HOME": str(self.h.home), "BROWSER_ROOT": str(self.h.root),
               "BROWSER_PROFILE": MKT, "BROWSER_PORT": "21201", "BROWSER_NODE": str(self.node)}
        proc = subprocess.run(["bash", str(KIT / "bin" / self.program)], env=env, capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.log.read_text().splitlines(), [f"/run/user/{os.getuid()}"])

    def test_a_missing_broker_is_refused(self):
        (self.h.root / "bin" / "browser-broker.mjs").unlink()
        proc = self.adapter()
        self.assertNotEqual(proc.returncode, 0)
        self.assertFalse(self.log.exists())


@unittest.skipUnless(NODE, "node is not installed")
class BrokerTests(unittest.TestCase):
    """The broker's own tests are in test/broker.test.mjs; this runs them with the Python suite."""

    def test_node_suite(self):
        proc = subprocess.run([NODE, "--test", str(KIT / "test" / "broker.test.mjs")], capture_output=True, text=True,
                              timeout=120)
        self.assertEqual(proc.returncode, 0, proc.stdout[-3000:] + proc.stderr[-2000:])


# --- verify -----------------------------------------------------------------------------------------------------------


SS = """\
LISTEN 0      511        127.0.0.1:21201      0.0.0.0:*
LISTEN 0      511           [::1]:21201         [::]:*
LISTEN 0      4096         0.0.0.0:21202      0.0.0.0:*
LISTEN 0      128          0.0.0.0:22         0.0.0.0:*
LISTEN 0      4096   127.0.0.53%lo:53         0.0.0.0:*
LISTEN 0      128             [::]:22            [::]:*
LISTEN 0      511                *:8080             *:*
"""


class VerifyTests(HomeCase):
    def test_parse_ss(self):
        ports = bl.parse_ss(SS)
        self.assertEqual(ports[21201], ["127.0.0.1", "[::1]"])
        self.assertEqual(ports[21202], ["0.0.0.0"])
        self.assertTrue(all(bl.is_loopback(h) for h in ports[21201]))
        self.assertTrue(bl.is_loopback("127.0.0.53%lo"))
        for host in ("0.0.0.0", "[::]", "*", "10.0.0.5", "::ffff:10.0.0.5"):
            self.assertFalse(bl.is_loopback(host), host)
        self.assertTrue(bl.is_loopback("::ffff:127.0.0.1"))

    def test_extension_in_prefs(self):
        ext = self.h.root / "extensions" / MKT
        enabled = {"extensions": {"settings": {"abc": {"path": str(ext), "location": 8, "state": 1}}}}
        newer = {"extensions": {"settings": {"abc": {"path": str(ext), "location": 8, "disable_reasons": []}}}}
        disabled = {"extensions": {"settings": {"abc": {"path": str(ext), "state": 0, "disable_reasons": [1]}}}}
        other = {"extensions": {"settings": {"abc": {"path": "/elsewhere"}}}}
        self.assertTrue(bl.extension_in_prefs([json.dumps(enabled)], ext)[0])
        self.assertTrue(bl.extension_in_prefs(["not json", json.dumps(newer)], ext)[0])
        ok, detail = bl.extension_in_prefs([json.dumps(disabled)], ext)
        self.assertFalse(ok)
        self.assertIn("disabled", detail)
        self.assertFalse(bl.extension_in_prefs([json.dumps(other)], ext)[0])

    def test_verify_reports_named_checks(self):
        self.assertEqual(self.h.main("apply", "--execute")[0], 0)
        for browser in (MKT, SUP):
            d = self.h.root / "profiles" / browser / "Default"
            d.mkdir(parents=True)
            prefs = {"extensions": {"settings": {"id": {"path": str(self.h.root / "extensions" / browser), "state": 1}}}}
            (d / "Secure Preferences" if browser == SUP else d / "Preferences").write_text(json.dumps(prefs))
        secret = "PROXY_PASSWORD=very-secret-value\n"
        env_file = self.h.home / ".config/unblockable-browser/proxy.env"
        env_file.write_text("PROXY_SERVER=proxy.example.net:8000\n" + secret)
        runner = FakeRunner(self.h.home, ss=SS)
        code, out = self.h.main("verify", "--mcp", runner=runner)
        self.assertEqual(code, 1, out)  # SUP's port listens on 0.0.0.0 in SS
        self.assertIn(f"FAIL  {SUP}: port — 21202 listens on 0.0.0.0, not loopback only", out)
        self.assertIn(f"PASS  {MKT}: port — 21201 listens on 127.0.0.1, [::1] only", out)
        self.assertIn(f"PASS  {unit('browser', MKT)} active", out)
        self.assertIn(f"PASS  {MKT}: extension doctor", out)
        self.assertIn(f"PASS  {MKT}: browser profile", out)
        self.assertIn(f"PASS  {SUP}: browser profile", out)
        self.assertIn(f"PASS  {MKT}: proxy env file (residential, allowlist)", out)
        self.assertIn("mode 0o600; contents not shown", out)
        self.assertIn(f"PASS  {MKT}: MCP over stdio — initialize and tools/list answered", out)
        self.assertNotIn("very-secret-value", out)
        self.assertNotIn("proxy.example.net", out)

        quiet = FakeRunner(self.h.home, ss="")
        code, out = self.h.main("verify", "--mcp", runner=quiet)
        self.assertEqual(code, 0, out)
        self.assertIn(f"INFO  {MKT}: port — nothing listens on 21201", out)
        self.assertIn(f"PASS  {MKT}: MCP over stdio — initialize and tools/list answered by local-browser-mcp: 24 tools", out)
        self.assertEqual(quiet.probes[0]["BROWSER_PORT"], "21201")

        env_file.chmod(0o644)
        down = FakeRunner(self.h.home, active="inactive")
        code, out = self.h.main("verify", runner=down)
        self.assertEqual(code, 1)
        self.assertIn(f"FAIL  {unit('xvfb', 100)} active — inactive", out)
        self.assertIn("FAIL  examplemarketing: proxy env file (residential, allowlist) — ", out)

    def test_verify_before_apply_fails_cleanly(self):
        code, out = self.h.main("verify")
        self.assertEqual(code, 1)
        self.assertIn(f"FAIL  unit file {unit('browser')}", out)
        self.assertIn("Preferences does not exist yet", out)

    def test_real_mcp_exchange_against_a_stub_server(self):
        server = self.h.home / "stub-mcp.py"
        server.write_text(textwrap.dedent("""\
            import json, sys
            for line in sys.stdin:
                msg = json.loads(line)
                if msg.get("method") == "initialize":
                    out = {"protocolVersion": "2024-11-05", "capabilities": {}, "serverInfo": {"name": "stub"}}
                elif msg.get("method") == "tools/list":
                    out = {"tools": [{"name": "a"}, {"name": "b"}]}
                else:
                    continue
                print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": out}), flush=True)
        """))
        result = bl.Runner().mcp_probe([sys.executable, "-I", str(server)], {"PATH": "/usr/bin:/bin"}, 20)
        self.assertEqual(result, {"server": "stub", "tools": 2})
        with self.assertRaises(bl.StepFailed):
            bl.Runner().mcp_probe([sys.executable, "-I", "-c", "import sys; sys.exit(3)"], {"PATH": "/usr/bin:/bin"}, 20)


if __name__ == "__main__":
    unittest.main()

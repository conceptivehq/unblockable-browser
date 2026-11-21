#!/usr/bin/env python3
"""Unblockable browser kit: one visible Chromium per Hermes agent profile on a Linux server.

Each browser is one agent profile with its own Chromium user-data dir, its own stamped copy of the Browser MCP extension
and its own loopback port. The agent's gateway starts `browser-mcp` as a stdio MCP server; that server listens
on 127.0.0.1:<port> for the extension inside the browser's Chromium, which draws on an Xvfb display (docs/unblockable-browser.md).

    python3 unblockable_browser.py plan   --config browsers.json
    python3 unblockable_browser.py apply  --config browsers.json [--execute] [--start] [--with-tests] [--rebuild]
    python3 unblockable_browser.py verify --config browsers.json [--mcp]
    python3 unblockable_browser.py remove --config browsers.json [--execute] [--purge-profiles]

apply and remove are dry runs unless --execute is given. The kit never runs a headless browser or opens a remote-
debugging port or pipe, never edits a Hermes config (it prints the block to paste), writes only under its own root and
the systemd user unit folder, refuses symlinks there, and copies files physically. Python 3.11 standard library only.
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import secrets
import selectors
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

KIT_DIR = Path(__file__).resolve().parent
TEMPLATES = KIT_DIR / "templates"
KIT_BIN = KIT_DIR / "bin"

SCHEMA_VERSION = 1
PROFILE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
SAFE_PATH_RE = re.compile(r"^/[A-Za-z0-9._/-]+$")
TIMEZONE_RE = re.compile(r"^(UTC|[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){1,2})$")
HOST_RE = re.compile(r"^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$")
PROXY_SERVER_RE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?:[0-9]{1,5}$")
REPO_RE = re.compile(r"^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/[A-Za-z0-9._/-]+$")
FORBIDDEN_FLAG_RE = re.compile(r"headless|remote-debugging", re.I)
PLACEHOLDER_RE = re.compile(r"@[A-Z_]+@")

FORWARD_PORT = 3128
VNC_BASE_PORT = 5900
XVFB = "/usr/bin/Xvfb"
X11VNC = "/usr/bin/x11vnc"
EXTENSION_CONNECT_TIMEOUT_MS = 90000
UNIT_MARKER = "# Written by the unblockable browser kit"
# Any marker line the kit has written, its own and those of earlier releases ("# Written by <name>'s unblockable
# browser kit", and "...'s browser lane kit" from before browsers had their name): verify and remove recognise units
# written with any of them, and apply rewrites them with UNIT_MARKER.
KIT_MARKER_RE = re.compile(r"^# Written by \S+ (?:unblockable browser|browser lane) kit", re.M)
# The kit's programs, copied into <root>/bin: (name, mode).
BIN_FILES = (("browser-mcp", 0o755), ("browser-server", 0o755), ("browser-broker.mjs", 0o644),
             ("browser-chromium", 0o755), ("proxy-forward.mjs", 0o644))
# browser-mcp's own suites the kit may run with --with-tests. Left out on purpose: browser-e2e (it launches a
# headless Chromium, which the fleet never runs) and hermes-wrapper (it tests the macOS zsh adapter the kit replaces).
SAFE_TESTS = (
    "contract-sync", "extension-handshake", "extension-redaction", "extension-frames", "protected-paste", "e2e",
    "mcp-contract", "profile-isolation", "local-only-audit", "deployment",
)

TOP_KEYS = {"schema_version", "display", "vnc", "chromium", "node", "root", "browser_mcp", "browsers", "proxies"}
BROWSER_KEYS = {"profile", "port", "client", "hermes_home", "proxy", "timezone"}
# Who drives a browser: a Hermes agent (its gateway and Codex threads), or the Strut host's browser steps. A Strut browser has
# no Hermes home and runs Browser MCP in window mode: every run opens its own window, and every call names its page.
CLIENTS = ("hermes", "strut")
PROXY_KEYS = {"env_file", "pac_hosts", "auth"}
BROWSER_MCP_KEYS = {"repo", "commit"}
DEFAULTS = {
    "display": 100,
    "vnc": False,
    "chromium": "/usr/lib/chromium/chromium",
    "node": "~/.local/bin/node",
    "root": "~/.local/share/unblockable-browser",
    "proxies": {},
}


class ConfigError(Exception):
    """The config file is wrong. Carries every problem found."""

    def __init__(self, problems: list[str]):
        super().__init__("; ".join(problems))
        self.problems = problems


class UnsafePath(Exception):
    """A path outside the kit's roots, or one that runs through a symlink."""


class StepFailed(Exception):
    pass


@dataclass(frozen=True)
class Proxy:
    name: str
    env_file: Path
    pac_hosts: tuple[str, ...]
    auth: str  # "allowlist" or "password"


@dataclass(frozen=True)
class Browser:
    profile: str
    port: int
    hermes_home: Path | None
    proxy: str | None
    timezone: str
    client: str = "hermes"


@dataclass(frozen=True)
class Config:
    home: Path
    display: int
    vnc: bool
    chromium: Path
    node: Path
    root: Path
    repo: str
    commit: str
    browsers: tuple[Browser, ...]
    proxies: dict[str, Proxy]

    @property
    def unit_dir(self) -> Path:
        return self.home / ".config" / "systemd" / "user"

    @property
    def vnc_port(self) -> int:
        return VNC_BASE_PORT + self.display

    def proxy_of(self, browser: Browser) -> Proxy | None:
        return self.proxies.get(browser.proxy) if browser.proxy else None

    @property
    def password_proxy(self) -> Proxy | None:
        return next((p for p in self.proxies.values() if p.auth == "password"), None)


# --- The config file ----------------------------------------------------------------------------------------------------


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _expand(value: object, home: Path, what: str, problems: list[str]) -> Path | None:
    if not isinstance(value, str) or not value:
        problems.append(f"{what} must be a path")
        return None
    text = str(home) + value[1:] if value == "~" or value.startswith("~/") else value
    if not SAFE_PATH_RE.match(text):
        problems.append(f"{what} must be an absolute path of letters, digits, '.', '_', '-' and '/' ({value!r})")
        return None
    parts = text.split("/")
    if ".." in parts or "." in parts or "" in parts[1:]:
        problems.append(f"{what} must be a plain path with no '.', '..' or '//' ({value!r})")
        return None
    return Path(text)


def _inside(path: Path, base: Path) -> bool:
    return path == base or base in path.parents


def parse_config(raw: object, home: Path) -> Config:
    """Validates a config file strictly: unknown keys, bad names, ports and paths are all refused, together."""
    problems: list[str] = []
    if not isinstance(raw, dict):
        raise ConfigError(["the config file must be a JSON object"])
    if "lanes" in raw:
        # The key before 0.8.0, read for one more release.
        if "browsers" in raw:
            problems.append("give browsers or the older lanes, not both")
        raw = {**{k: v for k, v in raw.items() if k != "lanes"}, "browsers": raw.get("browsers", raw["lanes"])}
    unknown = sorted(set(raw) - TOP_KEYS)
    if unknown:
        problems.append(f"unknown keys: {', '.join(unknown)}")
    for key in ("schema_version", "browser_mcp", "browsers"):
        if key not in raw:
            problems.append(f"{key} is required")
    if "schema_version" in raw and raw["schema_version"] != SCHEMA_VERSION:
        problems.append(f"schema_version must be {SCHEMA_VERSION}")
    get = lambda key: raw.get(key, DEFAULTS.get(key))  # noqa: E731

    display = get("display")
    if not _is_int(display) or not 1 <= display <= 999:
        problems.append("display must be an integer from 1 to 999")
        display = DEFAULTS["display"]
    vnc = get("vnc")
    if not isinstance(vnc, bool):
        problems.append("vnc must be true or false")
        vnc = False
    chromium = _expand(get("chromium"), home, "chromium", problems)
    node = _expand(get("node"), home, "node", problems)
    root = _expand(get("root"), home, "root", problems)
    if root is not None:
        if not _inside(root, home) or len(root.relative_to(home).parts) < 2:
            problems.append(f"root must be a folder at least two levels inside the home folder {home}")
        elif _inside(home / ".config" / "systemd", root):
            problems.append("root must not contain the systemd user unit folder")

    repo, commit = "", ""
    bmcp = raw.get("browser_mcp")
    if "browser_mcp" in raw:
        if not isinstance(bmcp, dict):
            problems.append("browser_mcp must be an object with repo and commit")
        else:
            unknown = sorted(set(bmcp) - BROWSER_MCP_KEYS)
            if unknown:
                problems.append(f"browser_mcp: unknown keys: {', '.join(unknown)}")
            repo = bmcp.get("repo", "")
            commit = bmcp.get("commit", "")
            if not isinstance(repo, str) or not REPO_RE.match(repo):
                problems.append("browser_mcp.repo must be an https URL with no user name, password, query or fragment")
                repo = ""
            if not isinstance(commit, str) or not COMMIT_RE.match(commit):
                problems.append("browser_mcp.commit must be a full 40-character lowercase commit sha (a short sha is refused)")
                commit = ""

    proxies: dict[str, Proxy] = {}
    raw_proxies = get("proxies")
    if not isinstance(raw_proxies, dict):
        problems.append("proxies must be an object")
        raw_proxies = {}
    for name, spec in raw_proxies.items():
        where = f"proxies.{name}"
        if not isinstance(name, str) or not PROFILE_RE.match(name) or name == "none":
            problems.append(f"{where}: a proxy name is lowercase letters, digits and '-', and not 'none'")
            continue
        if not isinstance(spec, dict):
            problems.append(f"{where} must be an object")
            continue
        unknown = sorted(set(spec) - PROXY_KEYS)
        if unknown:
            problems.append(f"{where}: unknown keys: {', '.join(unknown)}")
        env_file = _expand(spec.get("env_file"), home, f"{where}.env_file", problems)
        hosts = spec.get("pac_hosts")
        if not isinstance(hosts, list) or not hosts or not all(isinstance(h, str) and HOST_RE.match(h) for h in hosts):
            problems.append(f"{where}.pac_hosts must be a non-empty list of lowercase host names such as example.com")
            hosts = []
        elif len(set(hosts)) != len(hosts):
            problems.append(f"{where}.pac_hosts lists a host twice")
        auth = spec.get("auth")
        if auth not in ("allowlist", "password"):
            problems.append(f"{where}.auth must be allowlist or password")
        if env_file is not None and root is not None and _inside(env_file, root):
            problems.append(f"{where}.env_file must live outside the kit's root (a person writes it, the kit never does)")
        if env_file is not None and auth in ("allowlist", "password"):
            proxies[name] = Proxy(name, env_file, tuple(hosts), auth)
    if sum(1 for p in proxies.values() if p.auth == "password") > 1:
        problems.append("only one proxy may use password auth (it is served by the one loopback forwarder)")

    browsers: list[Browser] = []
    raw_browsers = raw.get("browsers")
    if "browsers" in raw and (not isinstance(raw_browsers, list) or not raw_browsers):
        problems.append("browsers must be a non-empty list")
        raw_browsers = []
    reserved = {FORWARD_PORT: "the proxy forwarder", VNC_BASE_PORT + (display if _is_int(display) else 0): "VNC"}
    for i, spec in enumerate(raw_browsers or []):
        where = f"browsers[{i}]"
        if not isinstance(spec, dict):
            problems.append(f"{where} must be an object")
            continue
        unknown = sorted(set(spec) - BROWSER_KEYS)
        if unknown:
            problems.append(f"{where}: unknown keys: {', '.join(unknown)}")
        profile = spec.get("profile")
        if not isinstance(profile, str) or not PROFILE_RE.match(profile):
            problems.append(f"{where}.profile must match ^[a-z0-9][a-z0-9-]{{0,40}}$")
            profile = None
        port = spec.get("port")
        if not _is_int(port) or not 1024 <= port <= 65535:
            problems.append(f"{where}.port must be an integer from 1024 to 65535")
            port = None
        elif port in reserved:
            problems.append(f"{where}.port {port} is {reserved[port]}'s")
        client = spec.get("client", "hermes")
        if client not in CLIENTS:
            problems.append(f"{where}.client must be hermes or strut ({client!r})")
            client = None
        hermes_home = None
        if client == "strut":
            if "hermes_home" in spec:
                problems.append(f"{where}.hermes_home is not used by a strut browser (Strut's host is its only client)")
        else:
            hermes_home = _expand(spec.get("hermes_home"), home, f"{where}.hermes_home", problems)
        if hermes_home is not None and root is not None and (_inside(hermes_home, root) or _inside(root, hermes_home)):
            problems.append(f"{where}.hermes_home and root must not contain each other")
        proxy = spec.get("proxy", "none")
        if not isinstance(proxy, str) or (proxy != "none" and proxy not in raw_proxies):
            problems.append(f"{where}.proxy must be none or a name under proxies ({proxy!r})")
        timezone = spec.get("timezone", "UTC")
        if not isinstance(timezone, str) or not TIMEZONE_RE.match(timezone):
            problems.append(f"{where}.timezone must be a tz database name such as America/Los_Angeles")
        if profile and port and client and (hermes_home is not None or client == "strut") and isinstance(proxy, str) and isinstance(timezone, str):
            browsers.append(Browser(profile, port, hermes_home, None if proxy == "none" else proxy, timezone, client))
    profiles = [browser.profile for browser in browsers]
    ports = [browser.port for browser in browsers]
    for name in sorted({p for p in profiles if profiles.count(p) > 1}):
        problems.append(f"the profile {name} has two browsers")
    for port in sorted({p for p in ports if ports.count(p) > 1}):
        problems.append(f"the port {port} is used by two browsers")
    if sum(1 for browser in browsers if browser.client == "strut") > 1:
        problems.append("only one browser may be the strut browser")

    if problems:
        raise ConfigError(problems)
    assert chromium and node and root
    return Config(home, display, vnc, chromium, node, root, repo, commit, tuple(browsers), proxies)


def load_config(path: Path, home: Path | None = None) -> Config:
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as err:
        raise ConfigError([f"cannot read the config file {path}: {err}"]) from err
    return parse_config(raw, Path(home) if home else Path.home())


# --- Effects ----------------------------------------------------------------------------------------------------------


class Runner:
    """Every command and file effect the kit has. Tests replace `run` and `mcp_probe`; the file methods work on
    whatever folder the config names (a temporary home in tests)."""

    def run(self, argv: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None,
            check: bool = True, timeout: float | None = None) -> subprocess.CompletedProcess:
        proc = subprocess.run([str(a) for a in argv], cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
        if check and proc.returncode != 0:
            tail = (proc.stderr or proc.stdout or "").strip()[-1500:]
            raise StepFailed(f"{Path(str(argv[0])).name} {' '.join(str(a) for a in argv[1:3])} exited {proc.returncode}: {tail}")
        return proc

    # Files. Every path here was checked by Kit.guard first.
    def exists(self, path: Path) -> bool:
        return os.path.lexists(path)

    def is_dir(self, path: Path) -> bool:
        return path.is_dir() and not path.is_symlink()

    def lstat(self, path: Path) -> os.stat_result:
        return os.lstat(path)

    def read_text(self, path: Path) -> str:
        if path.is_symlink():
            raise UnsafePath(f"{path} is a symlink")
        return path.read_text(encoding="utf-8")

    def makedirs(self, path: Path, mode: int = 0o700) -> None:
        path.mkdir(mode=mode, parents=True, exist_ok=True)
        if path.is_symlink() or not path.is_dir():
            raise UnsafePath(f"{path} is not a plain folder")

    def write_text(self, path: Path, text: str, mode: int) -> None:
        if path.is_symlink():
            raise UnsafePath(f"{path} is a symlink")
        tmp = path.with_name(f".{path.name}.tmp-{secrets.token_hex(4)}")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(text)
            os.chmod(tmp, mode)
            os.replace(tmp, path)
        except BaseException:
            if os.path.lexists(tmp):
                os.unlink(tmp)
            raise

    def copy_file(self, src: Path, dst: Path, mode: int) -> None:
        if src.is_symlink() or not src.is_file():
            raise UnsafePath(f"{src} is not a regular file")
        self.write_text(dst, src.read_text(encoding="utf-8"), mode)

    def copy_tree(self, src: Path, dst: Path) -> None:
        """A physical copy of regular files and folders; a symlink or anything else anywhere stops it."""
        if src.is_symlink() or not src.is_dir():
            raise UnsafePath(f"{src} is not a plain folder")
        os.mkdir(dst, 0o700)
        for entry in sorted(os.scandir(src), key=lambda e: e.name):
            target = dst / entry.name
            if entry.is_symlink():
                raise UnsafePath(f"{entry.path} is a symlink")
            if entry.is_dir(follow_symlinks=False):
                self.copy_tree(Path(entry.path), target)
            elif entry.is_file(follow_symlinks=False):
                shutil.copyfile(entry.path, target, follow_symlinks=False)
                os.chmod(target, 0o644)
            else:
                raise UnsafePath(f"{entry.path} is not a regular file")
        os.chmod(dst, 0o755)

    def rename(self, src: Path, dst: Path) -> None:
        os.rename(src, dst)

    def remove_tree(self, path: Path) -> None:
        if path.is_symlink():
            raise UnsafePath(f"{path} is a symlink")
        shutil.rmtree(path)

    def remove_file(self, path: Path) -> None:
        os.unlink(path)

    def mcp_probe(self, argv: list[str], env: dict[str, str], timeout: float) -> dict:
        """Starts the adapter, sends MCP initialize, initialized and tools/list over stdio, and returns
        {"server": name, "tools": count}. Stops the adapter afterwards."""
        with tempfile.TemporaryFile() as errfile:
            proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errfile, env=env)
            try:
                return _mcp_exchange(proc, timeout)
            except Exception as err:
                proc.kill()
                proc.wait(5)
                errfile.seek(0)
                tail = errfile.read().decode("utf-8", "replace").strip()[-800:]
                raise StepFailed(f"{err}{' — ' + tail if tail else ''}") from err
            finally:
                for pipe in (proc.stdin, proc.stdout):
                    try:
                        pipe.close()  # type: ignore[union-attr]
                    except OSError:
                        pass
                if proc.poll() is None:
                    try:
                        proc.wait(10)
                    except subprocess.TimeoutExpired:
                        proc.terminate()
                        proc.wait(5)


def _mcp_exchange(proc: subprocess.Popen, timeout: float) -> dict:
    deadline = time.monotonic() + timeout
    with selectors.DefaultSelector() as sel:
        sel.register(proc.stdout, selectors.EVENT_READ)  # type: ignore[arg-type]
        return _mcp_talk(proc, sel, deadline)


def _mcp_talk(proc: subprocess.Popen, sel: selectors.BaseSelector, deadline: float) -> dict:
    buf = b""

    def send(msg: dict) -> None:
        proc.stdin.write((json.dumps(msg) + "\n").encode())  # type: ignore[union-attr]
        proc.stdin.flush()  # type: ignore[union-attr]

    def reply(want: int) -> dict:
        nonlocal buf
        while True:
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(msg, dict) and msg.get("id") == want:
                    if "error" in msg:
                        raise StepFailed(f"MCP error: {msg['error'].get('message', msg['error'])}")
                    return msg.get("result") or {}
            left = deadline - time.monotonic()
            if left <= 0:
                raise StepFailed("no MCP answer in time")
            if not sel.select(left):
                continue
            chunk = os.read(proc.stdout.fileno(), 65536)  # type: ignore[union-attr]
            if not chunk:
                raise StepFailed(f"the MCP server exited ({proc.wait(5)})")
            buf += chunk

    send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "browser-verify", "version": "1"}}})
    init = reply(1)
    send({"jsonrpc": "2.0", "method": "notifications/initialized"})
    send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
    tools = reply(2).get("tools") or []
    return {"server": (init.get("serverInfo") or {}).get("name", "?"), "tools": len(tools)}


# --- Rendering --------------------------------------------------------------------------------------------------------


def render_template(name: str, values: dict[str, str]) -> str:
    text = (TEMPLATES / name).read_text(encoding="utf-8")
    for key, value in values.items():
        text = text.replace(f"@{key}@", value)
    left = PLACEHOLDER_RE.findall(text)
    if left:
        raise StepFailed(f"{name}: placeholders left unfilled: {', '.join(sorted(set(left)))}")
    if re.search(r"--headless|--remote-debugging", text):
        raise StepFailed(f"{name}: a unit may never carry a headless or remote-debugging flag")
    return text


def render_pac(hosts: tuple[str, ...], target: str) -> str:
    """target is 'PROXY host:port'. Listed hosts and their subdomains go through it; everything else is DIRECT.
    No DIRECT fallback for a listed host, so a stopped proxy fails closed instead of leaking the server's address."""
    if not re.match(r"^PROXY [A-Za-z0-9.-]+:[0-9]{1,5}$", target):
        raise StepFailed("a PAC target is PROXY host:port")
    return (
        f"{UNIT_MARKER.replace('#', '//')}. Listed hosts and their subdomains use the proxy; the rest go direct.\n"
        "function FindProxyForURL(url, host) {\n"
        "  host = host.toLowerCase();\n"
        f"  var hosts = {json.dumps(list(hosts))};\n"
        "  for (var i = 0; i < hosts.length; i++) {\n"
        "    if (host === hosts[i] || dnsDomainIs(host, \".\" + hosts[i])) return " + json.dumps(target) + ";\n"
        "  }\n"
        "  return \"DIRECT\";\n"
        "}\n"
    )


def parse_env_value(text: str, key: str) -> str | None:
    """One key of a systemd-style env file. Only that key is read; nothing else is kept or printed."""
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        if name.strip() == key:
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                value = value[1:-1]
            return value
    return None


def parse_ss(text: str) -> dict[int, list[str]]:
    """`ss -ltnH` → {port: [local host, …]}."""
    out: dict[int, list[str]] = {}
    for line in text.splitlines():
        cols = line.split()
        if len(cols) < 4:
            continue
        local = cols[3]
        if ":" not in local:
            continue
        host, port = local.rsplit(":", 1)
        if not port.isdigit():
            continue
        out.setdefault(int(port), []).append(host)
    return out


def is_loopback(host: str) -> bool:
    host = host.strip("[]").split("%", 1)[0]
    if host in ("*", ""):
        return False
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return False
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return addr.is_loopback


def extension_in_prefs(prefs_texts: list[str], ext_dir: Path) -> tuple[bool, str]:
    """Looks through Chromium's Preferences (and Secure Preferences) for an enabled extension loaded from ext_dir."""
    want = os.path.realpath(ext_dir)
    seen_disabled = None
    for text in prefs_texts:
        try:
            prefs = json.loads(text)
        except json.JSONDecodeError:
            continue
        settings = ((prefs.get("extensions") or {}).get("settings") or {}) if isinstance(prefs, dict) else {}
        for ext_id, entry in settings.items():
            if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
                continue
            if os.path.realpath(entry["path"]) != want and entry["path"] != str(ext_dir):
                continue
            reasons = entry.get("disable_reasons")
            enabled = entry.get("state", 1) == 1 and not reasons
            if enabled:
                return True, f"extension {ext_id} is loaded from {ext_dir} and enabled"
            seen_disabled = f"extension {ext_id} is loaded from {ext_dir} but disabled (state {entry.get('state')}, reasons {reasons})"
    return False, seen_disabled or f"no extension in the profile's Preferences is loaded from {ext_dir}"


def strut_block(cfg: Config, browser: Browser) -> str:
    """The settings Strut's host reads (Strut's browser, `Browser`): its browser steps then drive this browser."""
    return (
        f"# {browser.profile}: Strut's browser. Add to the Strut host's browser env file (BROWSER_* settings), then restart\n"
        "# Strut once /runs/active is []. The kit never edits it. Leave BROWSER_WS_URL and BROWSER_CDP_URL unset.\n"
        f"BROWSER_ROOT={cfg.root}\n"
        f"BROWSER_PROFILE={browser.profile}\n"
        f"BROWSER_PORT={browser.port}\n"
        f"BROWSER_NODE={cfg.node}\n"
    )


def client_block(cfg: Config, browser: Browser) -> str:
    return strut_block(cfg, browser) if browser.client == "strut" else hermes_block(cfg, browser)


def hermes_block(cfg: Config, browser: Browser) -> str:
    root = cfg.root
    return (
        f"# {browser.profile}: add to {browser.hermes_home}/config.yaml (the kit never edits it), then restart that\n"
        f"# profile's gateway the drain-aware way: hermes -p {browser.profile} gateway restart\n"
        "mcp_servers:\n"
        "  browser:\n"
        f"    command: {root}/bin/browser-mcp\n"
        "    args: []\n"
        "    env:\n"
        f"      BROWSER_ROOT: {root}\n"
        f"      BROWSER_PROFILE: {browser.profile}\n"
        f"      BROWSER_PORT: \"{browser.port}\"\n"
        f"      BROWSER_NODE: {cfg.node}\n"
        "    connect_timeout: 150\n"
    )


# --- The kit ----------------------------------------------------------------------------------------------------------


@dataclass
class Action:
    text: str
    fn: Callable[[], None] | None = None


@dataclass
class Check:
    ok: bool | None  # None: information, not a failure
    name: str
    detail: str

    def line(self) -> str:
        word = {True: "PASS", False: "FAIL", None: "INFO"}[self.ok]
        return f"{word}  {self.name} — {self.detail}"


@dataclass
class Kit:
    cfg: Config
    runner: Runner = field(default_factory=Runner)
    out: Callable[[str], None] = print

    # Paths
    @property
    def root(self) -> Path:
        return self.cfg.root

    @property
    def checkout(self) -> Path:
        return self.root / "browser-mcp" / self.cfg.commit

    @property
    def package_out(self) -> Path:
        return self.root / "package-out"

    @property
    def built_stamp(self) -> Path:
        return self.root / "state" / f"built-{self.cfg.commit}"

    def ext_dir(self, browser: Browser) -> Path:
        return self.root / "extensions" / browser.profile

    def data_dir(self, browser: Browser) -> Path:
        return self.root / "profiles" / browser.profile

    def env_path(self, browser: Browser) -> Path:
        return self.root / "browsers" / f"{browser.profile}.env"

    def pac_path(self, browser: Browser) -> Path:
        return self.root / "pac" / f"{browser.profile}.pac"

    def guard(self, path: Path) -> Path:
        """Only paths under the kit's root or the systemd user unit folder, through no symlink, may be written."""
        p = Path(os.path.normpath(path))
        if not p.is_absolute() or str(p) != str(path).rstrip("/"):
            raise UnsafePath(f"{path} is not a plain absolute path")
        for base in (self.root, self.cfg.unit_dir):
            if _inside(p, base):
                cur = base
                if cur.is_symlink():
                    raise UnsafePath(f"{cur} is a symlink")
                for part in p.relative_to(base).parts:
                    cur = cur / part
                    if cur.is_symlink():
                        raise UnsafePath(f"{cur} is a symlink")
                return p
        raise UnsafePath(f"{p} is outside the kit's roots ({self.root}, {self.cfg.unit_dir})")

    def env(self) -> dict[str, str]:
        """A small, fixed environment for the commands the kit runs: no inherited secrets."""
        path = f"{self.cfg.node.parent}:/usr/local/bin:/usr/bin:/bin"
        env = {"PATH": path, "HOME": str(self.cfg.home), "LANG": "C.UTF-8", "GIT_TERMINAL_PROMPT": "0"}
        if os.environ.get("XDG_RUNTIME_DIR"):
            env["XDG_RUNTIME_DIR"] = os.environ["XDG_RUNTIME_DIR"]
        return env

    def npm(self) -> str:
        beside = self.cfg.node.parent / "npm"
        found = str(beside) if os.access(beside, os.X_OK) else shutil.which("npm", path=self.env()["PATH"])
        if not found:
            raise StepFailed(f"npm was not found beside {self.cfg.node} or on PATH")
        return found

    def systemctl(self, *args: str, check: bool = True) -> subprocess.CompletedProcess:
        return self.runner.run(["systemctl", "--user", *args], env=self.env(), check=check)

    # Browser readiness
    def browser_problem(self, browser: Browser) -> str | None:
        """Why a proxied browser cannot be set up yet, or None. Reads only PROXY_SERVER, never prints the file."""
        proxy = self.cfg.proxy_of(browser)
        if proxy is None:
            return None
        f = proxy.env_file
        if not self.runner.exists(f):
            return f"the proxy env file {f} does not exist (a person writes it, mode 600)"
        st = self.runner.lstat(f)
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
            return f"the proxy env file {f} is not a regular file"
        if st.st_mode & 0o077:
            return f"the proxy env file {f} is readable by others (mode {oct(st.st_mode & 0o777)}); chmod 600 it"
        if proxy.auth == "allowlist":
            server = parse_env_value(self.runner.read_text(f), "PROXY_SERVER")
            if not server:
                return f"PROXY_SERVER is missing from {f} (allowlist auth puts the server address in the PAC file)"
            if not PROXY_SERVER_RE.match(server) or not 1 <= int(server.rsplit(":", 1)[1]) <= 65535:
                return f"PROXY_SERVER in {f} is not host:port"
        return None

    def pac_target(self, browser: Browser) -> str:
        proxy = self.cfg.proxy_of(browser)
        assert proxy is not None
        if proxy.auth == "password":
            return f"PROXY 127.0.0.1:{FORWARD_PORT}"
        server = parse_env_value(self.runner.read_text(proxy.env_file), "PROXY_SERVER")
        return f"PROXY {server}"

    # Rendering
    def browser_env(self, browser: Browser) -> str:
        pac = str(self.pac_path(browser)) if browser.proxy else ""
        return (
            f"{UNIT_MARKER} for the browser {browser.profile}. No secrets here.\n"
            f"BROWSER_ROOT={self.root}\n"
            f"BROWSER_PROFILE={browser.profile}\n"
            f"BROWSER_PORT={browser.port}\n"
            f"BROWSER_CHROMIUM={self.cfg.chromium}\n"
            f"BROWSER_PAC={pac}\n"
            f"DISPLAY=:{self.cfg.display}\n"
            f"TZ={browser.timezone}\n"
            + ("BROWSER_MCP_PAGE_ISOLATION=window\n" if browser.client == "strut" else "")
        )

    def units(self) -> dict[str, str]:
        values = {"ROOT": str(self.root), "DISPLAY": str(self.cfg.display), "XVFB": XVFB}
        units = {
            "fleet-xvfb@.service": render_template("fleet-xvfb@.service", values),
            "fleet-browser@.service": render_template("fleet-browser@.service", values),
            "fleet-browser-mcp@.service": render_template("fleet-browser-mcp@.service", {**values, "NODE": str(self.cfg.node)}),
        }
        if self.cfg.vnc:
            units["fleet-vnc@.service"] = render_template(
                "fleet-vnc@.service", {**values, "X11VNC": X11VNC, "VNC_PORT": str(self.cfg.vnc_port)})
        proxy = self.cfg.password_proxy
        if proxy is not None:
            units["fleet-proxy.service"] = render_template("fleet-proxy.service", {
                **values, "NODE": str(self.cfg.node), "PROXY_ENV_FILE": str(proxy.env_file), "FORWARD_PORT": str(FORWARD_PORT)})
        return units

    def unit_names(self, browsers: list[Browser] | tuple[Browser, ...]) -> list[str]:
        """The running units, in start order."""
        names = [f"fleet-xvfb@{self.cfg.display}.service"]
        if self.cfg.password_proxy is not None:
            names.append("fleet-proxy.service")
        if self.cfg.vnc:
            names.append(f"fleet-vnc@{self.cfg.display}.service")
        for browser in browsers:
            names += [f"fleet-browser@{browser.profile}.service", f"fleet-browser-mcp@{browser.profile}.service"]
        return names

    # apply
    def apply_actions(self, *, start: bool = False, with_tests: bool = False, rebuild: bool = False) -> tuple[list[Action], list[str]]:
        """What apply does, in order, and the browsers it refuses."""
        cfg, acts, refused = self.cfg, [], []
        ready: list[Browser] = []
        for browser in cfg.browsers:
            problem = self.browser_problem(browser)
            if problem:
                refused.append(f"{browser.profile}: {problem}")
            else:
                ready.append(browser)

        dirs = [self.root, *(self.root / d for d in ("bin", "browsers", "extensions", "profiles", "pac", "state", "browser-mcp", "run")),
                cfg.unit_dir]
        def make_dirs() -> None:
            for d in dirs:
                self.runner.makedirs(self.guard(d), 0o700)
        acts.append(Action(f"create folders (mode 700): {', '.join(str(d) for d in dirs)}", make_dirs))

        if self.runner.is_dir(self.checkout):
            acts.append(Action(f"check that {self.checkout} is at {cfg.commit}", self._verify_checkout))
        else:
            acts.append(Action(f"clone {cfg.repo} into {self.checkout} and check out {cfg.commit} (HEAD must equal it)",
                               self._clone))
        if rebuild or not self.runner.exists(self.built_stamp):
            acts.append(Action(f"build Browser MCP in {self.checkout}: npm ci --ignore-scripts, npm run build", self._build))
        else:
            acts.append(Action(f"Browser MCP at {cfg.commit[:12]} is already built ({self.built_stamp}); --rebuild builds again"))
        if with_tests:
            acts.append(Action(f"run Browser MCP's tests that start no browser: {', '.join(SAFE_TESTS)} "
                               "(never browser-e2e, which is headless)", self._tests))
        if ready:
            spec = " ".join(f"--profile {browser.profile}:{browser.port}" for browser in ready)
            acts.append(Action(f"package the stamped extensions in one call: npm run package -- --output-dir {self.package_out} {spec}",
                               lambda: self._package(ready)))
        for browser in ready:
            acts.append(Action(f"{browser.profile}: copy {self.package_out}/profiles/{browser.profile} physically to {self.ext_dir(browser)} "
                               "(new copy beside it, then renamed into place)", lambda browser=browser: self._install_extension(browser)))
            acts.append(Action(f"{browser.profile}: run Browser MCP's doctor on {self.ext_dir(browser)} (locked to {browser.profile}:{browser.port})",
                               lambda browser=browser: self._doctor(browser) and None))
        acts.append(Action(f"write {self.root}/current (the commit, as plain text)",
                           lambda: self.runner.write_text(self.guard(self.root / "current"), cfg.commit + "\n", 0o644)))
        for name, mode in BIN_FILES:
            acts.append(Action(f"copy the kit's {name} to {self.root}/bin/{name}",
                               lambda name=name, mode=mode: self.runner.copy_file(KIT_BIN / name, self.guard(self.root / "bin" / name), mode)))
        for browser in ready:
            acts.append(Action(f"{browser.profile}: write {self.env_path(browser)} (DISPLAY :{cfg.display}, TZ {browser.timezone}"
                               f"{', PAC' if browser.proxy else ''})",
                               lambda browser=browser: self.runner.write_text(self.guard(self.env_path(browser)), self.browser_env(browser), 0o600)))
            if browser.proxy:
                proxy = cfg.proxy_of(browser)
                assert proxy
                acts.append(Action(f"{browser.profile}: write {self.pac_path(browser)}: {', '.join(proxy.pac_hosts)} and their subdomains "
                                   f"through the {proxy.name} proxy ({proxy.auth} auth), everything else direct",
                                   lambda browser=browser: self._write_pac(browser)))
        for name in self.units():
            acts.append(Action(f"write the unit {cfg.unit_dir / name}",
                               lambda name=name: self.runner.write_text(self.guard(cfg.unit_dir / name), self.units()[name], 0o644)))
        acts.append(Action("systemctl --user daemon-reload", lambda: self.systemctl("daemon-reload") and None))
        if start:
            for unit in self.unit_names(ready):
                acts.append(Action(f"systemctl --user enable --now {unit}", lambda unit=unit: self.systemctl("enable", "--now", unit) and None))
        else:
            acts.append(Action("start nothing (--start enables and starts the units; a running browser keeps its old "
                               "extension until a person restarts its unit)"))
        return acts, refused

    def _verify_checkout(self, path: Path | None = None) -> None:
        path = path or self.checkout
        head = self.runner.run(["git", "-C", str(path), "rev-parse", "HEAD"], env=self.env()).stdout.strip()
        if head != self.cfg.commit:
            raise StepFailed(f"{path} is at {head or 'nothing'}, not the configured commit {self.cfg.commit}")

    def _clone(self) -> None:
        tmp = self.guard(self.root / "browser-mcp" / f".clone-{secrets.token_hex(4)}")
        env, git = self.env(), "git"
        try:
            self.runner.run([git, "clone", "--quiet", "--no-checkout", self.cfg.repo, str(tmp)], env=env, timeout=600)
            if self.runner.run([git, "-C", str(tmp), "checkout", "--quiet", "--detach", self.cfg.commit], env=env, check=False).returncode:
                self.runner.run([git, "-C", str(tmp), "fetch", "--quiet", "origin", self.cfg.commit], env=env, timeout=600)
                self.runner.run([git, "-C", str(tmp), "checkout", "--quiet", "--detach", self.cfg.commit], env=env)
            self._verify_checkout(tmp)
            self.runner.rename(tmp, self.guard(self.checkout))
        finally:
            if self.runner.exists(tmp):
                self.runner.remove_tree(tmp)

    def _build(self) -> None:
        self._verify_checkout()
        npm, env = self.npm(), self.env()
        self.runner.run([npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=self.checkout, env=env, timeout=1200)
        self.runner.run([npm, "run", "build"], cwd=self.checkout, env=env, timeout=1200)
        self.runner.write_text(self.guard(self.built_stamp), self.cfg.commit + "\n", 0o644)

    def _tests(self) -> None:
        server = self.checkout / "server"
        for name in SAFE_TESTS:
            self.runner.run([str(self.cfg.node), f"test/{name}.mjs"], cwd=server, env=self.env(), timeout=900)

    def _package(self, browsers: list[Browser]) -> None:
        self._verify_checkout()
        out = self.guard(self.package_out)
        argv = [self.npm(), "run", "package", "--", "--output-dir", str(out)]
        for browser in browsers:
            argv += ["--profile", f"{browser.profile}:{browser.port}"]
        self.runner.run(argv, cwd=self.checkout, env=self.env(), timeout=600)

    def _install_extension(self, browser: Browser) -> None:
        src = self.package_out / "profiles" / browser.profile
        dst = self.guard(self.ext_dir(browser))
        tmp = self.guard(dst.with_name(f".new-{browser.profile}-{secrets.token_hex(4)}"))
        old = self.guard(dst.with_name(f".old-{browser.profile}-{secrets.token_hex(4)}"))
        try:
            self.runner.copy_tree(self.guard(src), tmp)
            if self.runner.exists(dst):
                self.runner.rename(dst, old)
            self.runner.rename(tmp, dst)
        finally:
            for leftover in (tmp, old):
                if self.runner.exists(leftover):
                    self.runner.remove_tree(leftover)

    def _doctor(self, browser: Browser) -> str:
        proc = self.runner.run(
            [str(self.cfg.node), "scripts/doctor.mjs", "--extension-dir", str(self.ext_dir(browser)),
             "--artifacts", str(self.package_out / "artifacts.json")],
            cwd=self.checkout, env=self.env(), check=False, timeout=120)
        text = (proc.stdout or "") + (proc.stderr or "")
        locked = f"locked to {browser.profile}:{browser.port}" in text
        if proc.returncode != 0 or not locked:
            failed = [line for line in text.splitlines() if line.startswith("FAIL")] or [text.strip()[-400:]]
            if not locked and proc.returncode == 0:
                failed.append(f"the copy is not locked to {browser.profile}:{browser.port}")
            raise StepFailed("doctor: " + "; ".join(failed))
        return f"the copy matches the packaged artifact, locked to {browser.profile}:{browser.port}"

    def _write_pac(self, browser: Browser) -> None:
        proxy = self.cfg.proxy_of(browser)
        assert proxy
        self.runner.write_text(self.guard(self.pac_path(browser)), render_pac(proxy.pac_hosts, self.pac_target(browser)), 0o644)

    # verify
    def verify(self, *, mcp: bool = False) -> list[Check]:
        cfg, checks = self.cfg, []

        def check(name: str, fn: Callable[[], str | tuple[bool | None, str]]) -> None:
            try:
                result = fn()
                ok, detail = result if isinstance(result, tuple) else (True, result)
            except (StepFailed, UnsafePath, OSError, subprocess.SubprocessError) as err:
                ok, detail = False, str(err)
            checks.append(Check(ok, name, detail))

        def unit_file(name: str) -> tuple[bool, str]:
            path = cfg.unit_dir / name
            if not self.runner.exists(path):
                return False, f"{path} is missing (apply --execute writes it)"
            return bool(KIT_MARKER_RE.search(self.runner.read_text(path))), str(path)

        for name in self.units():
            check(f"unit file {name}", lambda name=name: unit_file(name))
        for unit in self.unit_names(cfg.browsers):
            def active(unit: str = unit) -> tuple[bool | None, str]:
                state = self.systemctl("is-active", unit, check=False).stdout.strip() or "unknown"
                if state != "active" and unit.startswith("fleet-browser-mcp@") and state in ("inactive", "unknown"):
                    return None, f"{state}; browser-mcp starts it when the agent's first MCP client connects"
                return state == "active", state
            check(f"{unit} active", active)

        def current() -> tuple[bool, str]:
            path = self.root / "current"
            text = self.runner.read_text(path).strip() if self.runner.exists(path) else ""
            return text == cfg.commit, f"{path} holds {text or 'nothing'}"
        check("current commit", current)
        check("Browser MCP checkout", lambda: (self._verify_checkout(), f"{self.checkout} is at {cfg.commit}")[1])

        ss_text = ""
        try:
            ss_text = self.runner.run(["ss", "-ltnH"], env=self.env()).stdout
        except (StepFailed, OSError) as err:
            checks.append(Check(False, "ss -ltnH", str(err)))
        listening = parse_ss(ss_text)

        for browser in cfg.browsers:
            p = browser.profile
            check(f"{p}: extension doctor", lambda browser=browser: self._doctor(browser))

            def port(browser: Browser = browser) -> tuple[bool | None, str]:
                hosts = listening.get(browser.port, [])
                if not hosts:
                    return None, (f"nothing listens on {browser.port} now; the browser's broker starts the MCP server "
                                  "when the agent's first MCP client connects")
                bad = [h for h in hosts if not is_loopback(h)]
                if bad:
                    return False, f"{browser.port} listens on {', '.join(sorted(set(hosts)))}, not loopback only"
                return True, f"{browser.port} listens on {', '.join(sorted(set(hosts)))} only"
            check(f"{p}: port", port)

            def prefs(browser: Browser = browser) -> tuple[bool, str]:
                default = self.data_dir(browser) / "Default"
                texts = [self.runner.read_text(default / n) for n in ("Preferences", "Secure Preferences")
                         if self.runner.exists(default / n)]
                if not texts:
                    return False, f"{default}/Preferences does not exist yet (has the browser's Chromium started?)"
                return extension_in_prefs(texts, self.ext_dir(browser))
            check(f"{p}: browser profile", prefs)

            proxy = cfg.proxy_of(browser)
            if proxy is not None:
                def env_file(proxy: Proxy = proxy) -> tuple[bool, str]:
                    f = proxy.env_file
                    if not self.runner.exists(f):
                        return False, f"{f} does not exist"
                    st = self.runner.lstat(f)
                    mode = st.st_mode & 0o777
                    ok = stat.S_ISREG(st.st_mode) and mode == 0o600
                    return ok, f"{f} exists, mode {oct(mode)}{'' if ok else ' (must be a regular file, mode 0o600)'}; contents not shown"
                check(f"{p}: proxy env file ({proxy.name}, {proxy.auth})", env_file)

            if mcp:
                def probe(browser: Browser = browser) -> tuple[bool | None, str]:
                    # Through the browser's broker, so it shares the server a gateway may already hold.
                    env = {**self.env(), "BROWSER_ROOT": str(self.root), "BROWSER_PROFILE": browser.profile,
                           "BROWSER_PORT": str(browser.port), "BROWSER_NODE": str(cfg.node)}
                    result = self.runner.mcp_probe([str(self.root / "bin" / "browser-mcp")], env,
                                                   EXTENSION_CONNECT_TIMEOUT_MS / 1000 + 60)
                    count = int(result.get("tools", 0))
                    return count > 0, f"initialize and tools/list answered by {result.get('server', '?')}: {count} tools"
                check(f"{p}: MCP over stdio", probe)
        return checks

    # remove
    def remove_actions(self, *, purge_profiles: bool = False) -> list[Action]:
        cfg, acts = self.cfg, []
        for unit in reversed(self.unit_names(cfg.browsers)):
            acts.append(Action(f"systemctl --user disable --now {unit}",
                               lambda unit=unit: self.systemctl("disable", "--now", unit, check=False) and None))
        for name in ("fleet-browser-mcp@.service", "fleet-browser@.service", "fleet-vnc@.service", "fleet-proxy.service",
                     "fleet-xvfb@.service"):
            path = cfg.unit_dir / name
            acts.append(Action(f"delete {path} if the kit wrote it", lambda path=path: self._remove_unit(path)))
        acts.append(Action("systemctl --user daemon-reload", lambda: self.systemctl("daemon-reload", check=False) and None))
        names = ["bin", "browsers", "extensions", "pac", "state", "package-out", "browser-mcp", "run", "current"]
        if purge_profiles:
            names.append("profiles")
        for name in names:
            path = self.root / name
            acts.append(Action(f"delete {path}", lambda path=path: self._remove_path(path)))
        if not purge_profiles:
            acts.append(Action(f"keep {self.root / 'profiles'} (the browsers' sign-ins; --purge-profiles deletes it)"))
        acts.append(Action(f"delete {self.root} if it is then empty", self._remove_root_if_empty))
        return acts

    def _remove_unit(self, path: Path) -> None:
        path = self.guard(path)
        if self.runner.exists(path) and KIT_MARKER_RE.search(self.runner.read_text(path)):
            self.runner.remove_file(path)

    def _remove_path(self, path: Path) -> None:
        path = self.guard(path)
        if path == self.root:
            raise UnsafePath("the root itself is removed only when empty")
        if not self.runner.exists(path):
            return
        if self.runner.is_dir(path):
            self.runner.remove_tree(path)
        else:
            self.runner.remove_file(path)

    def _remove_root_if_empty(self) -> None:
        root = self.guard(self.root)
        if self.runner.is_dir(root) and not any(root.iterdir()):
            root.rmdir()


# --- CLI --------------------------------------------------------------------------------------------------------------


def run_actions(kit: Kit, acts: list[Action], execute: bool) -> bool:
    kit.out("Doing:" if execute else "Plan (dry run; add --execute to do it):")
    for act in acts:
        kit.out(f"  - {act.text}")
        if execute and act.fn is not None:
            try:
                act.fn()
            except (StepFailed, UnsafePath, OSError, subprocess.SubprocessError) as err:
                kit.out(f"    FAILED: {err}")
                return False
    return True


def main(argv: list[str] | None = None, runner: Runner | None = None, home: Path | None = None,
         out: Callable[[str], None] = print) -> int:
    parser = argparse.ArgumentParser(prog="unblockable_browser.py", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name in ("plan", "apply", "verify", "remove"):
        p = sub.add_parser(name)
        p.add_argument("--config", required=True, type=Path, help="the config file (JSON)")
        if name in ("apply", "remove"):
            p.add_argument("--execute", action="store_true", help="act; without it this is a dry run")
        if name in ("plan", "apply"):
            p.add_argument("--start", action="store_true", help="enable and start the units after writing them")
            p.add_argument("--with-tests", action="store_true", help="run Browser MCP's tests that start no browser")
            p.add_argument("--rebuild", action="store_true", help="run npm ci and the build even when built before")
        if name == "verify":
            p.add_argument("--mcp", action="store_true", help="also start each browser's adapter and list its MCP tools")
        if name == "remove":
            p.add_argument("--purge-profiles", action="store_true", help="also delete the browsers' user-data dirs")
    args = parser.parse_args(argv)

    try:
        cfg = load_config(args.config, home)
    except ConfigError as err:
        out("The config file is refused:")
        for problem in err.problems:
            out(f"  - {problem}")
        return 2
    kit = Kit(cfg, runner or Runner(), out)

    if args.cmd in ("plan", "apply"):
        try:
            acts, refused = kit.apply_actions(start=args.start, with_tests=args.with_tests, rebuild=args.rebuild)
        except (StepFailed, UnsafePath, OSError) as err:
            out(f"Cannot plan: {err}")
            return 1
        ok = run_actions(kit, acts, args.cmd == "apply" and args.execute)
        for line in refused:
            out(f"REFUSED browser {line}")
        ready = [browser for browser in cfg.browsers if not any(r.startswith(f"{browser.profile}:") for r in refused)]
        if ok and ready:
            out("\nClient settings (paste each where it says; the kit never edits a Hermes or Strut config):\n")
            for browser in ready:
                out(client_block(cfg, browser))
        return 0 if ok and not refused else 1

    if args.cmd == "verify":
        checks = kit.verify(mcp=args.mcp)
        for c in checks:
            out(c.line())
        failed = sum(1 for c in checks if c.ok is False)
        out(f"\n{len(checks)} checks, {failed} failed")
        return 1 if failed else 0

    ok = run_actions(kit, kit.remove_actions(purge_profiles=args.purge_profiles), args.execute)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

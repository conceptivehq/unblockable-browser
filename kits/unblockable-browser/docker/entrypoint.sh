#!/usr/bin/env bash
# The unblockable browser's container (the unblockable browser kit, docs/unblockable-browser.md, "The container").
# One browser: a virtual screen (Xvfb), a visible Chromium with Browser MCP's extension stamped for this image's
# profile and port, the broker that runs the one Browser MCP server, and MCP over HTTP behind a bearer token
# (bin/browser-mcp-http.mjs). An optional residential proxy carries only the hosts in PROXY_HOSTS.
#
# Chromium is started again when it exits. If the broker, the HTTP front or the proxy forwarder ends, the container
# ends, and its restart policy starts it again. Never headless; no remote-debugging port or pipe.
set -euo pipefail
umask 077

die() {
  printf 'entrypoint: %s\n' "$1" >&2
  exit "${2:-64}"
}
say() { printf 'entrypoint: %s\n' "$1" >&2; }

root="${BROWSER_ROOT:?}"
profile="${BROWSER_PROFILE:?}"
bin="$root/bin"
node="${BROWSER_NODE:-/usr/local/bin/node}"

[[ -n "${BROWSER_MCP_TOKEN:-}" || -n "${BROWSER_MCP_TOKEN_FILE:-}" ]] ||
  die 'set BROWSER_MCP_TOKEN_FILE (a mounted file) or BROWSER_MCP_TOKEN: a token of at least 32 characters'
[[ "$(sed -n 's/^BROWSER_PORT=//p' "$root/browsers/$profile.env")" == "${BROWSER_PORT:-}" ]] ||
  die "this image's extension is stamped for ${profile} on its own port; BROWSER_PROFILE and BROWSER_PORT are fixed when the image is built"

# A profile volume from an earlier container keeps Chromium's single-instance lock, which names that container's
# host name; Chromium would take it for a browser running elsewhere and refuse the profile. Only this container
# uses the volume, so the lock goes.
data="$root/profiles/$profile"
if [[ -d "$data" && ! -L "$data" ]]; then
  for lock in SingletonLock SingletonSocket SingletonCookie; do
    if [[ -L "$data/$lock" || -e "$data/$lock" ]]; then rm -f -- "$data/$lock"; fi
  done
fi

# The proxy. PROXY_ENV_FILE (a mounted file: PROXY_SERVER, and PROXY_USERNAME and PROXY_PASSWORD for a password
# proxy) keeps the sign-in out of the container's environment; PROXY_SERVER and the rest set directly work too.
# A password proxy goes through the kit's loopback forwarder, so the sign-in never reaches Chromium or the PAC file.
proxy_file="${PROXY_ENV_FILE:-}"
proxy_server="${PROXY_SERVER:-}"
password=""
if [[ -n "$proxy_file" ]]; then
  [[ -f "$proxy_file" ]] || die "PROXY_ENV_FILE ($proxy_file) is not a readable file"
  proxy_server="$(sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}PROXY_SERVER=//p' "$proxy_file" | head -n 1 | tr -d "\"' \r")"
  if grep -q '^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}PROXY_USERNAME=.' "$proxy_file"; then password=1; fi
elif [[ -n "${PROXY_USERNAME:-}" ]]; then
  password=1
fi
if [[ -n "$proxy_server" ]]; then
  [[ "$proxy_server" =~ ^[A-Za-z0-9.-]+:[0-9]{1,5}$ ]] || die 'PROXY_SERVER must be host:port'
  [[ -n "${PROXY_HOSTS:-}" ]] || die 'PROXY_HOSTS must list the hosts that go through the proxy (comma separated)'
  if [[ -n "$password" ]]; then
    forward_port="${FORWARD_PORT:-3128}"
    if [[ -n "$proxy_file" ]]; then
      env -u PROXY_SERVER -u PROXY_USERNAME -u PROXY_PASSWORD FORWARD_BIND=127.0.0.1 FORWARD_PORT="$forward_port" \
        "$node" --env-file="$proxy_file" "$bin/proxy-forward.mjs" &
    else
      FORWARD_BIND=127.0.0.1 FORWARD_PORT="$forward_port" "$node" "$bin/proxy-forward.mjs" &
    fi
    target="PROXY 127.0.0.1:$forward_port"
  else
    target="PROXY $proxy_server"
  fi
  "$node" "$root/docker/pac.mjs" "$target" "$PROXY_HOSTS" > "$root/pac/$profile.pac"
  export BROWSER_PAC="$root/pac/$profile.pac"
  say "the proxy carries ${PROXY_HOSTS}; everything else goes direct"
fi
unset PROXY_SERVER PROXY_USERNAME PROXY_PASSWORD

display="${DISPLAY#:}"
Xvfb ":$display" -screen 0 1920x1080x24 -nolisten tcp -nolisten local &
for _ in $(seq 1 100); do
  [[ -S "/tmp/.X11-unix/X$display" ]] && break
  sleep 0.1
done
[[ -S "/tmp/.X11-unix/X$display" ]] || die "Xvfb did not start on $DISPLAY" 69

(
  while :; do
    "$bin/browser-chromium" "$profile" || say "Chromium ended ($?)"
    sleep 2
  done
) &

"$node" "$bin/browser-broker.mjs" serve &
"$node" "$bin/browser-mcp-http.mjs" &

wait -n
die "a part of the browser ended; the container stops so its restart policy can start it again" 70

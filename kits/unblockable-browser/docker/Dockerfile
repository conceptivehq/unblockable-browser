# The unblockable browser as one container: Xvfb, a visible Chromium, Browser MCP's extension stamped for this
# image's profile and port, Browser MCP, the kit's broker, and MCP over HTTP behind a bearer token on port 8930.
# docs/unblockable-browser.md ("The container") has the whole story. Build from the kit's folder:
#
#   docker build -t unblockable-browser -f kits/unblockable-browser/docker/Dockerfile kits/unblockable-browser
#
# and run it (the token is a file of 32 or more random characters outside Git, readable by uid 10001 and no one else;
# the seccomp profile is Docker's default plus the namespace calls Chromium's sandbox makes):
#
#   docker run -d --name unblockable-browser --restart unless-stopped --shm-size 1g \
#     --security-opt seccomp=kits/unblockable-browser/docker/chromium-seccomp.json \
#     --security-opt no-new-privileges \
#     -p 127.0.0.1:8930:8930 \
#     -v unblockable-browser-profile:/opt/unblockable-browser/profiles \
#     -v /srv/secrets/browser-mcp-token:/run/secrets/browser-mcp-token:ro \
#     -e BROWSER_MCP_TOKEN_FILE=/run/secrets/browser-mcp-token \
#     unblockable-browser
#
# A Strut server then reaches it with BROWSER_MCP_URL=http://127.0.0.1:8930/mcp and BROWSER_MCP_TOKEN.

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
ARG BROWSER_MCP_REPO=https://github.com/getcabal/browser-mcp.git
ARG BROWSER_MCP_COMMIT=cbb07a105ee52c93004b9164b05bcbf93d17073f
ARG BROWSER_PROFILE=browser
ARG BROWSER_PORT=21300
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /build/browser-mcp
# Browser MCP at the pinned commit, built, with one extension copy stamped and locked to this image's profile and port.
RUN printf '%s' "$BROWSER_MCP_COMMIT" | grep -Eq '^[0-9a-f]{40}$' \
 && printf '%s' "$BROWSER_PROFILE" | grep -Eq '^[a-z0-9][a-z0-9-]{0,40}$' \
 && printf '%s' "$BROWSER_PORT" | grep -Eq '^[0-9]{4,5}$' \
 && git init -q . \
 && git remote add origin "$BROWSER_MCP_REPO" \
 && git fetch -q --depth 1 origin "$BROWSER_MCP_COMMIT" \
 && git checkout -q --detach FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "$BROWSER_MCP_COMMIT" \
 && rm -rf .git
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && npm run build \
 && npm run package -- --output-dir /build/package-out --profile "$BROWSER_PROFILE:$BROWSER_PORT" \
 && node scripts/doctor.mjs --extension-dir "/build/package-out/profiles/$BROWSER_PROFILE" \
      --artifacts /build/package-out/artifacts.json | grep -F "locked to $BROWSER_PROFILE:$BROWSER_PORT" \
 && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE}
ARG BROWSER_MCP_COMMIT=cbb07a105ee52c93004b9164b05bcbf93d17073f
ARG BROWSER_PROFILE=browser
ARG BROWSER_PORT=21300
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates chromium fonts-liberation fonts-noto-color-emoji tini xvfb \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 --shell /usr/sbin/nologin browser \
 && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

ENV BROWSER_ROOT=/opt/unblockable-browser \
    BROWSER_PROFILE=${BROWSER_PROFILE} \
    BROWSER_PORT=${BROWSER_PORT} \
    BROWSER_CHROMIUM=/usr/lib/chromium/chromium \
    BROWSER_NODE=/usr/local/bin/node \
    BROWSER_SUPERVISOR=none \
    BROWSER_MCP_PAGE_ISOLATION=window \
    BROWSER_MCP_HTTP_HOST=0.0.0.0 \
    BROWSER_MCP_HTTP_PORT=8930 \
    DISPLAY=:99

COPY bin/ /opt/unblockable-browser/bin/
COPY docker/entrypoint.sh docker/pac.mjs /opt/unblockable-browser/docker/
COPY --from=build /build/browser-mcp /opt/unblockable-browser/browser-mcp/${BROWSER_MCP_COMMIT}
COPY --from=build /build/package-out/profiles/${BROWSER_PROFILE} /opt/unblockable-browser/extensions/${BROWSER_PROFILE}

# Everything the browser runs is root's and read-only to it; only its profile, the broker's socket and the PAC file
# are its own.
RUN cd /opt/unblockable-browser \
 && printf '%s\n' "$BROWSER_MCP_COMMIT" > current \
 && mkdir browsers \
 && printf 'BROWSER_PROFILE=%s\nBROWSER_PORT=%s\n' "$BROWSER_PROFILE" "$BROWSER_PORT" > "browsers/$BROWSER_PROFILE.env" \
 && chmod 755 bin/browser-chromium bin/browser-mcp bin/browser-server docker/entrypoint.sh \
 && chmod -R a+rX,go-w . \
 && mkdir -m 700 profiles run pac \
 && chown browser:browser profiles run pac

VOLUME /opt/unblockable-browser/profiles
USER browser
WORKDIR /home/browser
EXPOSE 8930
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.BROWSER_MCP_HTTP_PORT||8930)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/opt/unblockable-browser/docker/entrypoint.sh"]

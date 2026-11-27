---
name: Residential proxy
description: Sends only the listed sites of the unblockable browser through a residential proxy; every other site goes direct.
parents:
  - Unblockable browser
---
Some sites block data-centre addresses. The container can send a list of sites through a proxy: set `PROXY_HOSTS` (comma separated) and Chromium gets a PAC file that sends only those hosts and their subdomains through the proxy, and everything else direct.

Two ways to sign in to the proxy:

- **allowlist**: the proxy provider trusts the server's own IP address. Set `PROXY_SERVER=host:port`; no password exists.
- **password**: the provider wants a user name and password. Mount an env file (`PROXY_SERVER`, `PROXY_USERNAME` and `PROXY_PASSWORD`, readable by uid 10001) and point `PROXY_ENV_FILE` at it. A small forwarder on the container's loopback adds the sign-in, so it never reaches Chromium, the PAC file, the container's environment or a log.

The proxy file never goes into Git or chat. The browser also keeps WebRTC from leaving outside the proxy.

The workflow `conceptive/unblockable-browser/check` reports the egress IP the web sees, so a person can see whether the browser leaves through the proxy (point its `ip_url` at a proxied host to check that path).

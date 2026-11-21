---
name: Residential proxy
description: Sends only the listed sites of the unblockable browser through a residential proxy; every other site goes direct.
parents:
  - Unblockable browser
---
Some sites block data-centre addresses. A browser can name a proxy in the config file; its Chromium then gets a PAC file (passed as a `data:` URL, since Chromium no longer reads PAC files from `file://`) that sends only the proxy's `pac_hosts` and their subdomains through it, and everything else direct.

Two ways to sign in to the proxy:

- **allowlist**: the proxy provider trusts the server's own IP address. The PAC file names the proxy directly (`PROXY <host:port>`); no password exists.
- **password**: the provider wants a user name and password. The kit runs a small forwarder (`fleet-proxy.service`) on 127.0.0.1:3128 that adds them, so they never reach the browser, the PAC file, a command line or a log. The PAC file names the forwarder.

A person writes the proxy env file (`PROXY_SERVER=host:port`, and for password auth `PROXY_USERNAME` and `PROXY_PASSWORD`) with mode 600. It never goes into Git or chat; `verify` reports only that it exists and its mode. The browser also blocks WebRTC from leaving outside the proxy and takes the browser's `timezone`.

The workflow `conceptive/unblockable-browser/check` reports the egress IP the web sees, so a person can see whether the browser leaves through the proxy (point its `ip_url` at a proxied host to check that path).

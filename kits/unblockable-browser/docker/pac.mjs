#!/usr/bin/env node
// Prints the container's PAC file (the unblockable browser kit, docker/entrypoint.sh), the same one the kit's
// render_pac writes: the listed hosts and their subdomains go through the proxy, everything else goes direct, and a
// listed host has no DIRECT fallback, so a stopped proxy fails closed instead of showing the server's own address.
//
//   node pac.mjs "PROXY host:port" "example.com,example.org"
//
// It holds host names and the proxy's address, never a credential.
const [target = "", list = ""] = process.argv.slice(2);
const fail = (msg) => {
  process.stderr.write(`pac: ${msg}\n`);
  process.exit(64);
};
if (!/^PROXY [A-Za-z0-9.-]+:[0-9]{1,5}$/.test(target)) fail("the target is PROXY host:port");
const hosts = list.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
if (!hosts.length) fail("PROXY_HOSTS lists no host");
for (const h of hosts) if (!/^[a-z0-9](?:[a-z0-9-]{0,62}\.)*[a-z0-9-]{1,63}$/.test(h)) fail(`${h} is not a host name`);
process.stdout.write(
  "// Written by the unblockable browser kit's container. Listed hosts and their subdomains use the proxy; the rest go direct.\n" +
    "function FindProxyForURL(url, host) {\n" +
    "  host = host.toLowerCase();\n" +
    `  var hosts = ${JSON.stringify(hosts)};\n` +
    "  for (var i = 0; i < hosts.length; i++) {\n" +
    `    if (host === hosts[i] || dnsDomainIs(host, "." + hosts[i])) return ${JSON.stringify(target)};\n` +
    "  }\n" +
    '  return "DIRECT";\n' +
    "}\n",
);

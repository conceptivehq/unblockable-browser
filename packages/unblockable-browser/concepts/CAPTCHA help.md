---
name: CAPTCHA help
description: What the unblockable browser does at a CAPTCHA or human check, and how a person can step in.
parents:
  - Unblockable browser
---
Nothing in this package solves or works around a CAPTCHA or a "verify you are human" page. A declared workflow's wait for the page's text times out and the run says so; the `explore` agent stops, puts the page's address in `blocked` and answers with what it has.

The container has no screen view yet, so a person cannot answer a check inside it. Two things help:

- **A residential proxy** for the site (see *Residential proxy*). Most checks appear because the address belongs to a data centre.
- **The kept profile.** The container's profile volume keeps cookies, so a check the browser once passed usually stays passed.

Installed without Docker, through the repository's installer kit, a browser can show its screen: the operator sets `vnc: true` and applies it, the kit runs x11vnc on the virtual display, bound to 127.0.0.1 only, and a person reaches it through an SSH tunnel (`ssh -L 6000:127.0.0.1:6000 <server>`, then a VNC viewer at `localhost:6000`). A check passed there stays passed for that profile. Set `vnc: false` again when the help is no longer needed.

---
name: CAPTCHA help
description: What the unblockable browser does at a CAPTCHA or human check, and how a person can look at its screen through a loopback VNC view and an SSH tunnel.
parents:
  - Unblockable browser
---
Nothing in this package solves or works around a CAPTCHA or a "verify you are human" page. A declared workflow's wait for the page's text times out and the run says so; the `explore` agent stops, puts the page's address in `blocked` and answers with what it has.

To see what the browser saw, the operator sets `vnc: true` in the config file and applies it. The kit then runs `fleet-vnc@<display>.service`: x11vnc on the virtual display, bound to 127.0.0.1 only on port 5900 + display (6000 for display :100). Nothing listens on a public address.

The person opens an SSH tunnel to the server (`ssh -L 6000:127.0.0.1:6000 <server>`) and points a VNC viewer at `localhost:6000`. A check a person passes there stays passed for the browser's profile (its cookies), so the next run may get through. Set `vnc: false` again and apply when the help is no longer needed.

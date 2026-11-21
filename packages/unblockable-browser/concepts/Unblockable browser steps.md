---
name: Unblockable browser steps
description: The fifteen browser/* steps a Strut workflow uses on the unblockable browser, as declared steps or as an agent's tools, and what each one does on the browser.
parents:
  - Unblockable browser
---
Each `browser/*` step is one action on the run's own window. A workflow can name them as steps (a declared route, with selectors) or hand them to an `agent` step as tools (`agentTools: ["browser/*"]`, where `browser/click` becomes `browser_click` and the model acts on refs).

| Step | What it does | On the browser |
| --- | --- | --- |
| `browser/open` | Opens the run's window, optionally at `url`. The first browser step of every run. | Browser MCP `new_page` in a window of its own. |
| `browser/goto` | Goes to `url`. | `navigate_page`; the landed address is checked against the deny list again. |
| `browser/snapshot` | The page's accessibility tree, each element you can act on marked `[ref=eN]`, each link's address under it (`- /url: …`). | `take_snapshot` in document order, frames under their iframe; the first 800 lines. |
| `browser/text` | The text of the page, one ref or one selector. | `get_text`, or the element's `innerText`; up to 50,000 characters. |
| `browser/click` | Clicks a ref or a selector (`double` for two clicks). | A ref is Browser MCP's `click`; a selector is a real press and release at the element's centre. |
| `browser/fill` | Replaces a field's value. | `fill` by ref; by selector, the value is set and input and change events fire. |
| `browser/type` | Types text into the focused element, key by key. | `type_text`. |
| `browser/press` | Presses a key or chord, such as `Enter` or `Control+A`. | `press_key`. |
| `browser/select` | Picks an option of a select by its value or label. | Focuses the select, then sets it. |
| `browser/hover` | Moves the pointer over an element. | `hover`. |
| `browser/scroll` | Scrolls the page by `y`, or an element into view. | `scrollBy` or `scrollIntoView` in the page. |
| `browser/back` | Goes back one page. | `navigate_page` back. |
| `browser/wait` | Waits for `text`, a `url`, a ref, a selector or `ms`. | Polls the page; one run's budget caps it. |
| `browser/screenshot` | Saves the viewport as `shots/NNN.png` (or `shots/<name>.png`) and returns its link. | `take_screenshot` of the window; an agent sees a 0.6× copy. |
| `browser/close` | Closes the run's window. | `close_page`; a run's end closes it too. |

Selectors are CSS, `text=…` or `role=…[name=…]`. Refs reset whenever the page changes document, so a model snapshots again after a navigation. One run's calls take turns in the order they were sent, so one agent reply can navigate and then read.

Two more of Strut's steps work on the browser where a Strut's step list has them (a research-only step list may leave them out): `browser/evaluate` runs an expression or function in the page and answers its JSON (up to 50,000 characters), and `browser/capture` opens a page, runs a declared list of steps and photographs the window (its steps cannot hold keys, and its `errors` list is always empty).

The browser refuses what it does not do, with the reason: kept pages across runs (`session`), a Playwright `storageState` (the browser's profile keeps its own sign-ins), a right click and Playwright-only selector chains (a screenshot is always the window's view, also when `fullPage` or an element is asked for); and the verbs `observe`, `state`, `tap`, `keydown`, `keyup`, `captcha`, `verify`, `walkthrough`, app `look` and `keep`.

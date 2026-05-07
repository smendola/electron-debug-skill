---
name: electron-debug
description: >
  Debug a running Electron app via Chrome DevTools Protocol (CDP): stream all
  console output including startup errors, inspect JavaScript variables in the
  renderer, and reload the page. Use when debugging an Electron app, when the
  app fails to start and you need to see console errors, when you need to
  inspect renderer-process variables, or when you need to reload the renderer.
compatibility: >
  Requires Node.js 22+ (built-in WebSocket), curl.
  On Linux/X11: also requires a running display (DISPLAY set).
  The Electron app must accept --remote-debugging-port (all Electron apps do).
---

## Overview

Electron's renderer runs in a Chromium process. All debugging is done through
the Chrome DevTools Protocol (CDP), which Electron exposes when launched with
`--remote-debugging-port`.

There are two scripts:

- **`scripts/cdp-watch-startup.js`** — Stream all console output from the
  renderer, including errors that fire at t0 on startup. Run this first, then
  launch Electron.
- **`scripts/cdp-eval.js`** — One-shot: connect to a running app, evaluate a
  JS expression in the renderer, print the result, and exit. Also supports
  `--reload`.

## Step 1: Launch Electron with the debug port

```bash
electron . --remote-debugging-port=9222
```

The `--remote-debugging-port` flag is the only change needed. No app code
modifications required.

On Linux/X11 environments, a display server must be available. Check with
`echo $DISPLAY` and prefix the command if needed:

```bash
DISPLAY=:0 electron . --remote-debugging-port=9222
```

On macOS and Windows, no display setup is required.

## Step 2a: Watch console output (including startup errors)

Start the watcher **before** launching Electron so it is subscribed before
the renderer runs:

```bash
node scripts/cdp-watch-startup.js
```

Then launch Electron in a separate terminal. The script will:

1. Poll `localhost:9222` every 50 ms until the page target appears
2. Connect immediately (while the page is still loading)
3. Enable `Console`, `Runtime`, `Log`, and `Page` domains
4. Inject a console buffer via `Page.addScriptToEvaluateOnNewDocument`
5. Reload the page so the buffer is active from literal t0
6. Reconnect and stream all output continuously

**What each output prefix means:**

| Prefix | Source |
|---|---|
| `[error]` / `[warning]` / `[log]` | `console.error/warn/log` calls in renderer JS |
| `[LOG.error]` | Network/resource failures (`ERR_FILE_NOT_FOUND`, etc.) — these come from the `Log` domain, not `Console`; skipping `Log.enable` would miss them |
| `[EXCEPTION]` | Uncaught JS exceptions |

## Step 2b: Inspect a variable

```bash
node scripts/cdp-eval.js "document.title"
node scripts/cdp-eval.js "JSON.stringify(window.myAppState)"
node scripts/cdp-eval.js "typeof window.electronAPI"
```

## Step 2c: Reload the renderer

```bash
node scripts/cdp-eval.js --reload
```

**Important — always verify your reload actually loaded new code.**
`Page.reload` does not always re-read files from disk (Electron can cache the
HTML). `Page.navigate` to the file URL is more reliable. Either way, confirm
with a nonce:

1. Add a unique string to the app code before reloading:
   ```js
   console.log('app version sweet-chocolate');
   ```
2. After reload, check the watcher output or run:
   ```bash
   node scripts/cdp-eval.js "window.__cdpLogs?.find(e=>e.msg.includes('sweet-chocolate'))?.msg"
   ```
3. If you do **not** see the nonce, your reload did not pick up the change.
   Use `Page.navigate` to the file URL instead of `Page.reload`.

Change the nonce string each time you modify code so you can distinguish
successive reloads from each other.

## Port resolution

Both scripts default to port **9222** and apply this logic automatically:

1. Port 9222 is free → use it
2. Port 9222 is occupied and already serving CDP → connect to it (Electron already running)
3. Port 9222 is occupied by something else → kill it, reclaim 9222
4. Cannot free 9222 → fall back to 9223

Pass `--port PORT` to override.

## CDP response shape (important gotcha)

`Runtime.evaluate` returns a double-nested result:

```js
// WRONG — this is undefined
msg.result.value

// CORRECT
msg.result.result.value
```

## After a reload, the WebSocket closes

`Page.reload` causes the renderer to navigate. The CDP WebSocket drops.
Always fire reload as fire-and-forget, then close the socket, sleep ~3s,
re-fetch `/json`, and reconnect to the new target.

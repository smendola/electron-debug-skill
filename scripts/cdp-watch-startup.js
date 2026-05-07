#!/usr/bin/env node
/**
 * Stream all Electron renderer console output, including startup errors.
 *
 * Usage:
 *   node cdp-watch-startup.js [--port 9222]
 *
 * Start this BEFORE launching Electron so you are subscribed before renderer
 * scripts run. Then in another terminal:
 *   DISPLAY=:0 electron . --remote-debugging-port=9222
 */
'use strict';
const { execSync } = require('child_process');
const http = require('http');
const { findPidOnPort } = require('./find-port-pid');

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node cdp-watch-startup.js [--port PORT]

Streams all Electron renderer console output to stdout, including errors that
fire at page load (t0). Start this before launching Electron.

Options:
  --port PORT   CDP debug port (default: 9222, fallback: 9223)
  --help        Show this help

Output prefixes:
  [log/info/warn/error/debug]  console.* calls from renderer JS
  [LOG.error/warning]          network failures, resource errors (Log domain)
  [EXCEPTION]                  uncaught JS exceptions
`);
  process.exit(0);
}

const portArg = args[args.indexOf('--port') + 1];
const PREFERRED = parseInt(portArg || '9222', 10);
const FALLBACK  = PREFERRED + 1;

// Injected before any page code runs. Buffers all console calls so nothing
// is lost even in the window between page creation and domain subscription.
const CONSOLE_BUFFER_SCRIPT = `(function(){
  window.__cdpLogs=[];
  ['log','info','warn','error','debug','trace'].forEach(function(l){
    var o=console[l].bind(console);
    console[l]=function(){
      var a=Array.prototype.slice.call(arguments);
      window.__cdpLogs.push({level:l,msg:a.map(String).join(' '),ts:Date.now()});
      o.apply(console,arguments);
    };
  });
  window.addEventListener('error',function(e){
    window.__cdpLogs.push({level:'UNCAUGHT_ERROR',msg:e.message+' @ '+e.filename+':'+e.lineno,ts:Date.now()});
  });
  window.addEventListener('unhandledrejection',function(e){
    window.__cdpLogs.push({level:'UNHANDLED_REJECTION',msg:String(e.reason),ts:Date.now()});
  });
})();`;

function httpGet(url) {
  return new Promise(resolve => {
    const req = http.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(800, () => { req.destroy(); resolve(null); });
  });
}

function isCDPUp(port) {
  return httpGet(`http://localhost:${port}/json`).then(r => Array.isArray(r));
}

function killPort(port) {
  const pid = findPidOnPort(port);
  if (!pid) return false;
  try {
    process.platform === 'win32'
      ? execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' })
      : execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function isPortFree(port) {
  return findPidOnPort(port) === null;
}

async function resolvePort() {
  if (isPortFree(PREFERRED)) return PREFERRED;
  if (await isCDPUp(PREFERRED)) {
    console.log(`Port ${PREFERRED} already has a CDP server — connecting to it.`);
    return PREFERRED;
  }
  console.log(`Port ${PREFERRED} occupied by non-CDP process — freeing it...`);
  killPort(PREFERRED);
  await new Promise(r => setTimeout(r, 600));
  if (isPortFree(PREFERRED)) return PREFERRED;
  console.log(`Could not free ${PREFERRED}, falling back to ${FALLBACK}.`);
  return FALLBACK;
}

async function waitForPage(port) {
  process.stdout.write(`Polling :${port} for Electron`);
  while (true) {
    const targets = await httpGet(`http://localhost:${port}/json`);
    if (targets) {
      const page = targets.find(t => t.type === 'page' && !t.url.startsWith('devtools://'));
      if (page) { console.log(' connected.\n'); return page; }
    }
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 50));
  }
}

function makeCDPClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 1;
    const pending = new Map();
    const handlers = [];

    ws.addEventListener('message', ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
      handlers.forEach(h => h(msg));
    });
    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          const cid = id++;
          return new Promise(res => { pending.set(cid, res); ws.send(JSON.stringify({ id: cid, method, params })); });
        },
        onEvent(fn) { handlers.push(fn); },
        close() { ws.close(); },
      });
    });
    ws.addEventListener('error', () => reject(new Error(`WS error connecting to ${wsUrl}`)));
    ws.addEventListener('close', () => { console.log('[WS closed]'); });
  });
}

function printEvent(msg) {
  if (msg.method === 'Console.messageAdded') {
    const m = msg.params.message;
    const loc = m.url ? ` @${m.url.split('/').pop()}:${m.line}` : '';
    console.log(`[${m.level}] ${m.text}${loc}`);
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const args = msg.params.args.map(a => a.value ?? a.description ?? `<${a.type}>`).join(' ');
    console.log(`[${msg.params.type}] ${args}`);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const ex = msg.params.exceptionDetails;
    console.log(`[EXCEPTION] ${ex.exception?.description ?? ex.text}`);
  }
  if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry;
    const loc = e.url ? ` @${e.url.split('/').pop()}:${e.lineNumber}` : '';
    console.log(`[LOG.${e.level}] ${e.text}${loc}`);
  }
}

async function enableDomains(client) {
  await client.send('Console.enable');
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await client.send('Log.enable');
}

async function main() {
  const port = await resolvePort();
  console.log(`Using port ${port}`);

  const page = await waitForPage(port);
  const client = await makeCDPClient(page.webSocketDebuggerUrl);
  client.onEvent(printEvent);
  await enableDomains(client);

  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: CONSOLE_BUFFER_SCRIPT });
  console.log('Console buffer injected. Reloading to capture from t0...\n' + '─'.repeat(60));

  client.send('Page.reload', { ignoreCache: true }).catch(() => {});
  client.close();

  await new Promise(r => setTimeout(r, 3000));

  const targets2 = await httpGet(`http://localhost:${port}/json`);
  const page2 = targets2?.find(t => t.type === 'page' && !t.url.startsWith('devtools://'));
  if (!page2) { console.error('Could not find page after reload.'); process.exit(1); }

  const client2 = await makeCDPClient(page2.webSocketDebuggerUrl);
  client2.onEvent(printEvent);
  await enableDomains(client2);

  // Dump anything the buffer caught before domains were enabled
  const r = await client2.send('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__cdpLogs||[])',
    returnByValue: true,
  });
  const buffered = JSON.parse(r.result?.result?.value || '[]');
  if (buffered.length) {
    console.log(`\n── Buffered from t0 (${buffered.length} entries) ──`);
    buffered.forEach(e => console.log(`[${e.level}] ${e.msg}`));
    console.log('─'.repeat(60));
  }

  console.log('── Live stream (Ctrl-C to stop) ──\n');
  await new Promise(() => {});  // run until Ctrl-C
}

main().catch(e => { console.error(e.message); process.exit(1); });

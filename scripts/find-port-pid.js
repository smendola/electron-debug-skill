/**
 * Cross-platform: find the PID listening on a given TCP port.
 * No external dependencies.
 *
 * - Linux:   reads /proc/net/tcp[6] + /proc/<pid>/fd symlinks
 * - macOS:   lsof is built-in, delegates to it
 * - Windows: parses `netstat -ano`
 *
 * Exports:  findPidOnPort(port: number): number | null
 */
'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

function findPidOnPort(port) {
  switch (os.platform()) {
    case 'win32':  return findPidWindows(port);
    case 'darwin': return findPidMacos(port);
    default:       return findPidLinux(port);
  }
}

// ── Windows ─────────────────────────────────────────────────────────────────
function findPidWindows(port) {
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8', stdio: ['pipe','pipe','ignore'] });
    for (const line of out.split('\n')) {
      // TCP    0.0.0.0:9222    0.0.0.0:0    LISTENING    1234
      const m = line.match(/TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
      if (m && parseInt(m[1]) === port) return parseInt(m[2]);
    }
  } catch {}
  return null;
}

// ── macOS ────────────────────────────────────────────────────────────────────
function findPidMacos(port) {
  try {
    const out = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8', stdio: ['pipe','pipe','ignore'] }).trim();
    return out ? parseInt(out) : null;
  } catch { return null; }
}

// ── Linux (/proc) ─────────────────────────────────────────────────────────────
function findPidLinux(port) {
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0');

  // Find the socket inode from /proc/net/tcp and /proc/net/tcp6
  let inode = null;
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').slice(1);
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 10) continue;
        const state = parts[3];
        if (state !== '0A') continue;  // 0A = LISTEN
        const localPort = parts[1].split(':')[1];
        if (localPort === hexPort) { inode = parts[9]; break; }
      }
    } catch {}
    if (inode) break;
  }
  if (!inode) return null;

  // Scan /proc/<pid>/fd symlinks to find which process owns the socket inode
  const target = `socket:[${inode}]`;
  try {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const fdDir = `/proc/${entry}/fd`;
      try {
        for (const fd of fs.readdirSync(fdDir)) {
          try {
            if (fs.readlinkSync(`${fdDir}/${fd}`) === target) return parseInt(entry);
          } catch {}
        }
      } catch {}
    }
  } catch {}
  return null;
}

module.exports = { findPidOnPort };

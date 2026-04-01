/**
 * Windows spawn compatibility preload.
 *
 * The @anthropic-ai/claude-agent-sdk uses raw child_process.spawn() to invoke
 * the Claude CLI. On Windows, npm-installed CLIs are `.cmd` shim files which
 * cannot be spawned directly — Node.js throws EINVAL. This preload monkey-patches
 * child_process.spawn/spawnSync/execFileSync to:
 *
 *   1. Detect .cmd files, parse them to find the underlying .js entry point,
 *      and spawn node.exe + script.js directly (bypassing .cmd entirely).
 *   2. Convert MSYS/Git-Bash paths (/c/Users/... -> C:\Users\...) in the cwd option.
 *
 * Loaded via NODE_OPTIONS=--require in supervisor-windows.ps1.
 *
 * Based on workaround by Michael Arbus.
 */

'use strict';

const cp = require('child_process');
const fs = require('fs');
const pathMod = require('path');

// Cache: .cmd path -> underlying .js script path (or null if not parseable)
const cmdToScript = new Map();

/**
 * Parse an npm .cmd shim to find the underlying Node.js script it invokes.
 */
function resolveCmd(cmdPath) {
  if (cmdToScript.has(cmdPath)) return cmdToScript.get(cmdPath);
  try {
    const content = fs.readFileSync(cmdPath, 'utf8');
    // npm .cmd shims contain: "%_prog%" "%dp0%\node_modules\...\file.js" %*
    const m = content.match(/"?%_prog%"?\s+"?%dp0%\\([^"% ]+)"?\s+%\*/);
    if (m) {
      const dir = pathMod.dirname(cmdPath);
      const script = pathMod.join(dir, m[1]);
      if (fs.existsSync(script)) {
        cmdToScript.set(cmdPath, script);
        return script;
      }
    }
  } catch { /* not a parseable .cmd */ }
  cmdToScript.set(cmdPath, null);
  return null;
}

/**
 * Convert MSYS/Cygwin-style paths to native Windows paths.
 *   /c/Users/foo  ->  C:\Users\foo
 */
function toWinPath(p) {
  if (!p || typeof p !== 'string') return p;
  const m = p.match(/^\/([a-zA-Z])\/(.*)/);
  if (m) return m[1].toUpperCase() + ':' + pathMod.sep + m[2].split('/').join(pathMod.sep);
  return p;
}

function isCmdOrBat(file) {
  if (typeof file !== 'string') return false;
  const lower = file.toLowerCase();
  return lower.endsWith('.cmd') || lower.endsWith('.bat');
}

function isJsFile(file) {
  if (typeof file !== 'string') return false;
  const lower = file.toLowerCase();
  return lower.endsWith('.js') || lower.endsWith('.mjs');
}

function fixCwd(options) {
  if (options && options.cwd) {
    return { ...options, cwd: toWinPath(options.cwd) };
  }
  return options;
}

// ── Patch spawn ──
const origSpawn = cp.spawn;
cp.spawn = function patchedSpawn(command, args, options) {
  if (process.platform !== 'win32') return origSpawn.call(this, command, args, options);
  if (isCmdOrBat(command)) {
    const script = resolveCmd(command);
    if (script) {
      return origSpawn.call(this, process.execPath, [script, ...(args || [])], fixCwd(options));
    }
  }
  if (isJsFile(command)) {
    return origSpawn.call(this, process.execPath, [command, ...(args || [])], fixCwd(options));
  }
  return origSpawn.call(this, command, args, fixCwd(options));
};

// ── Patch execFileSync ──
const origExecFileSync = cp.execFileSync;
cp.execFileSync = function patchedExecFileSync(file, args, options) {
  if (process.platform !== 'win32') return origExecFileSync.call(this, file, args, options);
  if (isCmdOrBat(file)) {
    const script = resolveCmd(file);
    if (script) {
      return origExecFileSync.call(this, process.execPath, [script, ...(args || [])], fixCwd(options));
    }
  }
  if (isJsFile(file)) {
    return origExecFileSync.call(this, process.execPath, [file, ...(args || [])], fixCwd(options));
  }
  return origExecFileSync.call(this, file, args, fixCwd(options));
};

// ── Patch spawnSync ──
const origSpawnSync = cp.spawnSync;
cp.spawnSync = function patchedSpawnSync(command, args, options) {
  if (process.platform !== 'win32') return origSpawnSync.call(this, command, args, options);
  if (isCmdOrBat(command)) {
    const script = resolveCmd(command);
    if (script) {
      return origSpawnSync.call(this, process.execPath, [script, ...(args || [])], fixCwd(options));
    }
  }
  if (isJsFile(command)) {
    return origSpawnSync.call(this, process.execPath, [command, ...(args || [])], fixCwd(options));
  }
  return origSpawnSync.call(this, command, args, fixCwd(options));
};

// ── Patch execSync ──
// execSync takes a shell command string, not a file path. We intercept calls where
// the command starts with a quoted .js/.mjs path and prepend node.exe.
const origExecSync = cp.execSync;
cp.execSync = function patchedExecSync(command, options) {
  if (process.platform !== 'win32' || typeof command !== 'string') {
    return origExecSync.call(this, command, options);
  }
  // Match: "C:\path\to\file.js" --args  or  C:\path\to\file.js --args
  const m = command.match(/^"?([^"]+\.(js|mjs))"?\s/i);
  if (m && fs.existsSync(m[1])) {
    const rewritten = `"${process.execPath}" ${command}`;
    return origExecSync.call(this, rewritten, fixCwd(options));
  }
  return origExecSync.call(this, command, fixCwd(options));
};

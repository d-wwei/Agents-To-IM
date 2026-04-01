/**
 * patch-sdk-streaming.mjs — Enable V2 session streaming in Claude Agent SDK.
 *
 * The SDK's V2 session (unstable_v2_resumeSession / unstable_v2_createSession)
 * hardcodes `includePartialMessages: false` when spawning the CLI subprocess.
 * This means V2 sessions don't emit incremental text_delta events — the full
 * response arrives as a single `assistant` message.
 *
 * This patch flips that flag to `true`, enabling real token-level streaming
 * through V2 persistent sessions. The CLI subprocess already supports it
 * (V1 query() uses it), so this is safe.
 *
 * Upstream feature request: https://github.com/anthropics/claude-code/issues/41732
 *
 * Run automatically during `npm run build` via package.json scripts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const SDK_PATH = path.join(
  projectRoot,
  'node_modules',
  '@anthropic-ai',
  'claude-agent-sdk',
  'sdk.mjs',
);

const SEARCH = 'includePartialMessages:!1';
const REPLACE = 'includePartialMessages:!0';

if (!fs.existsSync(SDK_PATH)) {
  console.warn('[patch-sdk-streaming] SDK not found, skipping:', SDK_PATH);
  process.exit(0);
}

const content = fs.readFileSync(SDK_PATH, 'utf-8');
const count = (content.match(new RegExp(SEARCH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;

if (count === 0) {
  // Already patched or SDK structure changed
  if (content.includes(REPLACE)) {
    console.log('[patch-sdk-streaming] Already patched — V2 streaming enabled.');
  } else {
    console.warn('[patch-sdk-streaming] Pattern not found — SDK may have changed. Manual check needed.');
  }
  process.exit(0);
}

if (count > 1) {
  console.warn(`[patch-sdk-streaming] Found ${count} occurrences (expected 1). Patching all.`);
}

const patched = content.replace(new RegExp(SEARCH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), REPLACE);
fs.writeFileSync(SDK_PATH, patched, 'utf-8');
console.log(`[patch-sdk-streaming] Patched ${count} occurrence(s) — V2 session streaming enabled.`);

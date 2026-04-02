/**
 * Git Summary — collect git status for task completion notifications.
 *
 * All commands run with a 2-second timeout and fail silently on errors
 * (non-git directories, missing git binary, etc.).
 */

import { execFile } from 'node:child_process';

export interface GitSummary {
  branch: string | null;
  modified: number;
  staged: number;
  untracked: number;
  unpushedCommits: number;
}

const EXEC_TIMEOUT_MS = 2000;

function run(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: EXEC_TIMEOUT_MS }, (err, stdout) => {
      resolve(err ? '' : stdout.trim());
    });
  });
}

/**
 * Collect git status for a working directory.
 * Returns null if the directory is not a git repository or git is unavailable.
 */
export async function collectGitSummary(cwd: string): Promise<GitSummary | null> {
  // Quick check: is this a git repo?
  const topLevel = await run(['rev-parse', '--show-toplevel'], cwd);
  if (!topLevel) return null;

  const [branchOut, statusOut, unpushedOut] = await Promise.all([
    run(['branch', '--show-current'], cwd),
    run(['status', '--porcelain'], cwd),
    run(['log', '@{upstream}..HEAD', '--oneline'], cwd),
  ]);

  const branch = branchOut || null;

  let modified = 0;
  let staged = 0;
  let untracked = 0;

  if (statusOut) {
    for (const line of statusOut.split('\n')) {
      if (!line || line.length < 2) continue;
      const x = line[0]; // index (staged)
      const y = line[1]; // working tree (modified)
      if (x === '?' && y === '?') {
        untracked++;
      } else {
        if (x !== ' ' && x !== '?') staged++;
        if (y !== ' ' && y !== '?') modified++;
      }
    }
  }

  const unpushedCommits = unpushedOut
    ? unpushedOut.split('\n').filter(Boolean).length
    : 0;

  return { branch, modified, staged, untracked, unpushedCommits };
}

/**
 * Format a GitSummary into a human-readable one-liner.
 * Example: "main · 2 modified, 1 staged, 3 untracked · 1 unpushed commit"
 */
export function formatGitSummary(g: GitSummary): string {
  const parts: string[] = [];

  if (g.branch) parts.push(g.branch);

  const status: string[] = [];
  if (g.modified > 0) status.push(`${g.modified} modified`);
  if (g.staged > 0) status.push(`${g.staged} staged`);
  if (g.untracked > 0) status.push(`${g.untracked} untracked`);
  if (status.length > 0) parts.push(status.join(', '));

  if (g.unpushedCommits > 0) {
    parts.push(`${g.unpushedCommits} unpushed commit${g.unpushedCommits > 1 ? 's' : ''}`);
  }

  return parts.join(' · ') || 'clean';
}

/**
 * Format elapsed milliseconds into a human-readable duration.
 * Examples: "1.2s", "2m 34s", "1h 5m"
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.floor(sec % 60);
  if (min < 60) return `${min}m ${remSec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m`;
}

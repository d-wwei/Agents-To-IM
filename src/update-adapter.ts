/**
 * Thin adapter for update-kit integration.
 *
 * Uses the same Function() lazy-import trick as codex-provider.ts so that
 * update-kit stays fully optional — if it is not installed the adapter
 * gracefully returns null instead of throwing.
 */

type UpdateRuntimeModule = typeof import('update-kit/runtime');
type UpdateAdapterModule = typeof import('update-kit/adapter');

let _runtime: UpdateRuntimeModule | null = null;
let _adapter: UpdateAdapterModule | null = null;

async function loadUpdateKit(): Promise<{
  runtime: UpdateRuntimeModule;
  adapter: UpdateAdapterModule;
} | null> {
  if (_runtime && _adapter) return { runtime: _runtime, adapter: _adapter };
  try {
    _runtime = await (Function('return import("update-kit/runtime")')() as Promise<UpdateRuntimeModule>);
    _adapter = await (Function('return import("update-kit/adapter")')() as Promise<UpdateAdapterModule>);
    return { runtime: _runtime, adapter: _adapter };
  } catch {
    return null;
  }
}

/**
 * Run a cache-first update check (<5 ms from cache, ~200 ms on first call).
 * Returns a human-readable message when an update is available or was just
 * applied, or null when everything is up-to-date / the kit is not installed.
 */
export async function quickUpdateCheck(skillDir: string): Promise<string | null> {
  const uk = await loadUpdateKit();
  if (!uk) return null;

  const runtime = await uk.runtime.createRuntime({ cwd: skillDir });
  const adapter = uk.adapter.defineAdapter({
    name: 'claude-to-im-skill',
    getContext: () => ({
      cwd: skillDir,
      appName: 'claude-to-im-skill',
      componentName: 'claude-to-im-skill',
    }),
  });

  const result = await runtime.quickCheck(adapter, { softFail: true });

  if (result.status === 'upgrade_available') {
    return `Update available: v${result.candidateVersion} (current: v${result.currentVersion})`;
  }
  if (result.status === 'just_upgraded') {
    return `Upgraded from v${result.previousVersion}!`;
  }
  return null;
}

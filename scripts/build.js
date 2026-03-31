import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/daemon.mjs',
  external: [
    // SDK must stay external — it spawns a CLI subprocess and resolves
    // dist/cli.js relative to its own package location. Bundling it
    // breaks that path resolution.
    '@anthropic-ai/claude-agent-sdk',
    '@openai/codex-sdk',
    // Optional self-update & self-heal kits
    'udd-kit', 'udd-kit/*',
    'update-kit', 'update-kit/*',
    // discord.js optional native deps
    'bufferutil', 'utf-8-validate', 'zlib-sync', 'erlpack',
    // Node.js built-ins
    'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'tls',
    'stream', 'events', 'url', 'util', 'child_process', 'worker_threads',
    'node:*',
  ],
  banner: { js: "import { createRequire as __esbuildCreateRequire } from 'module'; const require = __esbuildCreateRequire(import.meta.url);" },
  // Keep symlinks unresolved so that the relative ../../../../.. paths in
  // claude-to-im's bridge-manager resolve back into this skill's src/ dir.
  preserveSymlinks: true,
});

console.log('Built dist/daemon.mjs');

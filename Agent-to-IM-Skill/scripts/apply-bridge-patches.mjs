import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const ctiPkg = path.join(projectRoot, 'node_modules', 'agent-to-im-core');

const patches = [
  {
    source: path.join(projectRoot, 'patches', 'agent-to-im-core', 'bridge-manager.ts'),
    srcTarget: path.join(ctiPkg, 'src', 'lib', 'bridge', 'bridge-manager.ts'),
    distTarget: path.join(ctiPkg, 'dist', 'lib', 'bridge', 'bridge-manager.js'),
  },
  {
    source: path.join(projectRoot, 'patches', 'agent-to-im-core', 'feishu-adapter.ts'),
    srcTarget: path.join(ctiPkg, 'src', 'lib', 'bridge', 'adapters', 'feishu-adapter.ts'),
    distTarget: path.join(ctiPkg, 'dist', 'lib', 'bridge', 'adapters', 'feishu-adapter.js'),
  },
  {
    source: path.join(projectRoot, 'patches', 'agent-to-im-core', 'discord-adapter.ts'),
    srcTarget: path.join(ctiPkg, 'src', 'lib', 'bridge', 'adapters', 'discord-adapter.ts'),
    distTarget: path.join(ctiPkg, 'dist', 'lib', 'bridge', 'adapters', 'discord-adapter.js'),
  },
];

let applied = 0;

for (const patch of patches) {
  if (!fs.existsSync(patch.source) || !fs.existsSync(patch.srcTarget)) {
    continue;
  }
  const source = fs.readFileSync(patch.source, 'utf-8');
  const current = fs.readFileSync(patch.srcTarget, 'utf-8');
  if (source === current) {
    continue;
  }
  // Copy TS patch to src/
  fs.copyFileSync(patch.source, patch.srcTarget);
  applied += 1;
}

// Also compile patched TS files to dist/ JS so esbuild's bundle step picks them up.
// The package.json exports map src/ paths to dist/, so only dist/*.js matters at runtime.
if (applied > 0 || patches.some(p => {
  // Re-compile if dist is older than src or dist is missing the patched code
  if (!fs.existsSync(p.distTarget)) return true;
  const srcStat = fs.statSync(p.srcTarget);
  const distStat = fs.statSync(p.distTarget);
  return srcStat.mtimeMs > distStat.mtimeMs;
})) {
  // Use the project's tsc to compile the agent-to-im-core package's src/ to dist/
  const tscPath = path.join(ctiPkg, 'node_modules', '.bin', 'tsc');
  const tscFallback = path.join(projectRoot, 'node_modules', '.bin', 'tsc');
  const tsc = fs.existsSync(tscPath) ? tscPath : tscFallback;

  if (fs.existsSync(tsc)) {
    // Compile with a minimal tsconfig targeting just the patched files
    try {
      execFileSync(tsc, [
        '--outDir', path.join(ctiPkg, 'dist'),
        '--rootDir', path.join(ctiPkg, 'src'),
        '--declaration',
        '--module', 'nodenext',
        '--moduleResolution', 'nodenext',
        '--target', 'es2022',
        '--esModuleInterop',
        '--skipLibCheck',
        ...patches.map(p => p.srcTarget),
      ], { stdio: 'pipe', timeout: 30000 });
      console.log(`Compiled ${patches.length} patched file(s) to dist/.`);
    } catch (err) {
      console.warn('Warning: tsc compilation of patches failed, falling back to esbuild transform.');
      // Fallback: use esbuild to strip types (no type checking but works)
      const esbuild = await import('esbuild');
      for (const patch of patches) {
        if (!fs.existsSync(patch.srcTarget)) continue;
        const tsCode = fs.readFileSync(patch.srcTarget, 'utf-8');
        const result = await esbuild.transform(tsCode, {
          loader: 'ts',
          format: 'esm',
          target: 'node20',
        });
        fs.mkdirSync(path.dirname(patch.distTarget), { recursive: true });
        fs.writeFileSync(patch.distTarget, result.code, 'utf-8');
      }
      console.log(`Transpiled ${patches.length} patched file(s) to dist/ via esbuild.`);
    }
  } else {
    // No tsc available — use esbuild transform as fallback
    const esbuild = await import('esbuild');
    for (const patch of patches) {
      if (!fs.existsSync(patch.srcTarget)) continue;
      const tsCode = fs.readFileSync(patch.srcTarget, 'utf-8');
      const result = await esbuild.transform(tsCode, {
        loader: 'ts',
        format: 'esm',
        target: 'node20',
      });
      fs.mkdirSync(path.dirname(patch.distTarget), { recursive: true });
      fs.writeFileSync(patch.distTarget, result.code, 'utf-8');
    }
    console.log(`Transpiled ${patches.length} patched file(s) to dist/ via esbuild (no tsc found).`);
  }
}

if (applied > 0) {
  console.log(`Applied ${applied} bridge patch${applied === 1 ? '' : 'es'}.`);
}

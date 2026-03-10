import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const patches = [
  {
    source: path.join(projectRoot, 'patches', 'claude-to-im', 'bridge-manager.ts'),
    target: path.join(projectRoot, 'node_modules', 'claude-to-im', 'src', 'lib', 'bridge', 'bridge-manager.ts'),
  },
  {
    source: path.join(projectRoot, 'patches', 'claude-to-im', 'feishu-adapter.ts'),
    target: path.join(projectRoot, 'node_modules', 'claude-to-im', 'src', 'lib', 'bridge', 'adapters', 'feishu-adapter.ts'),
  },
  {
    source: path.join(projectRoot, 'patches', 'claude-to-im', 'discord-adapter.ts'),
    target: path.join(projectRoot, 'node_modules', 'claude-to-im', 'src', 'lib', 'bridge', 'adapters', 'discord-adapter.ts'),
  },
];

let applied = 0;

for (const patch of patches) {
  if (!fs.existsSync(patch.source) || !fs.existsSync(patch.target)) {
    continue;
  }
  const source = fs.readFileSync(patch.source, 'utf-8');
  const current = fs.readFileSync(patch.target, 'utf-8');
  if (source === current) {
    continue;
  }
  fs.copyFileSync(patch.source, patch.target);
  applied += 1;
}

if (applied > 0) {
  console.log(`Applied ${applied} bridge patch${applied === 1 ? '' : 'es'}.`);
}

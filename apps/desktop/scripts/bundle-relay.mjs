/**
 * Bundles the relay server into a single CJS file for production packaging.
 * Run before packaging: node scripts/bundle-relay.mjs
 * Dependencies: esbuild (devDep), pre-built apps/server/dist/
 */
import { build } from 'esbuild';
import { cpSync, copyFileSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { resolve, join, sep, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const serverRoot = join(repoRoot, 'apps/server');
const outDir = join(__dirname, '../resources/relay');
const pnpmDir = join(repoRoot, 'node_modules/.pnpm');

const serverEntry = join(serverRoot, 'dist/index.js');
if (!existsSync(serverEntry)) {
  console.error('ERROR: apps/server/dist/index.js not found.');
  console.error('Run: pnpm --filter @remotebridge/server build');
  process.exit(1);
}

mkdirSync(join(outDir, 'node_modules'), { recursive: true });
console.log('Bundling relay server...');

await build({
  entryPoints: [serverEntry],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: join(outDir, 'bundle.js'),
  external: ['better-sqlite3'],
  logLevel: 'warning',
});
console.log('  ✓ bundle.js');

// Copy better-sqlite3 JS files only (no native binary, no nested node_modules)
const bsq3Src = join(pnpmDir, 'better-sqlite3@9.6.0/node_modules/better-sqlite3');
const bsq3Dst = join(outDir, 'node_modules/better-sqlite3');
mkdirSync(bsq3Dst, { recursive: true });
cpSync(bsq3Src, bsq3Dst, {
  recursive: true,
  filter: (src) => {
    const rel = src.slice(bsq3Src.length);
    if (rel.startsWith(`${sep}build`) || rel.includes('.node')) return false;
    if (rel.length > 0 && rel.startsWith(`${sep}node_modules`)) return false;
    return true;
  },
});
// Minimal package.json (the real one references build/ which we omit)
writeFileSync(join(bsq3Dst, 'package.json'), JSON.stringify(
  { name: 'better-sqlite3', version: '9.6.0', main: 'lib/index.js' }, null, 2
));
console.log('  ✓ node_modules/better-sqlite3 (JS only)');

// Copy bindings (pure JS, better-sqlite3's native-loading helper)
const bindingsSrc = join(pnpmDir, 'bindings@1.5.0/node_modules/bindings');
cpSync(bindingsSrc, join(outDir, 'node_modules/bindings'), { recursive: true });
console.log('  ✓ node_modules/bindings');

// Copy file-uri-to-path (bindings dependency)
const futpSrc = join(pnpmDir, 'file-uri-to-path@1.0.0/node_modules/file-uri-to-path');
cpSync(futpSrc, join(outDir, 'node_modules/file-uri-to-path'), { recursive: true });
console.log('  ✓ node_modules/file-uri-to-path');

// Copy wrapper.js (production entry point for utilityProcess.fork)
copyFileSync(
  join(__dirname, '../resources/relay-wrapper.js'),
  join(outDir, 'wrapper.js')
);
console.log('  ✓ wrapper.js');

// Write a minimal package.json into the relay dir so bundle.js can resolve its version
// (bundle's __dirname = resources/relay/, server reads join(__dirname, '../package.json')
//  which fails when packaged; fallback reads join(__dirname, 'package.json') = this file)
const { version: relayVersion } = JSON.parse(readFileSync(join(serverRoot, 'package.json'), 'utf-8'));
writeFileSync(join(outDir, 'package.json'), JSON.stringify({ name: 'relay-server', version: relayVersion }, null, 2));
console.log(`  ✓ package.json (v${relayVersion})`);

console.log('\nRelay bundle ready at:', outDir);

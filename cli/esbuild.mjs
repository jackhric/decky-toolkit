import * as esbuild from 'esbuild';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export const options = {
  entryPoints: ['src/cli.ts'],
  bundle: true,
  outfile: 'dist/cli.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  define: { CLI_VERSION: JSON.stringify(pkg.version) },
  logLevel: 'info',
};

// `decky-toolkit/tools`, which plugins bundle into their frontend; Steam's CEF is Chrome 126.
export const toolsOptions = {
  entryPoints: ['src/tools.ts'],
  bundle: true,
  outfile: 'dist/tools.js',
  platform: 'browser',
  format: 'esm',
  target: 'chrome126',
  logLevel: 'info',
};

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  await Promise.all([esbuild.build(options), esbuild.build(toolsOptions)]);
}

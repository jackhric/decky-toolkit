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

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) await esbuild.build(options);

import * as esbuild from 'esbuild';

const opts = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  await (await esbuild.context(opts)).watch();
} else {
  await esbuild.build(opts);
}

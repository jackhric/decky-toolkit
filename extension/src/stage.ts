import { promises as fs } from 'fs';
import * as path from 'path';
import { createZip, ZipEntry } from './zip';

// What decky-plugin-template ships; backend/ (sources for bin/), src/ and tests stay behind.
export const PLUGIN_FILES = [
  'dist', 'plugin.json', 'package.json', 'main.py', 'LICENSE', 'README.md',
  'defaults', 'py_modules', 'static', 'bin', 'assets',
];
const SKIP = new Set(['__pycache__', 'node_modules', '.git']);
const skipped = (name: string) => SKIP.has(name) || name.endsWith('.pyc');

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true, () => false);
}

async function walk(abs: string, rel: string, out: ZipEntry[]): Promise<void> {
  const st = await fs.stat(abs);
  if (st.isDirectory()) {
    out.push({ name: rel + '/', mtime: st.mtime });
    for (const child of (await fs.readdir(abs)).sort()) {
      if (skipped(child)) continue;
      await walk(path.join(abs, child), `${rel}/${child}`, out);
    }
  } else if (st.isFile()) {
    out.push({ name: rel, data: await fs.readFile(abs), mtime: st.mtime, mode: 0o100000 | (st.mode & 0o111 ? 0o755 : 0o644) });
  }
}

/** Zip with `<dirName>/` as the single top-level directory, as `POST /plugins/install` expects. */
export async function stagePlugin(root: string, dirName: string): Promise<{ zip: Buffer; files: string[] }> {
  if (!(await exists(path.join(root, 'plugin.json')))) throw new Error(`${root} has no plugin.json`);
  if (!(await exists(path.join(root, 'dist')))) throw new Error(`${root}/dist is missing; did the build run?`);
  const entries: ZipEntry[] = [{ name: dirName + '/' }];
  const files: string[] = [];
  for (const name of PLUGIN_FILES) {
    const abs = path.join(root, name);
    if (!(await exists(abs))) continue;
    files.push(name);
    await walk(abs, `${dirName}/${name}`, entries);
  }
  return { zip: createZip(entries), files };
}

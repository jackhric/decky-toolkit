import { promises as fs } from 'fs';
import * as path from 'path';
import { deployPlugin, readWorkspacePlugin } from '@decky-toolkit/client/deploy';
import { LIVE_API_VERSION, LiveSync, startWatchBuild, stopWatchBuild, watchPlugin } from '@decky-toolkit/client/live';
import { explain, pairedClient } from './device';

// Per-build chatter from vite and rollup; errors, warnings and the "built"/"created" lines still show.
const BUILD_NOISE = /^(build started|transforming|rendering chunks|computing gzip size|✓ \d+ modules transformed|watching for file changes|bundles .* → |dist\/\S+\s+[\d.]+ kB)/;

const FIRST_BUILD_DONE = /built in|created .* in|waiting for changes|error/i;

async function waitForFile(file: string, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 250))) {
    if (await fs.stat(file).then(() => true, () => false)) return true;
  }
  return false;
}

/** Deploy once, then keep the device in step with the plugin folder until Ctrl-C. */
export async function dev(dir: string, build: boolean, out: (l: string) => void, err: (l: string) => void): Promise<number> {
  const root = path.resolve(dir);
  const [p, { file, client }] = await Promise.all([readWorkspacePlugin(root), pairedClient()]);
  if (!p) throw new Error(`${root} has no readable plugin.json`);
  const health = await client.health();
  if (health.api_version < LIVE_API_VERSION) {
    err(`The Decky Toolkit plugin on ${file.device.host} (${health.version}) has no live sync yet; update it on the device, then run dev again.`);
    return 1;
  }

  // Deploy only after the first build: otherwise the device gets the old bundle while the sync records the new one.
  let firstBuild!: () => void;
  const built = new Promise<void>(r => { firstBuild = r; });
  const builder = build ? await startWatchBuild(root, line => {
    if (FIRST_BUILD_DONE.test(line)) firstBuild();
    if (!BUILD_NOISE.test(line.trim())) out(`build: ${line}`);
  }) : undefined;
  if (build && !builder) out('No "watch" script in package.json: run your build in watch mode yourself.');
  if (builder) await Promise.race([built, new Promise(r => setTimeout(r, 120000))]);
  if (!await waitForFile(path.join(root, 'dist', 'index.js'), 60000)) {
    err('dist/index.js did not appear within 60 s; is the build running?');
    if (builder) stopWatchBuild(builder);
    return 1;
  }

  let installedDir = p.dir;
  const fullDeploy = async () => {
    const s = await deployPlugin(client, p, { log: l => out(l), matchInstalledByName: true });
    installedDir = s.dir;
    out(`Deployed ${p.name} as ${s.dir} in ${(s.totalMs / 1000).toFixed(1)} s`);
  };
  try {
    await fullDeploy();
  } catch (e) {
    err(`Deploy failed: ${explain(e, file.device)}`);
    if (builder) stopWatchBuild(builder);
    return 1;
  }

  const sync = new LiveSync(client, { ...p, dir: installedDir }, { log: out, fullDeploy });
  await sync.seed();
  const watcher = watchPlugin(root, rel => sync.notify(rel));
  out(`Watching ${root} → ${file.device.host}:${installedDir}. Edit away; Ctrl-C to stop.`);

  return new Promise<number>(resolve => {
    const stop = () => {
      watcher.close();
      sync.dispose();
      if (builder) stopWatchBuild(builder);
      resolve(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    builder?.once('exit', code => {
      if (code) err(`The watch build exited with code ${code}.`);
    });
  });
}

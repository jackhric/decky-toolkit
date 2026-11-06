import assert from 'assert/strict';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import * as path from 'path';
import {
  actionsProvider, actionsTree, calls, check, configEmitter, device, ext, fetched, files, lastMessage, makePlugin,
  openWorkspace, output, plugins, put, RelativePattern, root, run, scratch, setMtime, setPlugins, settings, settle,
  status, statusButton, ui, Uri,
} from './harness.mjs';

await check('plugin detection: skeleton with and without the debug flag, depth <= 2, node_modules skipped', async () => {
  const ws = path.join(scratch, 'detect');
  makePlugin(path.join(ws, 'plain'), { name: 'Plain' });
  makePlugin(path.join(ws, 'group', 'debugged'), { name: 'Debugged', flags: ['debug', '_root'], version: '0.0.1' });
  makePlugin(path.join(ws, 'a', 'b', 'too-deep'), { name: 'Too Deep' });
  makePlugin(path.join(ws, 'node_modules', 'dep'), { name: 'Dependency' });
  makePlugin(path.join(ws, 'plain', 'py_modules', 'inner'), { name: 'Inner' });
  const roots = await ext.findPluginRoots(ws, 2);
  assert.deepEqual(roots.map(r => path.relative(ws, r)), [path.join('group', 'debugged'), 'plain']);
  const [debugged, plain] = await Promise.all(roots.map(r => ext.readWorkspacePlugin(r)));
  assert.deepEqual({ ...plain, root: undefined }, {
    root: undefined, name: 'Plain', author: 'me', flags: [], apiVersion: 1, version: '1.2.3', dir: 'plain', hasBackend: true, hasDebugFlag: false,
  });
  assert.equal(debugged.hasDebugFlag, true);
  assert.equal(debugged.dir, 'debugged');
  assert.equal(debugged.version, '0.0.1');
  assert.equal((await ext.readWorkspacePlugin(roots[1], ' custom-dir ')).dir, 'custom-dir');
  assert.equal(await ext.findPluginRoots(path.join(ws, 'plain'), 2).then(r => r.length), 1, 'a workspace that is the plugin');
  return `found ${roots.map(r => path.relative(ws, r)).join(', ')}; debug flag ${debugged.hasDebugFlag}/${plain.hasDebugFlag}`;
});

await check('build mode decisions: auto builds only when src/ is newer than dist/index.js', async () => {
  const root = makePlugin(path.join(scratch, 'build'));
  const decide = async mode => (await ext.buildDecision(root, mode));
  setMtime(root, 'src/index.tsx', 60);
  setMtime(root, 'dist/index.js', 30);
  assert.deepEqual(await decide('auto'), { build: false, reason: 'dist/index.js is up to date' });
  setMtime(root, 'main.py', 0);
  put(root, 'py_modules/lib.py', 'x = 1\n');
  assert.equal((await decide('auto')).build, false, 'Python changes never need a build');
  setMtime(root, 'src/index.tsx', 0);
  assert.deepEqual(await decide('auto'), { build: true, reason: 'src is newer than dist/index.js' });
  assert.equal((await decide('never')).build, false);
  setMtime(root, 'src/index.tsx', 60);
  assert.equal((await decide('always')).build, true);
  writeFileSync(path.join(root, 'dist/index.js'), '');
  execFileSync('rm', [path.join(root, 'dist/index.js')]);
  assert.deepEqual(await decide('auto'), { build: true, reason: 'dist/index.js is missing' });
  put(root, 'package.json', '{"version":"1.0.0"}');
  assert.equal((await decide('always')).build, false, 'no build script, nothing to run');
  assert.equal(await ext.packageManager(root), 'pnpm');
  const npm = makePlugin(path.join(scratch, 'npm'), { lock: 'package-lock.json' });
  assert.equal(await ext.packageManager(npm), 'npm');
  const none = makePlugin(path.join(scratch, 'nolock'), { lock: null });
  assert.equal(await ext.packageManager(none), 'pnpm');
  return 'up to date → skip, main.py/py_modules newer → skip, src newer → build, dist missing → build, never/always, no script → skip; pnpm/npm by lockfile';
});

await check('staging per skeleton: shipped files, skipped sources and caches, bin exec bit', async () => {
  const root = makePlugin(path.join(scratch, 'stage'), { flags: ['debug'] });
  for (const rel of ['LICENSE', 'README.md', 'defaults/defaults.txt', 'static/x.css', 'assets/logo.png', 'py_modules/lib/__init__.py',
    'backend/src/main.c', 'backend/Makefile', 'tests/test_x.py', 'node_modules/dep/index.js', '.git/HEAD', '.vscode/tasks.json',
    'py_modules/lib/__pycache__/x.cpython-314.pyc', 'py_modules/stale.pyc', 'py_modules/node_modules/x.js', 'decky.pyi', 'rollup.config.js']) put(root, rel, 'x');
  put(root, 'bin/tool', '#!/bin/sh\necho hi\n', 0o755);
  const { zip, files } = await ext.stagePlugin(root, 'my-plugin');
  const file = path.join(scratch, 'stage.zip');
  writeFileSync(file, zip);
  const listing = execFileSync('unzip', ['-Z1', file]).toString().trim().split('\n');
  const tops = [...new Set(listing.map(l => l.split('/')[1]).filter(Boolean))].sort();
  assert.deepEqual(tops, ['LICENSE', 'README.md', 'assets', 'bin', 'defaults', 'dist', 'main.py', 'package.json', 'plugin.json', 'py_modules', 'static']);
  assert.deepEqual(files, ['dist', 'plugin.json', 'package.json', 'main.py', 'LICENSE', 'README.md', 'defaults', 'py_modules', 'static', 'bin', 'assets']);
  for (const bad of ['__pycache__', '.pyc', 'node_modules', 'backend', '/src/', 'tests', '.git', '.vscode']) {
    assert.ok(!listing.some(l => l.includes(bad)), `${bad} shipped: ${listing.filter(l => l.includes(bad))}`);
  }
  const perms = execFileSync('unzip', ['-Z', file, 'my-plugin/bin/tool']).toString();
  assert.match(perms, /^-rwxr-xr-x/, perms);
  return `${listing.length} entries: ${tops.join(' ')}; bin/tool -rwxr-xr-x`;
});

await check('detected plugin: Plugin group "<name> v<version>", dir in tooltip, one prompt, status bar button', async () => {
  const root = makePlugin(path.join(scratch, 'ws', 'my-plugin'));
  calls.messages.length = 0;
  assert.equal(statusButton()?.visible ?? false, false, 'no button without a plugin');
  await openWorkspace(path.join(scratch, 'ws'));
  const prompts = () => calls.messages.filter(m => m.m.startsWith('Decky plugin detected'));
  assert.deepEqual(prompts().map(m => [m.m, m.buttons]), [['Decky plugin detected: My Plugin. Deploy to 10.1.2.3?', ['Deploy', 'Not now']]]);
  const { roots, kids } = await actionsTree();
  assert.equal(roots[1].description, 'My Plugin v1.2.3');
  assert.match(roots[1].tooltip, new RegExp(`from ${root}, deployed to ~/homebrew/plugins/my-plugin$`));
  for (const c of kids.Plugin) assert.equal(c.description, undefined);
  const b = statusButton();
  assert.equal(b.visible, true);
  assert.equal(b.text, '$(rocket) Deploy My Plugin');
  assert.equal(b.command, 'decky-toolkit.deploy');
  fetched.length = 0;
  const reload = kids.Plugin[2];
  await run(reload.command.command, ...reload.command.arguments);
  assert.ok(fetched.includes('/plugins/my-plugin/reload'), fetched.join(', '));
  assert.deepEqual(device.liveReloads.at(-1), { dir: 'my-plugin', mode: 'backend' });
  assert.equal(lastMessage('info').m, 'Decky Toolkit: reloaded my-plugin.');
  await openWorkspace(path.join(scratch, 'ws'));
  assert.equal(prompts().length, 1, 'the prompt shows once per session');
  return `Plugin (${roots[1].description}); prompt "${prompts()[0].m}" [${prompts()[0].buttons.join(', ')}]; status bar "${b.text}"`;
});

await check('Deploy: first install restarts the loader, then fast deploys reload only the plugin', async () => {
  device.installs.length = 0;
  let duringDeploy;
  ui.onProgress = () => { duringDeploy = statusButton().text; };
  await run('decky-toolkit.deploy');
  assert.equal(device.installs.at(-1).restart, 'loader', 'not installed yet');
  assert.match(lastMessage('info').m, /^Decky Toolkit: Deployed My Plugin in \d+\.\d s \(loader restarted\)\.$/);
  assert.equal(duringDeploy, '$(sync~spin) Deploying My Plugin');
  assert.equal(statusButton().text, '$(rocket) Deploy My Plugin');
  calls.output.length = 0;
  await run('decky-toolkit.deploy');
  assert.equal(device.installs.at(-1).restart, 'plugin');
  const first = lastMessage('info').m;
  assert.match(first, /^Decky Toolkit: Deployed My Plugin in \d+\.\d s\.$/);
  assert.match(output(), /Build skipped: build mode "never"/);
  assert.match(output(), /Reload confirmed: loader imported My Plugin v1\.2\.3; backend: \[INFO\]: My Plugin started #2/);
  await run('decky-toolkit.deployFull');
  assert.equal(device.installs.at(-1).restart, 'loader');
  assert.match(lastMessage('info').m, /\(loader restarted\)/);
  return `${device.installs.map(i => i.restart).join(' → ')}; "${first}"`;
});

await check('Deploy with the debug flag: restart=none, waits for the watcher reloads to settle', async () => {
  const root = path.join(scratch, 'ws', 'my-plugin');
  put(root, 'plugin.json', JSON.stringify({ name: 'My Plugin', author: 'me', flags: ['debug'], api_version: 1 }));
  await openWorkspace(path.join(scratch, 'ws'));
  calls.output.length = 0;
  const t0 = Date.now();
  await run('decky-toolkit.deploy');
  assert.equal(device.installs.at(-1).restart, 'none');
  assert.match(output(), /debug flag set: waiting for the loader's file watcher/);
  assert.match(output(), /Reload confirmed: loader imported My Plugin v1\.2\.3 \(2 reloads\)/);
  assert.ok(Date.now() - t0 >= 1500, 'waited for the reloads to settle');
  assert.match(lastMessage('info').m, /^Decky Toolkit: Deployed My Plugin in \d+\.\d s\.$/);
  return lastMessage('info').m;
});

await check('a failing build fails the deploy with its error line, nothing is uploaded', async () => {
  const root = path.join(scratch, 'ws', 'my-plugin');
  put(root, 'package.json', JSON.stringify({ version: '1.2.3', scripts: { build: `node -e "console.error('src/index.tsx(3,1): error TS1005: oops'); process.exit(2)"` } }));
  execFileSync('rm', ['-f', path.join(root, 'pnpm-lock.yaml')]);
  put(root, 'package-lock.json', '{}');
  settings['deploy.build'] = 'always';
  const installs = device.installs.length;
  let shown;
  ui.error = (m, buttons) => { shown = { m, buttons }; };
  await run('decky-toolkit.deploy');
  assert.match(shown.m, /^Decky Toolkit deploy failed: build failed: npm run build exited with code 2: src\/index\.tsx\(3,1\): error TS1005: oops$/);
  assert.deepEqual(shown.buttons, ['Show output']);
  assert.equal(device.installs.length, installs);
  assert.match(output(), /\$ npm run build/);
  return shown.m;
});

await check('auto-deploy on change: toggle leaf, watchers, one debounced deploy without a build', async () => {
  const root = path.join(scratch, 'ws', 'my-plugin');
  await run('decky-toolkit.toggleAutoDeploy');
  assert.equal(settings['deploy.onChange'], true);
  const plugin = (await actionsProvider().getChildren())[1];
  const toggle = (await actionsProvider().getChildren(plugin))[4];
  assert.equal(toggle.label, 'Auto-deploy on change: On');
  assert.equal(toggle.iconPath.id, 'sync');
  const live = calls.watchers.filter(w => w.pattern instanceof RelativePattern && !w.disposed);
  assert.deepEqual(live.map(w => [w.pattern.base.fsPath, w.pattern.pattern]),
    [[root, '{dist/**,py_modules/**,assets/**,defaults/**,main.py,plugin.json,package.json}']]);
  const installs = device.installs.length;
  calls.statusMessages.length = 0;
  live[0].fire();
  live[0].fire();
  await settle(200);
  live[0].fire();
  await settle(ext.AUTO_DEPLOY_DEBOUNCE_MS + 2500);
  assert.equal(device.installs.length, installs + 1, 'one deploy for a burst of changes');
  const deployed = calls.statusMessages.at(-1);
  assert.match(deployed, /^\$\(check\) Deployed My Plugin in \d+\.\d s$/);
  await run('decky-toolkit.toggleAutoDeploy');
  assert.equal(settings['deploy.onChange'], false);
  assert.ok(live.every(w => w.disposed), 'watchers disposed when turned off');
  return `3 changes → 1 install (restart=${device.installs.at(-1).restart}, build skipped despite deploy.build=always); "${deployed}"`;
});

await check('auto-deploy on a device with live sync: first change deploys, later ones push and reload in place', async () => {
  const root = path.join(scratch, 'ws', 'my-plugin');
  device.filePuts = [];
  device.liveReloads = [];
  mkdirSync(path.join(root, 'dist'), { recursive: true });
  writeFileSync(path.join(root, 'dist', 'index.js'), 'export default 1;\n');
  await run('decky-toolkit.toggleAutoDeploy');
  const watcher = calls.watchers.filter(w => w.pattern instanceof RelativePattern && !w.disposed)[0];
  const installs = device.installs.length;
  watcher.fire(Uri.file(path.join(root, 'dist', 'index.js')));
  await settle(ext.AUTO_DEPLOY_DEBOUNCE_MS + 2500);
  assert.equal(device.installs.length, installs + 1, 'the first change deploys');
  assert.match(output(), /Live sync on for My Plugin/);
  writeFileSync(path.join(root, 'dist', 'index.js'), 'export default 2;\n');
  watcher.fire(Uri.file(path.join(root, 'dist', 'index.js')));
  writeFileSync(path.join(root, 'dist', 'index.js.map'), '{}');
  watcher.fire(Uri.file(path.join(root, 'dist', 'index.js.map')));
  await settle(400);
  assert.equal(device.installs.length, installs + 1, 'no second install');
  assert.deepEqual(device.filePuts.map(f => f.path), ['dist/index.js', 'dist/index.js.map']);
  assert.deepEqual(device.liveReloads, [{ dir: 'my-plugin', mode: 'frontend' }]);
  const status = calls.statusMessages.at(-1);
  assert.match(status, /^\$\(check\) Decky: reloaded My Plugin \(frontend\) in \d+ ms$/);
  writeFileSync(path.join(root, 'plugin.json'), JSON.stringify({ name: 'My Plugin', author: 'me', flags: [], api_version: 1, x: 1 }));
  watcher.fire(Uri.file(path.join(root, 'plugin.json')));
  await settle(ext.AUTO_DEPLOY_DEBOUNCE_MS + 2500);
  assert.equal(device.installs.length, installs + 2, 'a manifest change deploys in full');
  await run('decky-toolkit.toggleAutoDeploy');
  return `deploy, then push ${device.filePuts.map(f => f.path).join(' + ')} and a frontend reload ("${status}"), plugin.json → deploy`;
});

await check('decky-toolkit.pluginDirName names a first install; an installed plugin of the same name keeps its dir', async () => {
  settings.pluginDirName = 'other-dir';
  configEmitter.fire({ affectsConfiguration: s => s === 'decky-toolkit.pluginDirName' || s === 'decky-toolkit' });
  await settle(300);
  assert.match((await actionsProvider().getChildren())[1].tooltip, /~\/homebrew\/plugins\/other-dir/);
  settings['deploy.build'] = 'never';
  await run('decky-toolkit.deploy');
  assert.deepEqual([device.installs.at(-1).dir, device.installs.at(-1).restart], ['my-plugin', 'plugin'], 'updated where the device has it');
  const kept = [...plugins];
  setPlugins(plugins.filter(x => x.name !== 'My Plugin'));
  await run('decky-toolkit.deploy');
  assert.deepEqual([device.installs.at(-1).dir, device.installs.at(-1).restart], ['other-dir', 'loader'], 'a first install goes to the setting');
  setPlugins(kept);
  settings.pluginDirName = '';
  await openWorkspace();
  assert.equal(statusButton().visible, false, 'button hidden without a plugin');
  assert.equal((await actionsProvider().getChildren())[1].description, 'no plugin.json in workspace');
  return 'tooltip names other-dir; installed → my-plugin, first install → other-dir; closing the folder hides the button';
});

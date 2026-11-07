import assert from 'assert/strict';
import { createPublicKey } from 'crypto';
import * as http from 'http';
import * as https from 'https';
import { existsSync, readFileSync, statSync } from 'fs';
import { hostname } from 'os';
import * as path from 'path';
import {
  actionsProvider, actionsTree, assertPaired, calls, check, ctx, device, devicesProvider, Disposable, dupes,
  evalWhen, EventEmitter, ext, fetched, games, globalState, health, identityPath, itemMenu, labels, lastMessage,
  orphanGroup, pkg, plugins, pluginsProvider, readIdentityFile, root, run, secrets, seedId, serverPeer, settle,
  status, titleMenu, tree, ui, visibleViews, welcomeFor,
} from './harness.mjs';

await ext.activate(ctx);
await settle();

await check('activate() replaces a screen tab orphaned by an extension host restart', async () => {
  assert.equal(calls.closedTabs.length, 1, 'the orphaned tab is closed');
  assert.deepEqual(orphanGroup.tabs, []);
  assert.equal(calls.panels.length, 1, 'a working screen panel takes its place');
  assert.deepEqual(calls.panels[0].where, { viewColumn: 2, preserveFocus: true }, 'same group; focus stays where it was');
  calls.panels[0].dispose();
  calls.panels.length = 0;
  for (const k of [...calls.context.keys()]) if (k.startsWith('decky-toolkit.screen.')) calls.context.delete(k);
  return 'orphan closed, new panel in column 2 without stealing focus';
});

await check('activate() registers the seven views and the decky: file system', async () => {
  const trees = [...calls.treeViews.map(t => t.id), ...calls.treeProviders.map(t => t.id)].sort();
  assert.deepEqual(trees, ['decky-toolkit.actions', 'decky-toolkit.controllers', 'decky-toolkit.devices', 'decky-toolkit.games', 'decky-toolkit.plugins']);
  assert.deepEqual(calls.fsProviders.map(f => [f.scheme, f.options]), [['decky', { isCaseSensitive: true }]]);
  assert.deepEqual(calls.webviewProviders.map(w => w.id), ['decky-toolkit.preview', 'decky-toolkit.welcome']);
  const declared = pkg.contributes.views['decky-toolkit'].map(v => [v.id, v.name]);
  assert.deepEqual(declared, [
    ['decky-toolkit.welcome', 'Devices'], ['decky-toolkit.devices', 'Devices'], ['decky-toolkit.actions', 'Actions'], ['decky-toolkit.plugins', 'Plugins'], ['decky-toolkit.games', 'Games'],
    ['decky-toolkit.controllers', 'Controllers'], ['decky-toolkit.preview', 'Preview']]);
  const games = pkg.contributes.views['decky-toolkit'].find(v => v.id === 'decky-toolkit.games');
  assert.equal(games.visibility, 'collapsed', 'Games starts collapsed like Plugins and Controllers');
  return `createTreeView(${trees.join(', ')}), registerWebviewViewProvider(decky-toolkit.preview, decky-toolkit.welcome)`;
});

await check('package.json: container, activation, commands, menus, version', async () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'Marketplace and Open VSX accept only major.minor.patch');
  assert.equal(pkg.contributes.configuration.properties['decky-toolkit.host'].default, '', 'no device is preconfigured for new users');
  const container = pkg.contributes.viewsContainers.activitybar[0];
  assert.equal(container.id, 'decky-toolkit');
  assert.equal(container.title, 'Decky');
  assert.equal(readFileSync(path.join(root, container.icon), 'utf8').includes('currentColor'), true);
  for (const v of pkg.contributes.views['decky-toolkit']) assert.ok(pkg.activationEvents.includes(`onView:${v.id}`), v.id);
  assert.equal(pkg.activationEvents.length, 11);
  assert.ok(pkg.activationEvents.includes('onFileSystem:decky'), 'restored decky:// folders activate the extension');
  for (const glob of ['plugin.json', '*/plugin.json', '*/*/plugin.json']) assert.ok(pkg.activationEvents.includes(`workspaceContains:${glob}`), glob);
  assert.deepEqual(pkg.contributes.keybindings, [{ command: 'decky-toolkit.deploy', key: 'ctrl+alt+d', mac: 'cmd+alt+d' }]);
  for (const v of pkg.contributes.views['decky-toolkit']) {
    const want = { 'decky-toolkit.welcome': '!decky-toolkit.hasDevices', 'decky-toolkit.devices': 'decky-toolkit.hasDevices' }[v.id] ?? 'decky-toolkit.link';
    assert.equal(v.when, want, `${v.id} when`);
  }
  const declared = new Set(pkg.contributes.commands.map(c => c.command));
  const registered = new Set(calls.commands.keys());
  for (const id of declared) assert.ok(registered.has(id), `declared but not registered: ${id}`);
  for (const id of registered) assert.ok(declared.has(id), `registered but not declared: ${id}`);
  const menus = Object.values(pkg.contributes.menus).flat();
  for (const m of menus) assert.ok(declared.has(m.command), `menu refers to unknown command ${m.command}`);
  for (const m of menus) evalWhen(m.when, new Map());
  const whens = [...menus.map(m => m.when), ...pkg.contributes.views['decky-toolkit'].map(v => v.when), ...pkg.contributes.viewsWelcome.map(w => w.when)];
  const allowedKeys = new Set(['view', 'viewItem', 'decky-toolkit.connected', 'decky-toolkit.link', 'false', 'activeWebviewPanelId',
    'decky-toolkit.hasDevices', 'config.decky-toolkit.discovery.enabled',
    'decky-toolkit.screen.live', 'decky-toolkit.screen.input', 'decky-toolkit.screen.audio', 'decky-toolkit.screen.muted', 'decky-toolkit.screen.paused']);
  for (const w of whens.filter(Boolean)) {
    for (const [, key] of w.replace(/\/(?:\\.|[^/])+\//g, '/re/').matchAll(/(?:^|&&|\|\||\(|!)\s*([A-Za-z][\w.-]*)/g)) assert.ok(allowedKeys.has(key), `context key ${key} in ${w}`);
  }
  const lostViews = ['decky-toolkit.actions', 'decky-toolkit.plugins', 'decky-toolkit.games', 'decky-toolkit.controllers'];
  assert.deepEqual([...new Set(pkg.contributes.viewsWelcome.map(w => w.view))],
    ['decky-toolkit.controllers', ...lostViews.filter(v => !v.endsWith('controllers')), 'workbench.explorer.emptyView']);
  assert.deepEqual(welcomeFor('workbench.explorer.emptyView', new Map()).map(t => t.split('\n').at(-1)), ['[New Decky Plugin](command:decky-toolkit.newPlugin)'],
    'an empty window offers to create a plugin');
  for (const view of lostViews) {
    for (const link of ['connecting', 'unreachable', 'rejected', 'disconnected']) {
      const shown = welcomeFor(view, new Map([['decky-toolkit.link', link]]));
      assert.equal(shown.length, 1, `${view} ${link}: exactly one welcome`);
      if (link !== 'connecting') assert.match(shown[0], /\[(Reconnect|Reconnect now|Re-pair)\]\(command:decky-toolkit\.reconnect\)$/, `${view} ${link}`);
    }
    assert.deepEqual(welcomeFor(view, new Map([['decky-toolkit.link', 'connected']])).filter(t => /device/.test(t) && !/controllers/.test(t)), [], `${view} connected: no lost-connection text`);
  }
  assert.deepEqual(Object.keys(pkg.contributes.configuration.properties).sort(),
    ['decky-toolkit.deploy.build', 'decky-toolkit.deploy.onChange', 'decky-toolkit.deploy.watchBuild', 'decky-toolkit.discovery.enabled', 'decky-toolkit.host', 'decky-toolkit.mcpPort', 'decky-toolkit.openScreenOnConnect', 'decky-toolkit.pluginDirName', 'decky-toolkit.port']);
  assert.equal(pkg.contributes.configuration.properties['decky-toolkit.mcpPort'].default, 8766);
  assert.doesNotMatch(JSON.stringify(pkg.contributes), /\btoken\b|TLS|certificate|encrypted/i, 'user-facing strings name no mechanism');
  assert.deepEqual(pkg.contributes.configuration.properties['decky-toolkit.deploy.build'].enum, ['auto', 'always', 'never']);
  assert.equal(pkg.contributes.configuration.properties['decky-toolkit.deploy.build'].default, 'auto');
  assert.equal(pkg.contributes.configuration.properties['decky-toolkit.deploy.onChange'].default, false);
  assert.equal(pkg.contributes.configuration.properties['decky-toolkit.openScreenOnConnect'].default, true);
  const titles = {
    'decky-toolkit.devices': ['decky-toolkit.addDevice', 'decky-toolkit.refresh'],
    'decky-toolkit.actions': ['decky-toolkit.openScreen', 'decky-toolkit.refresh'],
    'decky-toolkit.plugins': ['decky-toolkit.installZip', 'decky-toolkit.refreshPlugins'],
    'decky-toolkit.games': ['decky-toolkit.findGame', 'decky-toolkit.openDeckyPath', 'decky-toolkit.refreshGames'],
    'decky-toolkit.controllers': ['decky-toolkit.addVirtualController', 'decky-toolkit.refreshControllers'],
    'decky-toolkit.preview': ['decky-toolkit.openScreen'],
  };
  for (const [view, want] of Object.entries(titles)) assert.deepEqual(titleMenu(view), want, `${view} title`);
  for (const view of Object.keys(titles)) {
    for (const viewItem of ['plugin', 'deck.unpaired', 'deck.paired', 'deck.session', 'deck.busy', 'deck.found', 'discovery.group', 'discovery.add', 'action', 'group.screen', 'controller.virtual', 'controller.physical',
      'game', 'game.running', 'deckyDir', 'deckyFile', 'gameGroup', 'gameLog']) {
      for (const inline of [true, false]) assert.deepEqual(dupes(itemMenu(view, viewItem, inline)), [], `${view} ${viewItem}`);
    }
  }
  assert.deepEqual(visibleViews(new Map()), ['decky-toolkit.welcome'], 'before activation only the Add a device welcome shows');
  return `${declared.size} commands registered, ${menus.length} menu entries resolve, titles ${Object.values(titles).map(t => t.length).join('/')}`;
});

await check('first activation seeds one saved device from the settings', async () => {
  const list = globalState.get('decky-toolkit.devices');
  assert.equal(list.length, 1);
  assert.equal(list[0].host, '10.1.2.3');
  assert.equal(globalState.get('decky-toolkit.activeDevice'), list[0].id);
  return JSON.stringify({ name: list[0].name, host: list[0].host, port: list[0].port });
});

await check('unpaired: only Devices visible, one row, Connect inline', async () => {
  assert.equal(calls.context.get('decky-toolkit.connected'), false);
  assert.deepEqual([...calls.context.keys()].sort(), ['decky-toolkit.connected', 'decky-toolkit.hasDevices', 'decky-toolkit.link'], 'the only context keys');
  assert.equal(calls.context.get('decky-toolkit.hasDevices'), true, 'one saved device');
  assert.equal(calls.context.get('decky-toolkit.link'), undefined, 'no link state before the first connect: only Devices shows');
  assert.deepEqual(visibleViews(), ['decky-toolkit.devices']);
  const rows = devicesProvider().getChildren();
  assert.equal(rows.length, 1);
  const [r] = rows;
  assert.equal(r.label, '10.1.2.3', 'name equal to host is shown once');
  assert.equal(r.description, 'v0.2.0 · not paired', 'the version comes from the public /health before pairing');
  assert.equal(r.iconPath.id, 'key');
  assert.equal(r.contextValue, 'deck.unpaired');
  assert.deepEqual(r.command, { command: 'decky-toolkit.connect', title: 'Connect', arguments: [seedId()] });
  assert.deepEqual(itemMenu('decky-toolkit.devices', r.contextValue, true), ['decky-toolkit.connect', 'decky-toolkit.deviceActions']);
  assert.ok(!itemMenu('decky-toolkit.devices', r.contextValue, false).includes('decky-toolkit.pairAgain'));
  assert.deepEqual(await actionsProvider().getChildren(), []);
  assert.deepEqual(await pluginsProvider().getChildren(), []);
  assert.equal(status(), '$(vm) Decky: not connected');
  return `row "${r.label}" — "${r.description}" [$(${r.iconPath.id})], inline ${itemMenu('decky-toolkit.devices', r.contextValue, true).join(', ')}; status "${status()}"`;
});

await check('fake client: plugin tree states, Actions Screen offline when unreachable', async () => {
  const fakeConn = (client, extra = {}) => ({
    devices: [], activeDevice: undefined, address: { host: 'h', port: 1 }, label: 'h', paired: !!client, rejected: false,
    connectedDevice: client ? { id: 'x', name: 'h', host: 'h', port: 1 } : undefined, link: client ? 'connected' : undefined, linkLabel: 'h',
    health: { kind: 'ok', health }, onDidChange: new EventEmitter().event, onDidChangeTarget: new EventEmitter().event,
    onDidReceiveEvent: new EventEmitter().event, authedClient: () => client, watchStats: () => new Disposable(), ...extra,
  });
  const ok = new ext.PluginsTreeProvider(fakeConn({ listPlugins: async () => plugins }));
  assert.deepEqual(labels(await ok.getChildren()), ['Decky Toolkit', 'Tender']);
  const empty = new ext.PluginsTreeProvider(fakeConn({ listPlugins: async () => [] }));
  assert.deepEqual(labels(await empty.getChildren()), ['No plugins installed']);
  const broken = new ext.PluginsTreeProvider(fakeConn({ listPlugins: async () => { throw new Error('boom'); } }));
  const [p] = await broken.getChildren();
  assert.match(p.label, /Could not load plugins: boom/);
  assert.equal(p.command.command, 'decky-toolkit.refreshPlugins');
  const unpaired = new ext.PluginsTreeProvider(fakeConn(undefined));
  assert.deepEqual(await unpaired.getChildren(), []);
  const down = new ext.ActionsTreeProvider(fakeConn({}, { health: { kind: 'unreachable', error: 'cannot reach the device' }, link: 'unreachable' }));
  assert.deepEqual(await down.getChildren(), [], 'unreachable: empty, so the lost-connection welcome shows');
  down.dispose();
  const downPlugins = new ext.PluginsTreeProvider(fakeConn({ listPlugins: async () => plugins }, { link: 'unreachable' }));
  assert.deepEqual(await downPlugins.getChildren(), []);
  return 'list / empty / error placeholder / not connected / unreachable → empty';
});

await check('preview webview: CSP and proxy URL, no secrets', async () => {
  const { provider } = calls.webviewProviders.find(w => w.id === 'decky-toolkit.preview');
  const messages = new EventEmitter();
  const posted = [];
  const webview = { options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: u => u, postMessage: async m => { posted.push(m); return true; }, onDidReceiveMessage: messages.event, _posted: posted };
  const view = { webview, visible: true, onDidChangeVisibility: new EventEmitter().event, onDidDispose: () => new Disposable() };
  await provider.resolveWebviewView(view);
  calls.previewView = view;
  assert.match(webview.html, /default-src 'none'/);
  assert.match(webview.html, /img-src http:\/\/127\.0\.0\.1:\d+ blob:/);
  assert.match(webview.html, /<button id="open" hidden>Open full screen view/, 'not connected yet: the button is hidden');
  assert.match(webview.html, /data-live="false"/);
  assert.ok(!webview.html.includes('PRIVATE KEY') && !webview.html.includes('CERTIFICATE'));
  assert.equal(webview.options.enableScripts, true);
  return 'ok';
});

await check('welcome view: flat logo, Add a device, plugin requirement, pairing walkthrough; shown only without devices', async () => {
  const { provider } = calls.webviewProviders.find(w => w.id === 'decky-toolkit.welcome');
  const messages = new EventEmitter();
  const webview = { options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: u => u, postMessage: async () => true, onDidReceiveMessage: messages.event };
  provider.resolveWebviewView({ webview, visible: true, onDidChangeVisibility: new EventEmitter().event, onDidDispose: () => new Disposable() });
  const html = webview.html;
  assert.match(html, /default-src 'none'; style-src 'nonce-[^']+'; script-src 'nonce-[^']+'/);
  assert.doesNotMatch(html, /https?:\/\/(?!github\.com\/jackhric\/decky-toolkit|www\.w3\.org\/2000\/svg)/, 'nothing loads from the network');
  assert.match(html, /<svg class="mark"[^>]*viewBox="140 140 480 470"/, 'the flat mark is inlined so it takes the theme colour');
  assert.match(html, /<button id="add"[^>]*><svg[^>]*>.*<\/svg>Add a device<\/button>/s);
  assert.match(html, /needs Decky Loader and the <a id="plugin" href="https:\/\/github\.com\/jackhric\/decky-toolkit"/);
  assert.match(html, /How pairing works/);
  const css = html.match(/<style[^>]*>([\s\S]*?)<\/style>/)[1];
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgb|hsl/i, 'colours come from --vscode-* tokens only');

  ui.inputBox = () => undefined;
  messages.fire({ type: 'add' });
  messages.fire({ type: 'plugin' });
  messages.fire({ type: 'pairing' });
  await settle();
  assert.ok(calls.executed.some(([id]) => id === 'decky-toolkit.addDevice'));
  assert.equal(lastMessage('warning').m, 'Replace 10.1.2.3?', 'a device is saved, so Add a device asks to replace it');
  assert.equal(globalState.get('decky-toolkit.devices').length, 1, 'cancelled: nothing changed');
  calls.messages.length = 0;
  assert.equal(calls.opened.at(-1), 'https://github.com/jackhric/decky-toolkit');
  assert.deepEqual(calls.executed.find(([id]) => id === 'workbench.action.openWalkthrough'), ['workbench.action.openWalkthrough', 'jackhric.decky-toolkit#pairing', false]);

  const walk = pkg.contributes.walkthroughs.find(w => w.id === 'pairing');
  assert.deepEqual(walk.steps.map(st => st.id), ['install', 'add', 'approve', 'screen', 'create']);
  assert.match(walk.steps.at(-1).description, /\(command:decky-toolkit\.newPlugin\)$/);
  for (const st of walk.steps) assert.ok(existsSync(path.join(root, st.media.svg)), st.media.svg);
  assert.match(walk.steps[0].description, /jackhric\.github\.io\/decky-toolkit\/decky-toolkit\.zip/);
  assert.equal(calls.context.get('decky-toolkit.hasDevices'), true, 'a saved device shows the tree instead');
  assert.deepEqual(visibleViews(new Map([['decky-toolkit.hasDevices', false]])), ['decky-toolkit.welcome']);
  return 'add → decky-toolkit.addDevice, plugin → GitHub, pairing → walkthrough (5 steps); welcome ⇄ tree on decky-toolkit.hasDevices';
});

await check('Connect on an unpaired device files a pairing request, waits for approval and connects', async () => {
  fetched.length = 0;
  device.pairQueue = ['pending', 'approved'];
  let rowDuringPairing;
  ui.onProgress = () => { rowDuringPairing = devicesProvider().getChildren()[0]; };
  await run('decky-toolkit.connect', seedId());
  await settle();
  assert.equal(fetched.filter(p => p === '/pair/request').length, 1, 'one request');
  assert.equal(fetched.filter(p => p === '/pair/request/req0').length, 2, 'polled until approved');
  assert.ok(!fetched.slice(0, fetched.indexOf('/pair/request')).includes('/stream/stats'), 'not paired, so no pairing check before pairing');
  const { public_key: publicKey, ...rest } = device.pairRequests[0].body;
  assert.deepEqual(rest, { client_name: `VS Code on ${hostname()}`, client_kind: 'vscode' });
  assert.match(publicKey, /^-----BEGIN PUBLIC KEY-----/, 'sends only the public key');
  assert.equal(createPublicKey(publicKey).asymmetricKeyDetails.namedCurve, 'prime256v1');
  const code = device.pairRequests[0].code;
  assert.equal(code, ext.pairingCode(serverPeer.der, createPublicKey(publicKey).export({ type: 'spki', format: 'der' }), 'req0'));
  const prog = calls.progress.at(-1);
  assert.equal(prog.title, 'Decky Toolkit');
  assert.equal(prog.messages[0], `Waiting for approval on 10.1.2.3 · code ${code}. On the device: Quick Access → Decky Toolkit → Approve.`);
  assert.ok(!prog.messages.some(m => /\d+ s\b|120/.test(m)), 'no countdown');
  assert.equal(rowDuringPairing.description, `v0.2.0 · waiting for approval · code ${code}`);
  assert.equal(rowDuringPairing.contextValue, 'deck.busy');
  const stored = assertPaired();
  assert.ok(![...secrets.keys()].some(k => k.startsWith('decky-toolkit.identity:')), 'pairing writes the identity file, not secret storage');
  if (process.platform !== 'win32') assert.equal(statSync(identityPath).mode & 0o777, 0o600);
  assert.deepEqual(readIdentityFile().device, { host: '10.1.2.3', port: 8765, name: '10.1.2.3' }, 'the file mirrors the saved device');
  assert.equal(createPublicKey(stored.key).export({ type: 'spki', format: 'pem' }), publicKey, 'stores the key it sent');
  assert.equal(calls.context.get('decky-toolkit.connected'), true);
  const info = lastMessage('info');
  assert.equal(info.m, 'Decky Toolkit: Paired with 10.1.2.3.');
  assert.deepEqual(info.buttons, ['Open screen', 'Deploy plugin']);
  assert.equal(calls.panels.length, 1, 'openScreenOnConnect opened the screen panel');
  assert.equal(calls.messages.filter(m => m.kind === 'warning' || m.kind === 'error').length, 0, 'no extra prompts');
  return `progress "${prog.title}: ${prog.messages[0]}", then "${info.m}" [${info.buttons.join(', ')}], screen panel opened`;
});

await check('connected: views, device row, titles and status bar', async () => {
  await settle(100);
  assert.deepEqual(visibleViews(), ['decky-toolkit.devices', 'decky-toolkit.actions', 'decky-toolkit.plugins', 'decky-toolkit.games', 'decky-toolkit.controllers', 'decky-toolkit.preview']);
  const [r] = devicesProvider().getChildren();
  assert.equal(r.label, '10.1.2.3');
  assert.equal(r.description, 'v0.2.0 · connected');
  assert.equal(r.iconPath.id, 'vm-connect');
  assert.equal(r.iconPath.color.id, 'testing.iconPassed');
  assert.equal(r.contextValue, 'deck.session');
  assert.equal(r.command, undefined);
  assert.deepEqual(itemMenu('decky-toolkit.devices', r.contextValue, true), ['decky-toolkit.disconnectDevice', 'decky-toolkit.deviceActions']);
  const ctxMenu = itemMenu('decky-toolkit.devices', r.contextValue, false);
  for (const bad of ['decky-toolkit.connect', 'decky-toolkit.pair']) assert.ok(!ctxMenu.includes(bad), `${bad} on a connected device`);
  assert.deepEqual(ctxMenu.filter(m => !/connect/i.test(m)), ['decky-toolkit.renameDevice', 'decky-toolkit.removeDevice'], 'right-click: Disconnect, Rename and Forget only');
  assert.equal(pkg.contributes.commands.find(c => c.command === 'decky-toolkit.removeDevice').title, 'Forget device');
  assert.deepEqual(labels(await pluginsProvider().getChildren()), ['Decky Toolkit', 'Tender']);
  assert.equal(tree('decky-toolkit.actions').view.description, '10.1.2.3');
  assert.equal(tree('decky-toolkit.plugins').view.description, '10.1.2.3');
  assert.equal(calls.previewView.description, '10.1.2.3');
  assert.equal(status(), '$(vm-connect) 10.1.2.3');
  return `row "${r.label}" — "${r.description}" [$(vm-connect) green], inline ${itemMenu('decky-toolkit.devices', r.contextValue, true).join(', ')}; visible ${visibleViews().join(', ')}`;
});

await check('connected, no plugin.json: Actions roots Screen / Plugin / Loader / Steam / MCP with their leaves', async () => {
  const { roots, kids } = await actionsTree();
  const [screen, plugin] = roots;
  assert.equal(screen.description, '30 fps · 19.5 Mbps', 'stats polled because the Actions view is visible');
  assert.match(kids.Screen[1].tooltip, /current frame as a JPEG/);
  assert.equal(plugin.description, 'no plugin.json in workspace');
  assert.equal(kids.Plugin.at(-1).description, undefined, 'New plugin… needs no plugin folder');
  for (const c of kids.Plugin.slice(0, -1)) {
    assert.equal(c.description, 'needs a plugin folder');
    assert.equal(c.iconPath.color.id, 'disabledForeground');
  }
  const lines = roots.map(r => `${r.label}${r.description ? ` (${r.description})` : ''}: ${labels(kids[r.label]).join(', ')}`);
  return lines.join(' | ');
});

await check('Plugin group without plugin.json: clicks explain why, no request', async () => {
  for (const leaf of (await actionsProvider().getChildren((await actionsProvider().getChildren())[1])).filter(l => l.command.command !== 'decky-toolkit.newPlugin')) {
    fetched.length = 0;
    calls.messages.length = 0;
    await run(leaf.command.command, ...(leaf.command.arguments ?? []));
    const w = lastMessage('warning');
    assert.ok(w, `${leaf.label} explained nothing`);
    assert.match(w.m, /no workspace folder contains a plugin\.json/);
    assert.ok(!fetched.some(p => p.startsWith('/plugins/')), `${leaf.label} hit the device`);
  }
  return lastMessage('warning').m;
});

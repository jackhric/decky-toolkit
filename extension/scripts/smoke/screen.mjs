import assert from 'assert/strict';
import * as http from 'http';
import * as path from 'path';
import {
  actionsProvider, actionsTree, answerPicks, calls, check, ctl, ctlPush, ctx, device, ev, evalWhen, evEnd,
  EventEmitter, evPush, evState, ext, fetched, files, frameJpeg, globalState, health, icon, itemMenu, labels,
  lastMessage, loadScreenJs, pkg, plugins, pluginsProvider, run, setPlugins, settings, settle, stats, status,
  steamDeck, titleActions, tree, ui, uiDevice, uiRoutes, Uri, vscode,
} from './harness.mjs';

await check('Screen and MCP leaves: snapshot, MCP URL', async () => {
  ui.saveDialog = opts => opts.defaultUri;
  await run('decky-toolkit.snapshot');
  const dlg = calls.saveDialogs.at(-1);
  assert.match(dlg.defaultUri.toString(), /\/screen-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.jpg$/);
  const w = calls.written.at(-1);
  assert.equal(w.uri, dlg.defaultUri.toString());
  assert.deepEqual([...w.data], [...frameJpeg]);
  assert.match(lastMessage('info').m, /saved .*screen-.*\.jpg/);
  await run('decky-toolkit.copyMcpUrl');
  const secret = globalState.get('decky-toolkit.proxySecret');
  assert.match(calls.clipboard.at(-1), new RegExp(`^http://127\\.0\\.0\\.1:\\d+/${secret}/mcp$`), 'the loopback proxy, not the device');
  assert.ok(Number(new URL(calls.clipboard.at(-1)).port) >= 8766, 'decky-toolkit.mcpPort or the next free port');
  const mcpUrl = calls.clipboard.at(-1);

  assert.match(lastMessage('info').m, /"Write MCP config" is preferred/);

  // Write MCP config: the CLI over stdio (it reads the shared identity file), no URL or headers; other servers are kept.
  const mcpJson = 'file:///ws/.mcp.json';
  vscode.workspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
  try {
    files.set(mcpJson, Buffer.from(JSON.stringify({ mcpServers: { other: { command: 'x' }, decky: { type: 'http', url: 'http://10.1.2.3:8765/mcp', headers: { Authorization: 'Bearer old' } } } })));
    await run('decky-toolkit.writeMcpConfig');
    const written = JSON.parse(Buffer.from(calls.written.at(-1).data).toString());
    assert.equal(calls.written.at(-1).uri, mcpJson);
    assert.deepEqual(written.mcpServers, { other: { command: 'x' }, decky: { command: 'npx', args: ['-y', 'decky-toolkit', 'mcp'] } });
    assert.equal(lastMessage('info').m, 'Decky Toolkit: wrote mcpServers.decky to .mcp.json.');

    // Activation: an entry on another port with our prefix is moved to this window's port; anything else is left alone.
    const moved = mcpUrl.replace(/:\d+\//, ':40999/');
    files.set(mcpJson, Buffer.from(JSON.stringify({ mcpServers: { decky: { type: 'http', url: moved, note: 'kept' } } })));
    const before = calls.written.length;
    await ext.refreshMcpConfig({ proxy: { rebase: async u => (u === moved ? mcpUrl : undefined) } });
    assert.deepEqual(JSON.parse(Buffer.from(calls.written.at(-1).data).toString()).mcpServers.decky, { type: 'http', url: mcpUrl, note: 'kept' });
    files.set(mcpJson, Buffer.from(JSON.stringify({ mcpServers: { decky: { type: 'http', url: 'http://127.0.0.1:40999/someone-else/mcp' } } })));
    await ext.refreshMcpConfig({ proxy: { rebase: async () => undefined } });
    files.set(mcpJson, Buffer.from('not json'));
    await ext.refreshMcpConfig({ proxy: { rebase: async () => mcpUrl } });
    assert.equal(calls.written.length, before + 1, 'unrelated or broken files are not touched');
  } finally {
    files.delete(mcpJson);
    vscode.workspace.workspaceFolders = undefined;
  }
  return `snapshot → ${dlg.defaultUri.path.split('/').pop()} (${w.data.length} B); MCP URL ${mcpUrl.replace(secret, '<secret>')}; .mcp.json runs the CLI; old URL entries re-pointed`;
});

await check('remote input: title action, toggle command, status bar, unavailable', async () => {
  const panel = calls.panels[0];
  const lastState = () => panel._posted.filter(m => m.type === 'input').at(-1)?.state;
  assert.match(panel.webview.html, /connect-src http:\/\/127\.0\.0\.1:(\d+) ws:\/\/127\.0\.0\.1:\1;/);
  assert.doesNotMatch(panel.webview.html, /<header|<button|<select|<input/, 'no controls inside the page');
  assert.equal(pkg.contributes.commands.find(c => c.command === 'decky-toolkit.toggleInput').title, 'Toggle remote input');
  assert.ok(!(await actionsTree()).kids.Screen.some(c => /input/i.test(c.label)), 'no input leaf in the Actions view');

  panel._posted.length = 0;
  panel._received.fire({ type: 'ready' });
  await settle();
  assert.deepEqual(lastState(), { enabled: false });
  assert.equal(calls.context.get('decky-toolkit.screen.input'), 'off');
  assert.ok(titleActions().includes('decky-toolkit.screen.inputOn'));
  assert.equal(icon('decky-toolkit.screen.inputOn'), '$(keyboard)');
  assert.equal(status(), '$(vm-connect) 10.1.2.3');

  fetched.length = 0;
  await run('decky-toolkit.screen.inputOn');
  await settle();
  assert.deepEqual(fetched.filter(f => f === '/input/settings').length, 2, 'GET then PUT');
  assert.equal(device.input.enabled, true);
  assert.deepEqual(lastState(), { enabled: true });
  assert.equal(calls.context.get('decky-toolkit.screen.input'), 'on');
  assert.ok(titleActions().includes('decky-toolkit.screen.inputOff') && !titleActions().includes('decky-toolkit.screen.inputOn'));
  assert.equal(icon('decky-toolkit.screen.inputOff'), '$(record-keys)');
  assert.equal(status(), '$(vm-connect) 10.1.2.3 $(keyboard)');
  assert.match(calls.statusItems[0].tooltip, /remote input on/);
  assert.match(calls.statusMessages.at(-1), /remote input on \(libei\)/);

  await run('decky-toolkit.toggleInput');
  await settle();
  assert.equal(device.input.enabled, false);
  assert.deepEqual(lastState(), { enabled: false }, 'the panel follows a toggle from the palette');
  assert.equal(calls.context.get('decky-toolkit.screen.input'), 'off');

  device.input = { enabled: false, backend: null, available: false, reason: 'no libei socket and /dev/uinput is not writable' };
  await run('decky-toolkit.screen.inputOn');
  await settle();
  assert.match(lastMessage('warning').m, /remote input is unavailable on 10\.1\.2\.3: no libei socket/);
  assert.equal(device.input.enabled, false, 'nothing PUT while unavailable');

  device.input = { enabled: false, backend: 'ei', available: true, reason: null };
  await run('decky-toolkit.refresh');
  await settle(100);
  assert.deepEqual(lastState(), { enabled: false });
  assert.deepEqual(titleActions('markdown.preview'), [], 'actions only on the screen panel');

  // screen.js opens /input only while input is on; a 4003 close asks the extension for the state again.
  const w = loadScreenJs();
  w.post({ type: 'input', state: { enabled: true } });
  const sock = w.sockets.find(s => s.url.endsWith('/input'));
  assert.ok(sock, '/input socket opened');
  sock.onclose({ code: 4003, reason: 'remote input is disabled' });
  assert.deepEqual(w.posted.at(-1), { type: 'refreshInput' });
  assert.equal(w.el('hint').textContent, 'remote input is disabled');
  return 'title keyboard → record-keys while on, $(keyboard) in status bar, palette toggle off, unavailable warning';
});

await check('screen panel: title actions and icons, stream settings QuickPick, mute / volume / pause', async () => {
  const panel = calls.panels[0];
  const audioMsgs = () => panel._posted.filter(m => m.type === 'audio');
  panel._posted.length = 0; fetched.length = 0;
  panel._received.fire({ type: 'ready' });
  await settle();
  assert.ok(fetched.includes('/stream/settings'));
  assert.deepEqual(audioMsgs().at(-1), { type: 'audio', on: true, muted: false, volume: 0.8 });
  assert.deepEqual(titleActions(), ['decky-toolkit.screen.inputOn', 'decky-toolkit.screen.mute', 'decky-toolkit.screen.settings', 'decky-toolkit.screen.pause', 'decky-toolkit.snapshot']);
  assert.deepEqual(titleActions().map(icon), ['$(keyboard)', '$(unmute)', '$(settings-gear)', '$(debug-pause)', '$(device-camera)']);
  assert.ok(pkg.contributes.menus['editor/title'].every(m => m.group.startsWith('navigation@')), 'all inline in the tab bar');

  await run('decky-toolkit.screen.mute');
  assert.deepEqual(audioMsgs().at(-1), { type: 'audio', on: true, muted: true, volume: 0.8 });
  assert.equal(globalState.get('decky-toolkit.screen.muted'), true, 'mute is remembered');
  await run('decky-toolkit.screen.pause');
  assert.deepEqual(panel._posted.filter(m => m.type === 'paused').at(-1), { type: 'paused', paused: true });
  assert.deepEqual(titleActions().map(icon), ['$(keyboard)', '$(mute)', '$(settings-gear)', '$(play)', '$(device-camera)']);
  await run('decky-toolkit.screen.resume');

  let offered = answerPicks('Frame rate', '60 fps');
  await run('decky-toolkit.screen.settings');
  await settle();
  assert.deepEqual(offered[0].labels.map(l => l.replace(/^\$\([^)]+\) /, '')),
    ['Stream · every client', 'Frame rate', 'JPEG quality', 'Size', 'Audio', 'This computer', 'Volume', 'Gamepad goes to']);
  assert.deepEqual(offered[0].descriptions.filter(Boolean), ['30 fps', '70', 'Native', 'On', '80% (muted)', 'Auto']);
  assert.equal(offered[1].descriptions[offered[1].labels.indexOf('30 fps')], 'current');
  assert.deepEqual(device.streamPuts.at(-1), { fps: 60 });
  assert.equal(panel._posted.at(-1).type, 'applying', 'the webview shows "Applying" until the new pipeline sends a frame');

  answerPicks('Volume', '40%');
  await run('decky-toolkit.screen.settings');
  await settle();
  assert.deepEqual(audioMsgs().at(-1), { type: 'audio', on: true, muted: false, volume: 0.4 }, 'a volume pick unmutes');
  assert.equal(globalState.get('decky-toolkit.screen.volume'), 0.4);

  answerPicks('Audio');
  await run('decky-toolkit.screen.settings');
  await settle();
  assert.deepEqual(device.streamPuts.at(-1), { audio: false });
  assert.equal(audioMsgs().at(-1).on, false);
  assert.ok(!titleActions().includes('decky-toolkit.screen.mute'), 'no mute action while the device sends no audio');
  offered = answerPicks();
  await run('decky-toolkit.screen.settings');
  assert.ok(!offered[0].labels.some(l => /Volume/.test(l)));

  // A change made elsewhere arrives with the stats tick.
  stats.settings = { ...stats.settings, audio: true };
  await run('decky-toolkit.refresh');
  await settle(100);
  assert.equal(audioMsgs().at(-1).on, true);
  assert.equal(calls.context.get('decky-toolkit.screen.audio'), true);

  // A device without stream settings: only this computer's choices.
  device.streamSettingsMissing = true;
  panel._received.fire({ type: 'ready' });
  await settle();
  offered = answerPicks();
  await run('decky-toolkit.screen.settings');
  assert.deepEqual(offered[0].labels.map(l => l.replace(/^\$\([^)]+\) /, '')), ['This computer', 'Gamepad goes to']);
  device.streamSettingsMissing = false;
  stats.settings = { fps: 30, quality: 70, width: 0, audio: true };
  panel._received.fire({ type: 'ready' });
  await settle();

  const w = loadScreenJs();
  assert.deepEqual(w.posted.at(-1), { type: 'ready' });
  w.post({ type: 'audio', on: true, muted: true, volume: 0.5 });
  assert.ok(w.sockets.some(s => s.url.endsWith('/audio')), 'audio socket opened');
  assert.equal(w.el('hint').hidden, false);
  assert.equal(w.el('hint').textContent, 'Click the picture to enable audio', 'no running AudioContext yet');
  w.post({ type: 'audio', on: false, muted: true, volume: 0.5 });
  assert.equal(w.el('hint').hidden, true, 'device audio off: no hint');
  w.post({ type: 'paused', paused: true });
  w.post({ type: 'applying' });
  return 'title: keyboard, unmute, settings-gear, debug-pause, device-camera; mute → $(mute), pause → $(play); fps 60 PUT; volume 40% unmutes; audio off hides mute';
});

await check('Controllers view with fake clients: empty, physical + virtual, error', async () => {
  const fakeConn = client => ({ connectedDevice: { id: 'x', name: 'h', host: 'h', port: 1 }, link: 'connected', authedClient: () => client, onDidChange: new EventEmitter().event, onDidChangeTarget: new EventEmitter().event, onDidReceiveEvent: new EventEmitter().event, label: 'h' });
  const treeFor = controllers => new ext.ControllersTreeProvider(new ext.ControllerWatcher(fakeConn({ controllers })));

  assert.deepEqual(await treeFor(async () => ({ controllers: [], virtual: [], input_enabled: false })).getChildren(), [], 'empty → welcome');
  const welcome = pkg.contributes.viewsWelcome.find(w => w.view === 'decky-toolkit.controllers').contents;
  assert.equal(welcome, 'No controllers seen by Steam Input.\n[Add virtual controller](command:decky-toolkit.addVirtualController)');

  const list = {
    controllers: [
      steamDeck,
      { id: 'evdev:v1', name: 'Virtual pad 1', kind: 'virtual', virtual_id: 'v1', vendor: '045e', product: '028e', device: '/dev/input/event12', steam: { type: 'xbox360', slot: 1, name: 'Xbox 360 Controller' } },
      { id: 'evdev:8bd', name: '8BitDo Pro 2', kind: 'physical', virtual_id: null, vendor: '2dc8', product: '6003', device: '/dev/input/event7', steam: null },
    ],
    virtual: [{ id: 'v1', name: 'Virtual pad 1', type: 'x360', auto: false }, { id: 'v2', name: 'Couch', type: 'x360', auto: false }],
    input_enabled: true,
  };
  const rows = await treeFor(async () => list).getChildren();
  assert.deepEqual(rows.map(r => [r.label, r.description]), [
    ['1. Steam Deck', 'physical · Steam Input: steamdeck · Slot 1'],
    ['2. Virtual pad 1', 'virtual · Steam Input: xbox360 · Slot 2'],
    ['8BitDo Pro 2', 'physical · not seen by Steam Input'],
    ['Couch (virtual)', 'virtual · not seen by Steam Input'],
  ]);
  assert.deepEqual(rows.map(r => [r.iconPath.id, r.iconPath.color?.id]), [['game', undefined], ['game', 'charts.blue'], ['game', undefined], ['game', 'charts.blue']]);
  assert.deepEqual(rows.map(r => r.virtualId), [undefined, 'v1', undefined, 'v2']);
  const ctx = new Map([['decky-toolkit.connected', true]]);
  const inline = r => pkg.contributes.menus['view/item/context'].filter(m => m.group.startsWith('inline') && evalWhen(m.when, new Map([...ctx, ['view', 'decky-toolkit.controllers'], ['viewItem', r.contextValue]]))).map(m => m.command);
  assert.deepEqual(rows.map(inline), [[], ['decky-toolkit.removeVirtualController'], [], ['decky-toolkit.removeVirtualController']]);
  assert.match(rows[1].tooltip.value, /Steam Input: xbox360, Slot 2/);

  const [err] = await treeFor(async () => { throw new Error('boom'); }).getChildren();
  assert.equal(err.label, 'Could not load controllers: boom');
  assert.equal(err.command.command, 'decky-toolkit.refreshControllers');
  return rows.map(r => `${r.label} — ${r.description}`).join(' | ');
});

await check('Controllers view live: controllers events, add / remove, slot limit and Steam Input refusal as-is', async () => {
  const provider = tree('decky-toolkit.controllers').provider;
  const rowLabels = async () => labels(await provider.getChildren());
  await settle(100);
  assert.deepEqual(await rowLabels(), ['1. Steam Deck', '2. Decky Toolkit pad (virtual)']);
  assert.equal(tree('decky-toolkit.controllers').view.description, '10.1.2.3');
  assert.ok(ev.streams.size >= 1, 'event stream open');

  // A change on the device arrives as an event, without polling.
  fetched.length = 0;
  ctl.controllers = [...ctl.controllers, { id: 'evdev:8bd', name: '8BitDo Pro 2', kind: 'physical', virtual_id: null, vendor: '2dc8', product: '6003', device: '/dev/input/event7', steam: null }];
  ctlPush();
  await settle(120);
  assert.deepEqual(await rowLabels(), ['1. Steam Deck', '2. Decky Toolkit pad (virtual)', '8BitDo Pro 2']);
  assert.ok(!fetched.includes('/controllers'), 'no polling while the stream is open');

  // Add: optional name, Enter takes "Virtual pad N" (the auto pad does not count).
  let prompt;
  ui.inputBox = opts => { prompt = opts; return ''; };
  await run('decky-toolkit.addVirtualController');
  await settle();
  assert.equal(prompt.placeHolder, 'Virtual pad 1');
  assert.deepEqual(ctl.posts.at(-1), { name: 'Virtual pad 1' });
  assert.equal(lastMessage('info').m, 'Decky Toolkit: Virtual controller added and recognised by Steam Input (Virtual pad 1).');
  const rows = await provider.getChildren();
  const added = rows.find(r => String(r.label).endsWith('Virtual pad 1'));
  assert.equal(added.description, 'virtual · Steam Input: xbox360 · Slot 4');

  ui.inputBox = () => 'Couch';
  await run('decky-toolkit.addVirtualController');
  assert.deepEqual(ctl.posts.at(-1), { name: 'Couch' });
  ui.inputBox = () => undefined;
  const posts = ctl.posts.length;
  await run('decky-toolkit.addVirtualController');
  assert.equal(ctl.posts.length, posts, 'Escape adds nothing');

  // Remove: inline on the row, or a pick from the palette.
  await run('decky-toolkit.removeVirtualController', added);
  await settle();
  assert.ok(!(await rowLabels()).includes('Virtual pad 1'));
  let offered;
  ui.quickPick = items => { offered = labels(items); return items.find(i => i.label === 'Couch'); };
  await run('decky-toolkit.removeVirtualController');
  await settle();
  assert.deepEqual(offered, ['Decky Toolkit pad', 'Couch']);
  assert.ok(!(await rowLabels()).includes('Couch (virtual)'));

  // Refusals: the server's text as-is.
  ui.inputBox = () => '';
  ctl.refuse = 'Steam Input did not pick up the new pad within 5 s; it was removed';
  await run('decky-toolkit.addVirtualController');
  assert.equal(lastMessage('warning').m, 'Decky Toolkit: Steam Input did not pick up the new pad within 5 s; it was removed');
  ctl.refuse = null;
  for (let i = 0; i < 4; i++) await run('decky-toolkit.addVirtualController');
  await run('decky-toolkit.addVirtualController');
  assert.equal(lastMessage('warning').m, 'Decky Toolkit: all 4 virtual controller slots are in use');
  for (const v of ctl.virtual.filter(p => !p.auto)) await run('decky-toolkit.removeVirtualController', v.id);

  // A change while the stream is down arrives with the hello of the reconnect.
  ev.status = 500;
  evEnd();
  ctl.controllers = ctl.controllers.filter(c => c.id !== 'evdev:8bd');
  await settle(60);
  ev.status = 200;
  await settle(150);
  assert.ok(ev.streams.size >= 1, 'stream reopened');
  assert.deepEqual(await rowLabels(), ['1. Steam Deck', '2. Decky Toolkit pad (virtual)'], 'the hello brought the change');
  return 'event update, add "Virtual pad 1" (slot 3), remove inline + palette, refusal and slot limit as-is, resync on reconnect';
});

await check('device events: no /health polling while the stream is up; input, plugins and stream settings follow events; shutdown, silence and drops reconnect', async () => {
  await settle(100);
  fetched.length = 0;
  await settle(200);
  assert.equal(fetched.filter(f => f === '/health').length, 0, '/health is not polled while the stream is up (40 ms poll here)');
  assert.ok(!fetched.includes('/input/settings') && !fetched.includes('/controllers'), 'no input or controller polls');

  const was = device.input.enabled;
  device.input = { ...device.input, enabled: !was };
  evPush('input_settings', device.input);
  await settle();
  assert.equal(status().endsWith('$(keyboard)'), !was, 'input settings follow the event');
  device.input = { ...device.input, enabled: was };
  evPush('input_settings', device.input);

  let treeChanges = 0;
  const sub = pluginsProvider().onDidChangeTreeData(() => treeChanges++);
  evPush('plugins', evState().plugins);
  await settle();
  assert.equal(treeChanges, 0, 'the same plugin list reloads nothing');
  plugins.push({ dir: 'extra', name: 'Extra', version: '1.0.0', flags: [], has_backend: false });
  evPush('plugins', evState().plugins);
  await settle();
  assert.equal(treeChanges, 1, 'a changed plugin list reloads the Plugins view');
  setPlugins(plugins.filter(p => p.dir !== 'extra'));
  evPush('plugins', evState().plugins);
  await settle();
  sub.dispose();

  // The device restarts: `shutdown`, then a reconnect with a fresh hello.
  const opened = ev.opened;
  evEnd('shutdown');
  await settle(150);
  assert.ok(ev.opened > opened && ev.streams.size >= 1, 'reconnected after shutdown');
  assert.equal(calls.context.get('decky-toolkit.link'), 'connected');

  // A stream that goes quiet is dropped after the heartbeat timeout and reopened.
  const timeout = ext.eventTimings.heartbeatTimeoutMs;
  ext.eventTimings.heartbeatTimeoutMs = 60;
  ev.silent = true;
  evEnd('close');
  await settle(60);
  const silentOpen = ev.opened;
  ev.silent = false;
  await settle(250);
  ext.eventTimings.heartbeatTimeoutMs = timeout;
  assert.ok(ev.opened > silentOpen, 'a silent stream is replaced');
  assert.equal(calls.context.get('decky-toolkit.link'), 'connected');
  return `streams opened ${ev.opened}`;
});

await check('screen panel: "Gamepad goes to" QuickPick, new pad, removed pad → Auto, pad field on gamepad messages', async () => {
  const panel = calls.panels[0];
  const targets = () => panel._posted.filter(m => m.type === 'padTarget').map(m => m.id);
  panel._posted.length = 0;
  panel._received.fire({ type: 'ready' });
  await settle();
  assert.deepEqual(targets(), ['']);
  ui.inputBox = () => 'Couch';
  answerPicks('Gamepad goes to', 'New virtual pad…');
  await run('decky-toolkit.screen.settings');
  await settle(100);
  const id = ctl.virtual.find(v => v.name === 'Couch').id;
  assert.equal(targets().at(-1), id, 'the new pad becomes the target');
  const offered = answerPicks('Gamepad goes to');
  await run('decky-toolkit.screen.settings');
  assert.equal(offered[0].descriptions.at(-1), 'Couch');
  assert.deepEqual(offered[1].labels, ['Auto', 'Couch', '$(add) New virtual pad…'], 'the auto pad is "Auto", not a choice');
  assert.equal(offered[1].descriptions[1], 'current');
  await run('decky-toolkit.removeVirtualController', id);
  await run('decky-toolkit.refreshControllers');
  await settle(100);
  assert.equal(targets().at(-1), '', 'a removed target falls back to Auto');

  const w = loadScreenJs();
  w.post({ type: 'input', state: { enabled: true } });
  w.sockets[0].onopen?.();
  const pressed = i => ({ pressed: i === 0, value: i === 0 ? 1 : 0 });
  w.pads.list = [{ connected: true, mapping: 'standard', buttons: Array.from({ length: 17 }, (_, i) => pressed(i)), axes: [0, 0, 0, 0] }];
  w.fire('gamepadconnected');
  assert.equal(w.el('hint').textContent, 'Gamepad connected');
  const gp = () => w.sent.filter(m => m.type === 'gamepad');
  assert.equal(gp().at(-1).buttons.a, true);
  assert.equal('pad' in gp().at(-1), false, 'Auto sends no pad field');
  w.post({ type: 'padTarget', id: 'v2' });
  assert.deepEqual([gp().at(-1).buttons.a, 'pad' in gp().at(-1)], [false, false], 'Auto got a neutral state first');
  w.fire('gamepadconnected');
  assert.deepEqual([gp().at(-1).buttons.a, gp().at(-1).pad], [true, 'v2']);
  w.pads.list = [];
  w.fire('gamepaddisconnected');
  return 'New virtual pad… → target, list Auto / Couch / New virtual pad…, removed → Auto; Auto → no pad field, v2 → pad "v2"';
});

await check('Steam UI navigation: Navigate to… QuickPick, template prompt, plugin panel, back / Quick Access / close menus, refused path', async () => {
  let offered;
  ui.quickPick = (items, opts) => { offered = { items, opts }; return items.find(i => i.label === 'Settings'); };
  await run('decky-toolkit.navigate');
  assert.equal(offered.opts.placeHolder, 'Current: /library/home');
  const placeHolder = offered.opts.placeHolder;
  const sections = offered.items.filter(i => i.kind === vscode.QuickPickItemKind.Separator).map(i => i.label);
  assert.deepEqual(sections, ['Official', 'Plugins', 'Menus']);
  assert.deepEqual(offered.items.filter(i => i.kind === undefined).map(i => [i.label, i.description]), [
    ['Library', '/library/home · current'], ['Game details', '/library/app/{appid}'], ['Settings', '/settings'], ['Tender', '/tender'],
    ['Main menu', undefined], ['Quick Access', undefined], ['Quick Access › Notifications', undefined], ['Quick Access › Decky', undefined]]);
  assert.deepEqual(uiDevice.posts.at(-1), { path: '/settings' });
  assert.match(calls.statusMessages.at(-1), /Steam UI at \/settings/);

  let prompt;
  ui.quickPick = items => items.find(i => i.label === 'Game details');
  ui.inputBox = opts => { prompt = opts; return ' 620 '; };
  await run('decky-toolkit.navigate');
  assert.match(prompt.prompt, /Steam app ID/);
  assert.equal(prompt.validateInput('abc'), 'Digits only');
  assert.equal(prompt.validateInput('620'), undefined);
  assert.deepEqual(uiDevice.posts.at(-1), { path: '/library/app/620' });
  ui.inputBox = () => undefined;
  const before = uiDevice.posts.length;
  await run('decky-toolkit.navigate');
  assert.equal(uiDevice.posts.length, before, 'cancelled template prompt sends nothing');

  ui.quickPick = items => items.find(i => i.label === 'Quick Access › Decky');
  await run('decky-toolkit.navigate');
  assert.deepEqual(uiDevice.posts.at(-1), { action: 'quick_access', tab: 'Decky' });

  ui.quickPick = (items, opts) => { offered = { items, opts }; return items.find(i => i.label === 'Tender'); };
  await run('decky-toolkit.openPluginPanel');
  assert.deepEqual(labels(offered.items), ['Decky Toolkit', 'My Plugin', 'Tender']);
  assert.deepEqual(uiDevice.posts.at(-1), { action: 'plugin', plugin: 'Tender' });
  const [row] = await pluginsProvider().getChildren();
  await run('decky-toolkit.openPluginPanel', row);
  assert.deepEqual(uiDevice.posts.at(-1), { action: 'plugin', plugin: 'Decky Toolkit' });
  assert.ok(itemMenu('decky-toolkit.plugins', 'plugin', false).includes('decky-toolkit.openPluginPanel'));

  for (const [cmd, body] of [['decky-toolkit.uiBack', { action: 'back' }], ['decky-toolkit.uiQuickAccess', { action: 'quick_access' }], ['decky-toolkit.uiCloseMenus', { action: 'close_menus' }]]) {
    await run(cmd);
    assert.deepEqual(uiDevice.posts.at(-1), body, cmd);
  }

  let shown;
  ui.error = m => { shown = m; };
  ui.quickPick = items => items.find(i => i.label === 'Game details');
  const realPaths = uiRoutes.official;
  uiRoutes.official = [{ path: '/nowhere/{appid}', title: 'Game details', template: true }];
  ui.inputBox = () => '1';
  await run('decky-toolkit.navigate');
  uiRoutes.official = realPaths;
  assert.equal(shown, 'Decky Toolkit: Steam UI navigation: unknown path /nowhere/1');
  return `sections ${sections.join(' / ')}, placeholder "${placeHolder}", template → /library/app/620, plugin panel, back / quick_access / close_menus, refused "${shown}"`;
});

await check('an outdated plugin on the device: one warning to update it', async () => {
  delete health.api;
  try {
    // A plugin restart (here: with an older build) drops the event stream, and the editor looks at /health.
    evEnd('shutdown');
    await settle(150);
    evEnd('shutdown');
    await settle(150);
    const warned = calls.messages.filter(m => m.kind === 'warning' && /too old for this client/.test(m.m));
    assert.equal(warned.length, 1, 'once per device, not on every restart');
    assert.match(warned[0].m, /plugin on the device \(0\.2\.0\) is too old for this client; update it with Decky's Install Plugin from URL \(10\.1\.2\.3\)\.$/);
    return warned[0].m;
  } finally {
    health.api = ['v1'];
  }
});

await check('stats polling stops when the Actions view is hidden', async () => {
  calls.panels[0].dispose();
  const t = tree('decky-toolkit.actions');
  t.view.visible = false;
  t.view._visibility.fire({ visible: false });
  await settle();
  assert.equal((await actionsProvider().getChildren())[0].description, '');
  t.view.visible = true;
  t.view._visibility.fire({ visible: true });
  await settle();
  assert.equal((await actionsProvider().getChildren())[0].description, '30 fps · 19.5 Mbps');
  return 'lease released on hide, re-acquired on show';
});

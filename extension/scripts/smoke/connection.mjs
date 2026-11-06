import assert from 'assert/strict';
import {
  actionsProvider, assertPaired, calls, check, device, devicesProvider, ext, fetched, files, globalState, icon,
  itemMenu, labels, lastMessage, loadScreenJs, LOST_VIEWS, lostNotes, otherPki, pairedIdentity, pkg, pluginsProvider,
  removeIdentity, run, seedId, settle, status, storedIdentity, storePaired, titleActions, tree, ui, visibleViews,
  welcomeFor, writeIdentity,
} from './harness.mjs';

await check('connection lost: views stay but go blank, screen panel / preview / logs / decky:// files say so, then recover by themselves', async () => {
  await run('decky-toolkit.openScreen');
  const panel = calls.panels.at(-1);
  panel._received.fire({ type: 'ready' });
  await run('decky-toolkit.loaderLogs');
  await settle();
  const linkMsg = () => panel._posted.filter(m => m.type === 'link').at(-1);
  const previewState = () => calls.previewView.webview._posted.filter(m => m.type === 'state').at(-1);
  assert.deepEqual(linkMsg(), { type: 'link', live: true, text: '' });
  assert.deepEqual(previewState(), { type: 'state', live: true, text: '' });
  assert.equal(panel.title, 'Screen: 10.1.2.3');
  assert.equal(calls.context.get('decky-toolkit.screen.live'), true);
  assert.ok(!titleActions().includes('decky-toolkit.reconnect'));
  const deco = calls.decorations[0];
  const file = ext.deckyUri({ host: '10.1.2.3', port: 8765 }, '/home/jackh/.local/share/VVVVVV/saves/tsave.vvv');
  assert.equal(deco.provideFileDecoration(file), undefined);
  const views = visibleViews();
  assert.deepEqual(views, pkg.contributes.views['decky-toolkit'].map(v => v.id).filter(id => id !== 'decky-toolkit.welcome'));
  const notesBefore = lostNotes().length;

  device.up = false;
  await settle(150);
  let [r] = devicesProvider().getChildren();
  assert.equal(r.description, 'v0.2.0 · unreachable');
  assert.equal(r.iconPath.id, 'warning');
  assert.equal(calls.context.get('decky-toolkit.connected'), true, 'the session and its token stay');
  assert.equal(calls.context.get('decky-toolkit.link'), 'unreachable');
  assert.deepEqual(visibleViews(), views, 'no view disappears');
  for (const id of LOST_VIEWS) {
    assert.deepEqual(await tree(`decky-toolkit.${id}`).provider.getChildren(), [], `${id} is blank`);
    assert.equal(tree(`decky-toolkit.${id}`).view.description, '10.1.2.3 · connection lost');
    const [welcome, ...more] = welcomeFor(`decky-toolkit.${id}`);
    assert.equal(more.length, 0, `${id}: one welcome`);
    assert.match(welcome, /^Lost connection to the device\..*\n\[Reconnect now\]\(command:decky-toolkit\.reconnect\)$/s);
  }
  assert.equal(calls.previewView.description, '10.1.2.3 · connection lost');
  assert.deepEqual(previewState(), { type: 'state', live: false, text: 'Lost connection to 10.1.2.3.\nReconnecting as soon as it answers again…' });
  assert.equal(status(), '$(debug-disconnect) 10.1.2.3: connection lost');
  assert.equal(calls.statusItems[0].backgroundColor.id, 'statusBarItem.warningBackground');
  assert.equal(calls.statusItems[0].command, 'decky-toolkit.reconnect');
  assert.equal(panel.title, 'Screen: 10.1.2.3 (connection lost)', 'the panel stays open and its tab says why');
  assert.deepEqual(linkMsg(), { type: 'link', live: false, text: 'Lost connection to 10.1.2.3.\nReconnecting as soon as it answers again…' });
  assert.equal(calls.context.get('decky-toolkit.screen.live'), false);
  assert.deepEqual(titleActions(), ['decky-toolkit.reconnect', 'decky-toolkit.screen.mute', 'decky-toolkit.screen.pause'], 'device actions give way to Reconnect');
  assert.equal(icon('decky-toolkit.reconnect'), '$(plug)');
  const notes = lostNotes().slice(notesBefore);
  assert.deepEqual(notes, ['[decky-toolkit] Lost connection to 10.1.2.3. Output resumes when it is connected again.'], 'the log channel says it once');
  const d = deco.provideFileDecoration(file);
  assert.equal(d.badge, '!');
  assert.equal(d.color.id, 'list.warningForeground');
  assert.match(d.tooltip, /Lost connection to 10\.1\.2\.3; files open and save again/);
  assertPaired();

  fetched.length = 0;
  device.up = true;
  await settle(150);
  [r] = devicesProvider().getChildren();
  assert.equal(r.description, 'v0.2.0 · connected');
  assert.equal(calls.context.get('decky-toolkit.link'), 'connected');
  assert.equal(status(), '$(vm-connect) 10.1.2.3');
  assert.equal(calls.statusItems[0].backgroundColor, undefined);
  assert.equal((await actionsProvider().getChildren()).length, 5, 'Actions fill again');
  assert.ok(labels(await pluginsProvider().getChildren()).includes('Tender'), 'Plugins fill again');
  assert.equal(tree('decky-toolkit.actions').view.description, '10.1.2.3');
  assert.equal(panel.title, 'Screen: 10.1.2.3');
  assert.deepEqual(linkMsg(), { type: 'link', live: true, text: '' });
  assert.equal(calls.context.get('decky-toolkit.screen.live'), true);
  assert.ok(fetched.includes('/events'), 'events resumed; their hello brings the stream settings');
  assert.deepEqual(previewState(), { type: 'state', live: true, text: '' });
  assert.ok(lostNotes().slice(notesBefore).includes('[decky-toolkit] Connected to 10.1.2.3 again.'));
  assert.equal(deco.provideFileDecoration(file), undefined);
  assert.equal(panel.disposed, undefined, 'the screen panel was never closed');
  return 'views kept + blank with "Lost connection" welcome; title "(connection lost)"; status warning; one log line; decky:// "!" badge; all back on recovery';
});

await check('screen.js: a lost link stops the stream, input and audio and dims the last frame; recovery restarts them', async () => {
  const w = loadScreenJs();
  assert.equal(w.fetches.length, 1, 'stream started');
  w.post({ type: 'input', state: { enabled: true } });
  w.post({ type: 'audio', on: true, muted: false, volume: 0.8 });
  const [input, audio] = ['/input', '/audio'].map(p => w.sockets.find(s => s.url.endsWith(p)));
  assert.ok(input && audio);
  w.post({ type: 'link', live: false, text: 'Lost connection to Deck.\nReconnecting as soon as it answers again…' });
  assert.equal(w.el('msg').textContent, 'Lost connection to Deck.\nReconnecting as soon as it answers again…');
  assert.equal(w.el('msg').hidden, false);
  assert.ok(w.el('main').classList.contains('offline'), 'last frame dimmed');
  assert.ok(input.closed && audio.closed, 'sockets closed');
  w.post({ type: 'visible', visible: false });
  w.post({ type: 'visible', visible: true });
  w.post({ type: 'reconnect' });
  w.post({ type: 'input', state: { enabled: true } });
  assert.equal(w.fetches.length, 1, 'nothing fetched while offline');
  assert.equal(w.sockets.length, 2, 'no socket opened while offline');
  w.post({ type: 'link', live: true, text: '' });
  assert.equal(w.fetches.length, 2, 'stream restarted');
  assert.equal(w.el('msg').textContent, 'Connecting…');
  assert.ok(!w.el('main').classList.contains('offline'));
  assert.deepEqual(w.sockets.slice(2).map(s => s.url.split('/').pop()).sort(), ['audio', 'input']);
  const cold = loadScreenJs({ live: false });
  assert.equal(cold.fetches.length, 0, 'a panel opened while offline does not fetch');
  return 'offline: msg + dimmed + sockets closed + no fetch; live again: stream, input and audio back';
});

await check('user Disconnect: views stay blank with "Disconnected" and Reconnect, screen panel stays open; Reconnect restores it', async () => {
  const panel = calls.panels.at(-1);
  const notesBefore = lostNotes().length;
  await run('decky-toolkit.disconnectDevice');
  await settle();
  assert.equal(calls.context.get('decky-toolkit.connected'), false);
  assert.equal(calls.context.get('decky-toolkit.link'), 'disconnected');
  assert.deepEqual(visibleViews(), pkg.contributes.views['decky-toolkit'].map(v => v.id).filter(id => id !== 'decky-toolkit.welcome'), 'the layout does not jump');
  for (const id of LOST_VIEWS) {
    assert.deepEqual(await tree(`decky-toolkit.${id}`).provider.getChildren(), [], `${id} is blank`);
    assert.deepEqual(welcomeFor(`decky-toolkit.${id}`), ['Disconnected from the device.\n[Reconnect](command:decky-toolkit.reconnect)']);
    assert.equal(tree(`decky-toolkit.${id}`).view.description, '10.1.2.3 · disconnected');
  }
  const [r] = devicesProvider().getChildren();
  assert.equal(r.description, 'v0.2.0 · paired');
  assert.equal(r.iconPath.id, 'vm');
  assert.equal(r.contextValue, 'deck.paired');
  assert.equal(r.command.command, 'decky-toolkit.connect');
  assert.deepEqual(itemMenu('decky-toolkit.devices', r.contextValue, true), ['decky-toolkit.connect', 'decky-toolkit.deviceActions']);
  assertPaired();
  assert.equal(status(), '$(vm) Decky: not connected');
  assert.equal(panel.disposed, undefined, 'not closed');
  assert.equal(panel.title, 'Screen: 10.1.2.3 (disconnected)');
  assert.match(panel._posted.filter(m => m.type === 'link').at(-1).text, /^Disconnected from 10\.1\.2\.3\./);
  assert.deepEqual(lostNotes().slice(notesBefore), ['[decky-toolkit] Disconnected from 10.1.2.3. Output resumes when it is connected again.']);
  const file = ext.deckyUri({ host: '10.1.2.3', port: 8765 }, '/home/jackh/.local/share/VVVVVV/saves/tsave.vvv');
  assert.equal(calls.decorations[0].provideFileDecoration(file), undefined, 'decky:// still works with the stored token');

  fetched.length = 0;
  await run('decky-toolkit.reconnect');
  await settle();
  assert.equal(calls.context.get('decky-toolkit.link'), 'connected');
  assert.ok(fetched.includes('/health') && !fetched.includes('/pair/request'));
  assert.equal(panel.title, 'Screen: 10.1.2.3');
  assert.ok(lostNotes().slice(notesBefore).includes('[decky-toolkit] Connected to 10.1.2.3 again.'));
  assert.equal((await actionsProvider().getChildren()).length, 5);
  panel.dispose();
  await run('decky-toolkit.disconnectDevice');
  await settle();
  return `row "${r.label}" — "${r.description}" [$(vm)]; welcome "Disconnected from the device." + Reconnect`;
});

await check('pairing rejected mid-session: views blank with Re-pair, status bar and device row say so, re-pairing restores', async () => {
  await run('decky-toolkit.connect', seedId());
  await settle();
  // Forgetting this editor ends its event stream; the reconnect gets a 401.
  device.rejectToken = true;
  await settle(150);
  assert.equal(calls.context.get('decky-toolkit.link'), 'rejected');
  for (const id of LOST_VIEWS) {
    assert.deepEqual(await tree(`decky-toolkit.${id}`).provider.getChildren(), []);
    assert.match(welcomeFor(`decky-toolkit.${id}`)[0], /no longer accepts this editor.*\n\[Reconnect\]\(command:decky-toolkit\.reconnect\)$/s);
  }
  assert.equal(status(), '$(key) 10.1.2.3: pairing rejected');
  assert.equal(calls.statusItems[0].backgroundColor.id, 'statusBarItem.errorBackground');
  const [r] = devicesProvider().getChildren();
  assert.equal(r.description, 'v0.2.0 · pairing rejected');
  const file = ext.deckyUri({ host: '10.1.2.3', port: 8765 }, '/home/jackh/.local/share/VVVVVV/saves/tsave.vvv');
  assert.equal(calls.decorations[0].provideFileDecoration(file).color.id, 'list.errorForeground');
  device.pairQueue = ['approved'];
  fetched.length = 0;
  await run('decky-toolkit.reconnect');
  await settle();
  assert.ok(fetched.includes('/pair/request'), 'Re-pair runs pairing');
  assert.equal(calls.context.get('decky-toolkit.link'), 'connected');
  assert.equal(status(), '$(vm-connect) 10.1.2.3');
  await run('decky-toolkit.disconnectDevice');
  await settle();
  return 'rejected → Re-pair → connected';
});

await check('Connect with a stored pairing checks /health and connects without pairing', async () => {
  fetched.length = 0;
  await run('decky-toolkit.connect', seedId());
  await settle();
  assert.ok(fetched.includes('/health'));
  assert.ok(!fetched.includes('/pair/request'));
  assert.equal(calls.context.get('decky-toolkit.connected'), true);
  assert.match(calls.statusMessages.at(-1), /Connected to 10\.1\.2\.3/);
  assert.equal(calls.panels.filter(x => !x.disposed).length, 0, 'screen opens only after the first connect of a session');
  await run('decky-toolkit.disconnectDevice');
  return `requests: ${[...new Set(fetched)].join(', ')}`;
});

await check('a forgotten pairing (401) goes straight into pairing', async () => {
  writeIdentity({ ...pairedIdentity, cert: otherPki.cert });
  await settle();
  fetched.length = 0;
  device.pairQueue = ['approved'];
  await run('decky-toolkit.connect', seedId());
  await settle();
  assert.ok(fetched.includes('/pair/request'));
  assertPaired();
  assert.equal(calls.context.get('decky-toolkit.connected'), true);
  await run('decky-toolkit.disconnectDevice');
  return `requests: ${fetched.join(', ')}`;
});

await check('a reset device (pinned certificate no longer matches) goes straight into pairing, no extra message', async () => {
  writeIdentity({ ...pairedIdentity, serverCert: otherPki.cert });
  await settle();
  fetched.length = 0;
  const before = calls.messages.length;
  device.pairQueue = ['approved'];
  await run('decky-toolkit.connect', seedId());
  await settle();
  assert.ok(fetched.includes('/pair/request'));
  assertPaired();
  assert.equal(calls.context.get('decky-toolkit.connected'), true);
  assert.deepEqual(calls.messages.slice(before).map(m => m.m), ['Decky Toolkit: Paired with 10.1.2.3.']);
  await run('decky-toolkit.disconnectDevice');
  return `requests: ${fetched.join(', ')}`;
});

await check('a pairing code that differs from our own derivation aborts with "could not pair"', async () => {
  removeIdentity();
  await settle();
  device.pairRequests = [];
  device.pairCancelled = [];
  device.tamperCode = true;
  let offered;
  ui.warning = (m, buttons) => { offered = { m, buttons }; return undefined; };
  await run('decky-toolkit.connect', seedId());
  await settle();
  device.tamperCode = false;
  assert.deepEqual(offered, { m: 'Decky Toolkit: could not pair with 10.1.2.3. Try again.', buttons: ['Try again'] });
  assert.equal(storedIdentity(), undefined);
  assert.deepEqual(device.pairCancelled, ['req0'], 'the request is withdrawn on the device');
  assert.equal(calls.context.get('decky-toolkit.connected'), false);
  await storePaired();
  await settle();
  return `"${offered.m}"`;
});

await check('a pairing written or removed by another process (the CLI) shows up without a reload', async () => {
  const row = () => devicesProvider().getChildren()[0].description;
  assert.equal(row(), 'v0.2.0 · paired');
  removeIdentity();
  for (let i = 0; i < 50 && row() !== 'v0.2.0 · not paired'; i++) await settle(10);
  assert.equal(row(), 'v0.2.0 · not paired');
  writeIdentity(pairedIdentity);
  for (let i = 0; i < 50 && row() !== 'v0.2.0 · paired'; i++) await settle(10);
  assert.equal(row(), 'v0.2.0 · paired');
});

await check('a command while disconnected offers to connect instead of running', async () => {
  let offered;
  ui.warning = (m, buttons) => { offered = { m, buttons }; return undefined; };
  const copied = calls.clipboard.length;
  await run('decky-toolkit.copyMcpUrl');
  assert.equal(offered.m, 'Decky Toolkit: not connected to a device.');
  assert.deepEqual(offered.buttons, ['Connect to 10.1.2.3']);
  assert.equal(calls.clipboard.length, copied, 'nothing copied');
  return `"${offered.m}" [${offered.buttons.join(', ')}]`;
});

await check('reachability error: one message with Retry / Edit device, no pairing; Retry connects', async () => {
  device.up = false;
  fetched.length = 0;
  let row;
  ui.error = (m, buttons) => {
    row = devicesProvider().getChildren()[0];
    calls.lastError = { m, buttons };
    device.up = true;
    return 'Retry';
  };
  await run('decky-toolkit.connect', seedId());
  await settle();
  assert.equal(calls.lastError.m, "Can't reach 10.1.2.3 at 10.1.2.3:8765. Is the device on and Decky Toolkit enabled?");
  assert.deepEqual(calls.lastError.buttons, ['Retry'], 'no way to edit the address: forget and add the device again');
  assert.equal(row.description, 'v0.2.0 · unreachable');
  assert.equal(row.iconPath.id, 'warning');
  assert.equal(row.iconPath.color.id, 'problemsWarningIcon.foreground');
  assert.ok(!fetched.includes('/pair/request'));
  assert.equal(calls.context.get('decky-toolkit.connected'), true, 'Retry connected once the device answered');
  await run('decky-toolkit.disconnectDevice');
  return `"${calls.lastError.m}" [${calls.lastError.buttons.join(', ')}], row was "${row.description}"`;
});

await check('pairing denied on the device: "Pairing denied" with Try again, which files a new request', async () => {
  removeIdentity();
  await settle();
  device.pairRequests = [];
  device.pairQueue = ['pending', 'denied', 'approved'];
  const offered = [];
  ui.warning = (m, buttons) => { offered.push({ m, buttons }); return 'Try again'; };
  await run('decky-toolkit.connect', seedId());
  await settle();
  assert.deepEqual(offered, [{ m: 'Decky Toolkit: Pairing denied on 10.1.2.3.', buttons: ['Try again'] }]);
  assert.equal(device.pairRequests.length, 2, 'Try again filed a second request');
  assertPaired();
  assert.equal(calls.context.get('decky-toolkit.connected'), true);
  await run('decky-toolkit.disconnectDevice');
  return `"${offered[0].m}" [${offered[0].buttons.join(', ')}], then approved`;
});

await check('pairing has no time limit: survives a lost connection and a forgotten request (new code); Cancel sends DELETE', async () => {
  removeIdentity();
  await settle();
  device.pairRequests = [];
  device.pairCancelled = [];
  device.pairQueue = ['pending', 'down', 'pending', 'gone'];
  const warningsBefore = calls.messages.filter(m => m.kind === 'warning').length;
  const done = run('decky-toolkit.connect', seedId());
  for (let i = 0; i < 200 && (device.pairRequests.length < 2 || device.pairQueue.length); i++) await settle(10);
  await settle(60);
  const row = devicesProvider().getChildren()[0];
  const prog = calls.progress.at(-1);
  prog.cancel();
  await done;
  await settle();
  const [code0, code1] = device.pairRequests.map(r => r.code);
  assert.equal(row.description, `v0.2.0 · waiting for approval · code ${code1}`, 'the row shows the new code');
  assert.ok(prog.messages.some(m => m === `Lost contact with 10.1.2.3 (cannot reach the device (socket hang up)), retrying… Code ${code0}.`));
  assert.equal(prog.messages.at(-1), `Waiting for approval on 10.1.2.3 · code ${code1}. On the device: Quick Access → Decky Toolkit → Approve.`);
  assert.deepEqual(device.pairCancelled, ['req1']);
  assert.equal(calls.messages.filter(m => m.kind === 'warning').length, warningsBefore, 'cancel is silent');
  assert.equal(calls.context.get('decky-toolkit.connected'), false);
  assert.equal(devicesProvider().getChildren()[0].description, 'v0.2.0 · not paired');
  return `${prog.messages.length} progress updates, codes ${code0} → ${code1}, DELETE ${device.pairCancelled[0]}`;
});

await check('a device with an older plugin (plain HTTP): "Update Decky Toolkit", no manual pairing', async () => {
  device.pairUnsupported = true;
  let offered;
  ui.warning = (m, buttons) => { offered = { m, buttons }; return undefined; };
  await run('decky-toolkit.connect', seedId());
  device.pairUnsupported = false;
  assert.equal(offered.m, 'Decky Toolkit: Update Decky Toolkit on 10.1.2.3 to pair with it.');
  assert.deepEqual(offered.buttons, []);
  assert.equal(devicesProvider().getChildren()[0].description, 'v0.2.0 · not paired');
  return `"${offered.m}" [${offered.buttons.join(', ')}]`;
});

await check('Add device with one saved: "Replace?" modal; Cancel keeps it, Replace forgets it and its pairing', async () => {
  const prompts = [];
  ui.inputBox = opts => { prompts.push(opts.prompt); return undefined; };
  await run('decky-toolkit.addDevice');
  const modal = lastMessage('warning');
  assert.deepEqual({ m: modal.m, buttons: modal.buttons, options: modal.options }, {
    m: 'Replace 10.1.2.3?', buttons: ['Replace'],
    options: { modal: true, detail: 'Its pairing is deleted. This editor connects to one device at a time.' },
  });
  assert.equal(prompts.length, 0, 'Cancel: no address prompt');
  assert.equal(globalState.get('decky-toolkit.devices').length, 1);

  await storePaired();
  await run('decky-toolkit.connect', seedId());
  await settle();
  assert.equal(calls.context.get('decky-toolkit.connected'), true);
  const oldId = seedId();
  const inputs = ['10.9.9.9', '', '9000'];
  ui.warning = (m, buttons) => (m === 'Replace 10.1.2.3?' ? 'Replace' : undefined);
  ui.inputBox = opts => { prompts.push(opts.prompt); if (opts.validateInput) assert.equal(opts.validateInput(inputs[0]), undefined); return inputs.shift(); };
  const picks = ['port', 'later'];
  const offered = [];
  ui.quickPick = items => { offered.push(items.map(i => i.label)); const want = picks.shift(); return items.find(i => i.id === want); };
  await run('decky-toolkit.addDevice');
  await settle();
  const list = globalState.get('decky-toolkit.devices');
  assert.equal(list.length, 1, 'exactly one saved device');
  assert.notEqual(list[0].id, oldId);
  assert.deepEqual({ name: list[0].name, host: list[0].host, port: list[0].port }, { name: '10.9.9.9', host: '10.9.9.9', port: 9000 });
  assert.equal(storedIdentity(), undefined, 'the old pairing is deleted');
  assert.equal(calls.context.get('decky-toolkit.connected'), false, 'the old session ended');
  assert.equal(prompts.length, 3);
  assert.match(offered[0][0], /Connect to 10\.9\.9\.9/);
  assert.match(offered[0][1], /Change port \(8765\)/);
  ui.inputBox = opts => opts.validateInput('http://x/');
  await run('decky-toolkit.refresh');
  await settle();
  const rows = devicesProvider().getChildren();
  assert.deepEqual(rows.map(r => [r.label, r.description]), [['10.9.9.9:9000', 'unreachable']], 'refresh probes the saved device');

  // Back to the seed address for the checks that follow.
  ui.warning = (_m, buttons) => buttons[0];
  ui.inputBox = opts => (opts.prompt.startsWith('IP address') ? '10.1.2.3' : '');
  ui.quickPick = items => items.find(i => i.id === 'later');
  await run('decky-toolkit.addDevice');
  await settle();
  assert.deepEqual(globalState.get('decky-toolkit.devices').map(d => `${d.host}:${d.port}`), ['10.1.2.3:8765']);
  await storePaired();
  await settle();
  return `modal "${modal.m}" [${modal.buttons.join(', ')}]; prompts: ${prompts.join(' / ')}; then picks ${offered[0].join(' | ')}`;
});

await check('status bar: device actions QuickPick (disconnect, open screen, rename, forget); no Switch device', async () => {
  await run('decky-toolkit.connect', seedId());
  await settle();
  let offered;
  ui.quickPick = (items, opts) => { offered = { labels: items.map(i => i.label), placeHolder: opts.placeHolder }; return undefined; };
  assert.equal(calls.statusItems[0].command, 'decky-toolkit.deviceActions');
  await run('decky-toolkit.deviceActions');
  assert.equal(offered.placeHolder, '10.1.2.3 · connected');
  assert.deepEqual(offered.labels, [
    '$(debug-disconnect) Disconnect from 10.1.2.3', '$(device-desktop) Open screen', '', '$(pencil) Rename…', '$(trash) Forget device']);
  assert.equal(calls.statusItems[0].tooltip, 'Decky: connected to 10.1.2.3 (10.1.2.3:8765). Click for device actions');
  await run('decky-toolkit.disconnectDevice');
  await run('decky-toolkit.deviceActions');
  assert.deepEqual(offered.labels.slice(0, 2), ['$(plug) Connect to 10.1.2.3', '']);
  assert.ok(!calls.commands.has('decky-toolkit.switchDevice'), 'no switchDevice command');
  assert.deepEqual(pkg.contributes.commands.filter(c => /switch/i.test(c.command) || /switch device/i.test(c.title)), [], 'package.json contributes no Switch device');
  await run('decky-toolkit.connect', seedId());
  await settle();
  return offered.labels.filter(Boolean).join(' | ');
});

await check('the … overflow menu: only Rename and Forget device; no manual pairing anywhere', async () => {
  let offered;
  ui.quickPick = items => { offered = items.map(i => i.label); };
  await run('decky-toolkit.deviceActions', seedId());
  assert.deepEqual(offered.map(l => l.replace(/^\$\([^)]+\) /, '')), ['Rename…', 'Forget device']);
  for (const id of ['decky-toolkit.enterToken', 'decky-toolkit.pairAgain', 'decky-toolkit.changeHost', 'decky-toolkit.editDevice', 'decky-toolkit.disconnect']) {
    assert.ok(!calls.commands.has(id), `${id} is gone`);
  }
  assert.doesNotMatch(JSON.stringify(pkg.contributes), /Re-pair|Enter token|token manually/);
  ui.inputBox = opts => { assert.equal(opts.value, '10.1.2.3'); return '  Living room Deck  '; };
  await run('decky-toolkit.renameDevice', seedId());
  assert.equal(globalState.get('decky-toolkit.devices')[0].name, 'Living room Deck');
  const [row] = devicesProvider().getChildren();
  assert.equal(row.label, 'Living room Deck');
  assert.match(row.description, /^10\.1\.2\.3:8765 · v0\.2\.0 · /);
  ui.inputBox = () => '10.1.2.3';
  await run('decky-toolkit.renameDevice', seedId());
  return offered.join(' | ');
});

import assert from 'assert/strict';
import * as https from 'https';
import * as path from 'path';
import {
  ago, appRom, calls, check, CT_USER, device, deviceFetch, dirsChained, dirsVVVVVV, EventEmitter, ext, fail, fakeFs,
  files, games, itemMenu, labels, lastMessage, pairedIdentity, run, savesChained, savesVVVVVV, seedId, settle, STEAM,
  tree, ui, vscode,
} from './harness.mjs';

await check('Games view with fake clients: Proton title with saves, native title, shortcut, errors', async () => {
  const device = { id: 'g', name: 'Deck', host: '10.0.70.18', port: 8765 };
  const fakeConn = client => ({ connectedDevice: device, link: 'connected', authedClient: () => client, onDidChangeTarget: new EventEmitter().event, label: 'Deck' });
  const listings = {
    [`${CT_USER}/AppData/Local/ChainedTogether/Saved/SaveGames`]: [
      { path: 'Save.sav', type: 'file', size: 2348, mtime: ago(20000) }, { path: 'Backup', type: 'dir', size: 0, mtime: ago(20000) },
      { path: 'Progress.sav', type: 'file', size: 30519, mtime: ago(3650) }, { path: 'notes.txt', type: 'file', size: 12, mtime: ago(20000) },
    ],
  };
  const fsCalls = [];
  const client = {
    apps: async () => ({ count: games.apps.length, apps: games.apps }),
    appDirs: async id => { if (!games.dirs[id]) throw new Error('app 4289220546 has no folders'); return games.dirs[id]; },
    appSaves: async id => { if (id === 4289220546) throw new Error('Steam is busy'); return games.saves[id]; },
    fsList: async p => { fsCalls.push(p); return { path: p, depth: 1, glob: null, entries: listings[p] ?? [], count: 0, truncated: false }; },
  };
  const tree = new ext.GamesTreeProvider(fakeConn(client));
  const rows = await tree.getChildren();
  assert.deepEqual(rows.map(r => [r.label, r.description, r.iconPath.id, r.contextValue, r.collapsibleState]), [
    ['VVVVVV', 'Linux runtime · running', 'play-circle', 'game.running', 1],
    ['Chained Together', 'Proton 11', 'game', 'game', 1],
    ['1080° Avalanche', 'native', 'game', 'game', 1],
  ], 'installed only, last played first');
  const inline = r => itemMenu('decky-toolkit.games', r.contextValue, true);
  assert.deepEqual(rows.map(inline), [
    ['decky-toolkit.gameTerminate', 'decky-toolkit.openGameSaves'], ['decky-toolkit.gameLaunch', 'decky-toolkit.openGameSaves'], ['decky-toolkit.gameLaunch', 'decky-toolkit.openGameSaves']]);
  assert.deepEqual(itemMenu('decky-toolkit.games', 'game', false),
    ['decky-toolkit.openGameSaves', 'decky-toolkit.gameLaunch', 'decky-toolkit.gameProtonLog', 'decky-toolkit.copyDeckyPath']);
  assert.match(rows[1].tooltip.value, /Proton 11\.0-2/);

  const proton = await tree.getChildren(rows[1]);
  assert.deepEqual(proton.map(c => [c.label, c.description]), [
    ['Save data', '3 files'], ['Install folder', '~/.local/share/Steam/steamapps/common/ChainedTogether'], ['Proton prefix', 'Proton 11'],
    ['Steam Cloud (userdata)', 'userdata/95599472/2567870'], ['Shader cache', undefined], ['Proton log', undefined]]);
  const [saveGroup, install, prefix, , , log] = proton;
  assert.equal(saveGroup.collapsibleState, 2, 'Save data starts expanded');
  assert.deepEqual(log.command, { command: 'decky-toolkit.gameProtonLog', title: 'Show log', arguments: [rows[1]] });
  assert.equal(install.resourceUri.toString(), `decky://10.0.70.18${STEAM}/steamapps/common/ChainedTogether`);
  assert.deepEqual(itemMenu('decky-toolkit.games', install.contextValue, true), ['decky-toolkit.openInExplorer']);
  assert.deepEqual(itemMenu('decky-toolkit.games', install.contextValue, false), ['decky-toolkit.openInExplorer', 'decky-toolkit.copyDeckyPath']);
  const locs = await tree.getChildren(saveGroup);
  assert.deepEqual(locs.map(l => [l.label, l.description, l.iconPath.id, l.collapsibleState]), [
    ['AppData/Local/ChainedTogether/Saved/SaveGames', '2 saves · 1 h ago', 'cloud', 2],
    ['AppData/Local/ChainedTogether/Saved/Config/Windows', '1 save · 5 h ago', 'folder', 1]]);
  assert.equal(locs[0].explorerName, 'Chained Together saves');
  const files = await tree.getChildren(locs[0]);
  assert.deepEqual(files.map(f => [f.label, f.contextValue, f.iconPath.id, f.description]), [
    ['Backup', 'deckyDir', 'folder', undefined], ['notes.txt', 'deckyFile', 'file', '12 B · 5 h ago'],
    ['Progress.sav', 'deckyFile', 'save', '30 KB · 1 h ago'], ['Save.sav', 'deckyFile', 'save', '2.3 KB · 5 h ago']], 'folders first, saves marked');
  assert.deepEqual(files[2].command, { command: 'vscode.open', title: 'Open', arguments: [files[2].resourceUri] });
  assert.equal(files[2].resourceUri.toString(), `decky://10.0.70.18${CT_USER}/AppData/Local/ChainedTogether/Saved/SaveGames/Progress.sav`);
  assert.equal(tree.getParent(files[2]), locs[0]);
  assert.equal(tree.getParent(rows[1]), undefined);
  assert.deepEqual((await tree.getChildren(files[0])).map(e => e.label), ['Empty folder']);
  const shortcuts = await tree.getChildren(prefix);
  assert.deepEqual(shortcuts.map(s => [s.label, s.description]), [
    ['AppData/Local', 'ChainedTogether'], ['AppData/Roaming', undefined], ['Documents', undefined], ['Saved Games', undefined], ['drive_c', undefined]]);
  assert.equal(shortcuts[0].devicePath, `${CT_USER}/AppData/Local`);
  assert.equal(prefix.devicePath, CT_USER);

  const native = await tree.getChildren(rows[0]);
  assert.deepEqual(native.map(c => [c.label, c.description]), [
    ['Save data', '3 files'], ['Game data', '~/.local/share/VVVVVV'], ['Install folder', '~/.local/share/Steam/steamapps/common/vvvvvv'],
    ['Steam Cloud (userdata)', 'userdata/95599472/70300'], ['Shader cache', undefined], ['Launch log', undefined]], 'no prefix for a native title');
  const nativeLocs = await tree.getChildren(native[0]);
  assert.deepEqual(nativeLocs.map(l => [l.label, l.description]), [['~/.local/share/VVVVVV/saves', '3 saves · 5 min ago']]);

  const rom = await tree.getChildren(rows[2]);
  assert.deepEqual(rom.map(c => [c.label, c.description]), [
    ['Save data', 'unavailable'], ['Could not load folders: app 4289220546 has no folders', undefined], ['Launch log', undefined]]);
  assert.deepEqual((await tree.getChildren(rom[0])).map(c => c.label), ['Could not load saves: Steam is busy']);

  let fail = true;
  const flaky = new ext.GamesTreeProvider(fakeConn({ apps: async () => { if (fail) throw new Error('boom'); return { count: 0, apps: [] }; } }));
  const [e] = await flaky.getChildren();
  assert.equal(e.label, 'Could not load games: boom');
  assert.equal(e.command.command, 'decky-toolkit.refreshGames');
  fail = false;
  assert.deepEqual(labels(await flaky.getChildren()), ['No installed games'], 'an error is not cached');
  const unpaired = new ext.GamesTreeProvider({ ...fakeConn(undefined), connectedDevice: undefined, link: undefined });
  assert.deepEqual(await unpaired.getChildren(), []);
  return `${rows.map(r => `${r.label} — ${r.description}`).join(' | ')}; Proton children ${proton.map(c => c.label).join(', ')}`;
});

await check('Find game QuickPick builder and labels', async () => {
  const now = Date.now();
  const picks = ext.buildGamePicks(games.apps, now);
  assert.deepEqual(picks.map(p => [p.label, p.description, p.detail]), [
    ['$(play-circle) VVVVVV', 'Linux runtime', '70300 · running · 72 MB'],
    ['$(game) Chained Together', 'Proton 11', '2567870 · played 1 h ago · 7.9 GB'],
    ['$(game) 1080° Avalanche', 'native · non-Steam', '4289220546 · never played'],
  ]);
  assert.equal(picks[1].app.appid, 2567870);
  const many = Array.from({ length: 124 }, (_, i) => ({ ...appRom, appid: i + 1, name: `ROM ${i}`, last_played: i % 3 ? ago(i * 100) : null }));
  const big = ext.buildGamePicks(many, now);
  assert.equal(big.length, 124);
  assert.deepEqual(big.slice(0, 2).map(p => p.label), ['$(game) ROM 1', '$(game) ROM 2']);
  assert.equal(big.at(-1).detail.endsWith('never played'), true);
  assert.deepEqual(['proton_experimental', 'proton_9', 'steamlinuxruntime', 'GE-Proton9-20', null].map(t => ext.runtimeLabel({ compat_tool: t, compat_tool_display: t === 'GE-Proton9-20' ? 'GE-Proton9-20' : null })),
    ['Proton Experimental', 'Proton 9', 'Linux runtime', 'GE-Proton9-20', 'native']);
  assert.deepEqual([0, 1023, 2048, 30519, 8493964009].map(ext.formatSize), ['0 B', '1023 B', '2.0 KB', '30 KB', '7.9 GB']);
  assert.equal(ext.bestSaveFolder(savesVVVVVV, dirsVVVVVV), '/home/jackh/.local/share/VVVVVV/saves');
  assert.equal(ext.bestSaveFolder({ ...savesChained, candidates: [] }, dirsChained), `${CT_USER}/AppData/Local/ChainedTogether`);
  assert.equal(ext.bestSaveFolder({ ...savesVVVVVV, candidates: [] }, dirsVVVVVV), '/home/jackh/.local/share/VVVVVV');
  return picks.map(p => `${p.label} — ${p.description} — ${p.detail}`).join(' | ');
});

await check('Games commands: Find game reveals, Open save data adds a decky:// workspace folder, launch / terminate (confirm) / Proton log', async () => {
  await run('decky-toolkit.connect', seedId());
  await settle();
  run('decky-toolkit.refreshGames');
  let offered;
  ui.quickPick = (items, opts) => { offered = { items, opts }; return items.find(i => i.label.includes('VVVVVV')); };
  await run('decky-toolkit.findGame');
  assert.equal(offered.opts.matchOnDescription, true);
  assert.deepEqual(offered.items.map(i => i.label), ['$(play-circle) VVVVVV', '$(game) Chained Together', '$(game) 1080° Avalanche']);
  const rev = calls.revealed.at(-1);
  assert.equal(rev.id, 'decky-toolkit.games');
  assert.equal(rev.node.app.appid, 70300);
  assert.deepEqual(rev.opts, { select: true, focus: true, expand: true });

  await run('decky-toolkit.openGameSaves');
  assert.deepEqual(calls.folderUpdates.map(f => [f.start, f.deleteCount, f.folders.map(x => [x.uri.toString(), x.name])]), [
    [0, 0, [['decky://10.1.2.3/home/jackh/.local/share/VVVVVV/saves', 'VVVVVV saves (10.1.2.3)']]]]);
  const gameRow = (await tree('decky-toolkit.games').provider.getChildren()).find(r => r.app?.appid === 2567870);
  await run('decky-toolkit.openGameSaves', gameRow);
  assert.equal(calls.folderUpdates.at(-1).folders[0].uri.toString(), `decky://10.1.2.3${CT_USER}/AppData/Local/ChainedTogether/Saved/SaveGames`);
  assert.equal(calls.folderUpdates.at(-1).folders[0].name, 'Chained Together saves (10.1.2.3)');

  await run('decky-toolkit.gameLaunch', gameRow);
  assert.deepEqual(games.calls.at(-1), { action: 'launch', appid: 2567870, body: {} });
  assert.match(lastMessage('info').m, /Chained Together is running/);

  const vRow = (await tree('decky-toolkit.games').provider.getChildren()).find(r => r.app?.appid === 70300);
  const before = games.calls.length;
  ui.warning = () => undefined;
  await run('decky-toolkit.gameTerminate', vRow);
  assert.equal(games.calls.length, before, 'cancelled confirm sends nothing');
  assert.match(lastMessage('warning').m, /Terminate VVVVVV on/);
  ui.warning = (_m, buttons) => buttons[0];
  await run('decky-toolkit.gameTerminate', vRow);
  assert.deepEqual(games.calls.at(-1), { action: 'terminate', appid: 70300, body: { confirm: true } });

  await run('decky-toolkit.gameProtonLog', gameRow);
  const doc = calls.docs.at(-1).doc;
  assert.equal(doc.language, 'log');
  assert.match(doc.content, /^# Chained Together \(2567870\) on /);
  assert.match(doc.content, /PROTON_LOG=1/);
  assert.match(doc.content, /StartSession: appID 2567870/);

  ui.inputBox = () => '~/.local/share/VVVVVV/saves/tsave.vvv';
  const opened = [];
  const realExec = vscode.commands.executeCommand;
  vscode.commands.executeCommand = async (id, ...args) => { opened.push([id, ...args.map(String)]); return realExec(id, ...args); };
  try {
    await run('decky-toolkit.openDeckyPath');
    assert.deepEqual(opened.at(-1), ['vscode.open', 'decky://10.1.2.3/home/jackh/.local/share/VVVVVV/saves/tsave.vvv']);
    ui.inputBox = () => '/home/jackh/.local/share/VVVVVV/current/';
    await run('decky-toolkit.openDeckyPath');
    assert.equal(calls.folderUpdates.at(-1).folders[0].uri.toString(), 'decky://10.1.2.3/home/jackh/.local/share/VVVVVV/current', 'symlink to a folder opens as a folder');
  } finally {
    vscode.commands.executeCommand = realExec;
  }
  await run('decky-toolkit.copyDeckyPath', gameRow);
  assert.equal(calls.clipboard.at(-1), `${STEAM}/steamapps/common/ChainedTogether`);
  return `revealed ${rev.node.label}; folders ${calls.folderUpdates.map(f => f.folders[0].name).join(', ')}; app calls ${games.calls.map(c => c.action).join(', ')}`;
});

await check('remote FS provider against a fake /fs* server: stat, readDirectory, read/write round trip, mkdir, rename, delete (confirm), errors', async () => {
  const devices = [
    { id: 'd1', name: 'Deck', host: '10.1.2.3', port: 8765 },
    { id: 'd2', name: 'Gone', host: '10.9.9.9', port: 8765 },
    { id: 'd3', name: 'Fresh', host: '10.1.2.4', port: 8765 },
  ];
  const fs = new ext.DeckyFileSystemProvider({ devices, identityFor: async d => (d.host === '10.1.2.4' ? undefined : pairedIdentity) });
  const events = [];
  fs.onDidChangeFile(e => events.push(...e.map(x => [x.type, x.uri.path])));
  const U = p => ext.deckyUri({ host: '10.1.2.3', port: 8765 }, p);
  const code = async p => { try { await p; } catch (e) { assert.ok(e instanceof vscode.FileSystemError, String(e)); return [e.code, e.message]; } assert.fail('expected an error'); };
  const dec = b => new TextDecoder().decode(b);
  const VV = '/home/jackh/.local/share/VVVVVV';

  assert.equal(ext.deckyUri({ host: '10.1.2.3', port: 9000 }, '/x').toString(), 'decky://10.1.2.3:9000/x');
  assert.equal(ext.globEscape('a[1]*?.sav'), 'a[[]1][*][?].sav');
  assert.equal((await fs.stat(U('/'))).type, vscode.FileType.Directory);
  assert.deepEqual(await fs.stat(U(`${VV}/saves`)), { type: 2, size: 0, mtime: Date.parse('2026-11-04T09:35:42+00:00'), ctime: Date.parse('2026-11-04T09:35:42+00:00') });
  assert.deepEqual([(await fs.stat(U(`${VV}/saves/tsave.vvv`))).type, (await fs.stat(U(`${VV}/saves/tsave.vvv`))).size], [1, 7]);
  assert.equal((await fs.stat(U(`${VV}/current`))).type, 64 | 2, 'symlink to a dir');
  assert.deepEqual(await code(fs.stat(U(`${VV}/nope`))), ['FileNotFound', `decky://10.1.2.3${VV}/nope`]);
  assert.ok(fakeFs.log.includes(`GET /fs?path=${encodeURIComponent(`${VV}/saves`)}&glob=tsave.vvv`), 'stat lists the parent with an exact glob');

  assert.deepEqual(await fs.readDirectory(U(VV)), [['saves', 2], ['current', 64 | 2]]);
  assert.deepEqual(await fs.readDirectory(U(`${VV}/saves`)), [['tsave.vvv', 1], ['unlock.vvv', 1]]);
  const n = fakeFs.log.length;
  await fs.stat(U(`${VV}/saves/unlock.vvv`));
  assert.equal(fakeFs.log.length, n, 'stat right after readDirectory uses the listing');
  assert.equal(dec(await fs.readFile(U(`${VV}/saves/tsave.vvv`))), '<Save/>');

  await fs.writeFile(U(`${VV}/saves/new/edited.vvv`), new TextEncoder().encode('v1'), { create: true, overwrite: true });
  assert.equal(dec(await fs.readFile(U(`${VV}/saves/new/edited.vvv`))), 'v1');
  await fs.writeFile(U(`${VV}/saves/new/edited.vvv`), new TextEncoder().encode('v2 ✓'), { create: false, overwrite: true });
  assert.equal(dec(await fs.readFile(U(`${VV}/saves/new/edited.vvv`))), 'v2 ✓', 'round trip keeps UTF-8 bytes');
  assert.equal((await fs.stat(U(`${VV}/saves/new/edited.vvv`))).size, 6, 'stat after a write is not served from a stale listing');
  assert.deepEqual((await code(fs.writeFile(U(`${VV}/saves/x.vvv`), new Uint8Array(1), { create: false, overwrite: true })))[0], 'FileNotFound');
  assert.deepEqual((await code(fs.writeFile(U(`${VV}/saves/tsave.vvv`), new Uint8Array(1), { create: true, overwrite: false })))[0], 'FileExists');
  assert.deepEqual((await code(fs.readFile(U(`${VV}/saves`))))[0], 'FileIsADirectory');

  await fs.createDirectory(U(`${VV}/saves/slot2`));
  assert.deepEqual((await code(fs.createDirectory(U(`${VV}/saves/slot2`))))[0], 'FileExists');
  await fs.rename(U(`${VV}/saves/new/edited.vvv`), U(`${VV}/saves/slot2/edited.vvv`), { overwrite: false });
  assert.equal(dec(await fs.readFile(U(`${VV}/saves/slot2/edited.vvv`))), 'v2 ✓');
  assert.deepEqual((await code(fs.rename(U(`${VV}/saves/slot2/edited.vvv`), U(`${VV}/saves/tsave.vvv`), { overwrite: false })))[0], 'FileExists');
  assert.deepEqual((await code(fs.rename(U(`${VV}/saves/tsave.vvv`), ext.deckyUri({ host: '10.9.9.9', port: 8765 }, '/x'), { overwrite: false })))[0], 'NoPermissions');

  const raw = await deviceFetch(`https://10.1.2.3:8765/api/v1/fs?path=${encodeURIComponent(`${VV}/saves/slot2`)}`, { method: 'DELETE', identity: pairedIdentity });
  assert.equal(raw.status, 400, 'the fake server refuses a delete without confirm');
  await fs.delete(U(`${VV}/saves/slot2`), { recursive: true });
  assert.ok(fakeFs.log.includes(`DELETE /fs?path=${encodeURIComponent(`${VV}/saves/slot2`)}&confirm=1`), 'delete sends confirm=1');
  assert.deepEqual((await code(fs.stat(U(`${VV}/saves/slot2`))))[0], 'FileNotFound');
  assert.deepEqual(events, [
    [2, `${VV}/saves/new/edited.vvv`], [1, `${VV}/saves/new/edited.vvv`], [2, `${VV}/saves/slot2`],
    [3, `${VV}/saves/new/edited.vvv`], [2, `${VV}/saves/slot2/edited.vvv`], [3, `${VV}/saves/slot2`]]);

  const login = '/home/jackh/.local/share/Steam/config/loginusers.vdf';
  assert.deepEqual(await code(fs.readFile(U(login))), ['NoPermissions', `refused: ${login} holds Steam login credentials`]);
  assert.deepEqual((await code(fs.writeFile(U(login), new Uint8Array(1), { create: true, overwrite: true })))[0], 'NoPermissions');
  assert.deepEqual(await code(fs.writeFile(U('/home/jackh/.bashrc'), new Uint8Array(1), { create: true, overwrite: true })),
    ['NoPermissions', 'refused: /home/jackh/.bashrc is not inside a game install dir']);
  assert.deepEqual((await code(fs.delete(U(`${VV}/saves/nope`), { recursive: false })))[0], 'FileNotFound');

  const [unreach, msg] = await code(fs.stat(ext.deckyUri({ host: '10.9.9.9', port: 8765 }, '/home')));
  assert.equal(unreach, 'Unavailable');
  assert.match(msg, /Decky device Gone is not reachable \(cannot reach the device/);
  assert.deepEqual(await code(fs.readFile(ext.deckyUri({ host: '10.1.2.4', port: 8765 }, '/x'))),
    ['Unavailable', 'not paired with Decky device Fresh; connect to it in the Decky view']);
  assert.deepEqual(await code(fs.readDirectory(ext.deckyUri({ host: '10.5.5.5', port: 8765 }, '/'))),
    ['Unavailable', 'no saved Decky device 10.5.5.5; add it in the Decky view']);
  return `${fakeFs.log.length} /fs requests; events ${events.length}; errors map to FileNotFound / FileExists / FileIsADirectory / NoPermissions / Unavailable`;
});

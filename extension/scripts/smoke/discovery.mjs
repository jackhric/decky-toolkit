import assert from 'assert/strict';
import { existsSync } from 'fs';
import * as path from 'path';
import {
  assertPaired, AVAHI_ANSWER, calls, check, device, devicesProvider, EventEmitter, ext, globalState, groupNode,
  identityPath, itemMenu, lastMessage, net, oldHealth, pairedIdentity, pkg, run, seedId, settle, status,
  storedIdentity, storePaired, titleMenu, toolkitHealth, tree, ui, Uri, useFakeLan, vscode,
} from './harness.mjs';

await check('discovery: mDNS packet parsing (avahi capture) and interface/subnet selection', async () => {
  const recs = ext.parseMessage(AVAHI_ANSWER);
  assert.deepEqual(recs.map(r => r.type), [12, 16, 33, 1], 'AAAA skipped');
  const services = ext.assembleServices(recs.map(r => ({ ...r, from: '10.0.70.18' })));
  assert.deepEqual(services, [{ instance: 'bazzite', host: '10.0.70.18', port: 8765, txt: { id: 'abcd', api: '1', version: '0.2.0' } }]);
  assert.throws(() => ext.parseMessage(AVAHI_ANSWER.subarray(0, 60)));
  const q = ext.encodeQuery('_decky-toolkit._tcp.local', 12);
  assert.equal(q.subarray(12).toString('hex'), AVAHI_ANSWER.subarray(12, q.length).toString('hex'), 'same question avahi echoed');
  useFakeLan();
  const ifaces = ext.usableInterfaces(net.interfaces);
  assert.deepEqual(ifaces.map(i => `${i.name} ${i.address}/${i.prefix}`), ['eth0 10.0.70.30/24', 'wlan0 10.1.2.50/24', 'corp0 10.8.0.2/16']);
  const { subnets, hosts } = ext.sweepTargets(ifaces);
  assert.deepEqual(subnets, ['10.0.70.0/24', '10.1.2.0/24'], 'a /16 is too wide to sweep');
  assert.equal(hosts.length, 2 * 253, 'network, broadcast and own address skipped');
  assert.ok(!hosts.includes('10.0.70.30') && hosts.includes('10.0.70.1') && hosts.includes('10.0.70.254') && !hosts.includes('10.0.70.255'));
  return `${recs.length} records; ${ifaces.length} usable interfaces; sweep ${subnets.join(', ')}`;
});

await check('discovery: off → no group and no Search network action', async () => {
  assert.equal(groupNode(), undefined);
  assert.deepEqual(titleMenu('decky-toolkit.devices'), ['decky-toolkit.addDevice', 'decky-toolkit.refresh']);
  calls.context.set('config.decky-toolkit.discovery.enabled', true);
  try {
    assert.deepEqual(titleMenu('decky-toolkit.devices'), ['decky-toolkit.addDevice', 'decky-toolkit.searchNetwork', 'decky-toolkit.refresh']);
  } finally {
    calls.context.delete('config.decky-toolkit.discovery.enabled');
  }
  const cmd = pkg.contributes.commands.find(c => c.command === 'decky-toolkit.searchNetwork');
  assert.deepEqual([cmd.title, cmd.icon], ['Search network', '$(search)']);
  assert.equal(pkg.contributes.configuration.properties['decky-toolkit.discovery.enabled'].default, true);
  return 'title: Add, Search network, Refresh';
});

await check('discovery: Search network finds devices via mDNS and the subnet sweep, ignores the rest', async () => {
  net.probed.length = 0;
  net.queries.length = 0;
  await vscode.workspace.getConfiguration('decky-toolkit').update('discovery.enabled', true);
  assert.equal(groupNode().iconPath.id, 'radio-tower', 'turning it on does not scan by itself');
  tree('decky-toolkit.devices').view._visibility.fire({ visible: true });
  assert.equal(groupNode().iconPath.id, 'loading~spin', 'opening the Devices view scans');
  const scan = run('decky-toolkit.searchNetwork');
  await settle(5);
  const busy = groupNode();
  assert.equal(busy.iconPath.id, 'loading~spin');
  assert.equal(busy.description, 'searching…');
  await scan;
  assert.deepEqual(net.queries.map(q => [q.iface, q.addr, q.port]), [['10.0.70.30', '224.0.0.251', 5353], ['10.1.2.50', '224.0.0.251', 5353], ['10.8.0.2', '224.0.0.251', 5353]]);
  assert.ok(net.probed.every(h => /^10\.(0\.70|1\.2)\.\d+:8765$/.test(h)), 'only the two local /24s, port 8765');
  assert.ok(net.probed.includes('10.0.70.99:8765'), 'slow host probed and timed out');
  const g = groupNode();
  assert.equal(g.label, 'On this network');
  assert.equal(g.iconPath.id, 'radio-tower');
  assert.equal(g.description, '2 found');
  assert.equal(g.collapsibleState, 2);
  assert.deepEqual(itemMenu('decky-toolkit.devices', g.contextValue, true), ['decky-toolkit.searchNetwork']);
  const kids = devicesProvider().getChildren(g);
  assert.deepEqual(kids.map(k => [k.label, k.description, k.iconPath.id, k.contextValue]), [
    ['bazzite', '10.0.70.18 · v0.3.0', 'vm', 'deck.found'],
    ['10.0.70.40', '10.0.70.40 · v0.2.0', 'vm', 'deck.found'],
    ['Add a device by address…', undefined, 'add', 'discovery.add'],
  ], 'saved 10.1.2.3, the other services, the HTML page and the slow host are left out');
  assert.match(kids[0].tooltip.value, /Decky Toolkit 0\.3\.0, API v1 · Bazzite/);
  assert.match(kids[1].tooltip.value, /Decky Toolkit 0\.2\.0, API none/);
  assert.deepEqual(kids[0].command, { command: 'decky-toolkit.connectFound', title: 'Connect', arguments: ['10.0.70.18:8765'] });
  assert.deepEqual(itemMenu('decky-toolkit.devices', 'deck.found', true), ['decky-toolkit.connectFound']);
  assert.deepEqual(itemMenu('decky-toolkit.devices', 'deck.found', false), ['decky-toolkit.connectFound']);
  assert.equal(kids[2].command.command, 'decky-toolkit.addDevice');
  return `${kids.length - 1} found from ${net.probed.length} probes and ${net.queries.length} mDNS queries`;
});

await check('discovery engine: found/lost events, throttled start, stop, probe cap', async () => {
  const d = new ext.DeviceDiscovery(() => []);
  const events = [];
  d.onDidChange(e => events.push({ found: e.found.map(x => x.key), lost: e.lost.map(x => x.key) }));
  await d.rescan();
  assert.deepEqual(events.at(-1).found.sort(), ['10.0.70.18:8765', '10.0.70.40:8765', '10.1.2.3:8765']);
  assert.equal(d.devices.find(x => x.key === '10.0.70.18:8765').via, 'mdns');
  net.hosts.delete('10.0.70.40:8765');
  net.hosts.set('10.1.2.77:8765', toolkitHealth('steamdeck-2'));
  // Same device_id at a second address (Wi-Fi + Ethernet) is listed once.
  net.hosts.set('10.1.2.78:8765', toolkitHealth('steamdeck-2'));
  await d.rescan();
  assert.deepEqual(events.at(-1), { found: ['10.1.2.77:8765'], lost: ['10.0.70.40:8765'] });
  const n = net.probed.length;
  d.start();
  assert.equal(d.scanning, false, 'start() right after a scan does nothing');
  assert.equal(net.probed.length, n);
  const pending = d.rescan();
  assert.equal(d.scanning, true);
  d.stop();
  await pending;
  assert.equal(d.scanning, false);
  assert.ok(d.devices.some(x => x.key === '10.1.2.77:8765'), 'stop keeps the previous results');
  ext.discoveryTimings.maxProbes = 300;
  try {
    await d.rescan();
    assert.equal(d.lastScan.truncated, true);
    assert.equal(d.lastScan.probes, 300 + 1, 'capped sweep plus one mDNS hit');
  } finally {
    ext.discoveryTimings.maxProbes = 1024;
  }
  d.dispose();
  net.hosts.delete('10.1.2.77:8765');
  net.hosts.delete('10.1.2.78:8765');
  net.hosts.set('10.0.70.40:8765', oldHealth);
  return JSON.stringify(events);
});

await check('discovery: Add on a found device asks to replace the saved one; Replace saves it alone, deletes the old pairing and pairs', async () => {
  await storePaired();
  await settle();
  const oldId = seedId();
  const reqs = device.pairRequests.length;
  let kids = devicesProvider().getChildren(groupNode());
  await run('decky-toolkit.connectFound', kids[0]);
  await settle();
  assert.equal(lastMessage('warning').m, 'Replace 10.1.2.3?');
  assert.deepEqual(globalState.get('decky-toolkit.devices').map(d => d.id), [oldId], 'Cancel: unchanged');
  assert.ok(storedIdentity(), 'Cancel keeps the pairing');
  assert.equal(device.pairRequests.length, reqs, 'no pairing request');

  device.pairQueue = ['approved'];
  ui.warning = (_m, buttons) => buttons[0];
  kids = devicesProvider().getChildren(groupNode());
  await run('decky-toolkit.connectFound', kids[0]);
  await settle();
  const list = globalState.get('decky-toolkit.devices');
  assert.equal(list.length, 1, 'exactly one saved device');
  assert.deepEqual({ ...list[0], id: undefined }, { id: undefined, name: 'bazzite', host: '10.0.70.18', port: 8765 });
  assert.equal(storedIdentity(), undefined, 'the replaced device\'s pairing is deleted');
  assert.equal(device.pairRequests.length, reqs + 1, 'a pairing request was filed');
  assertPaired('decky-toolkit.identity:10.0.70.18:8765');
  const group = devicesProvider().getChildren(groupNode());
  assert.ok(!group.some(k => k.label === 'bazzite'), 'the saved device leaves the group; it has its own row');
  assert.ok(group.some(k => k.label === 'steamdeck' && k.contextValue === 'deck.found'), 'the replaced one is listed as found again');
  assert.equal(groupNode().description, '2 found', 'only unsaved devices are counted');
  const rows = devicesProvider().getChildren().filter(r => r.device);
  assert.deepEqual(rows.map(r => [r.device.host, r.contextValue]), [['10.0.70.18', 'deck.session']]);
  return `replaced 10.1.2.3 with ${list[0].name} and paired`;
});

await check('discovery: hasDevices stays true while only found devices are listed; turning discovery off', async () => {
  ui.warning = () => 'Remove';
  for (const d of globalState.get('decky-toolkit.devices')) await run('decky-toolkit.removeDevice', d.id);
  await settle();
  assert.equal(existsSync(identityPath), false, 'Forget removes the identity file');
  assert.deepEqual(globalState.get('decky-toolkit.devices'), []);
  assert.equal(calls.context.get('decky-toolkit.hasDevices'), true, 'the found 10.0.70.40 and 10.1.2.3 keep the tree');
  assert.deepEqual(devicesProvider().getChildren().map(n => n.contextValue), ['discovery.group']);
  await vscode.workspace.getConfiguration('decky-toolkit').update('discovery.enabled', false);
  assert.deepEqual(devicesProvider().getChildren(), []);
  assert.equal(calls.context.get('decky-toolkit.hasDevices'), false);
  ui.warning = () => undefined;
  await run('decky-toolkit.searchNetwork');
  assert.match(lastMessage('info').m, /network discovery is turned off/);
  assert.equal(groupNode(), undefined);
  return 'hasDevices true → false';
});

await check('decky:// reports reachability to the connection; decorations mark files of a device that cannot serve them', async () => {
  const zed = { id: 'z', name: 'Zed', host: '10.9.9.9', port: 8765 };
  const notes = [];
  const fs = new ext.DeckyFileSystemProvider({ devices: [zed], identityFor: async () => pairedIdentity, noteReachable: (d, ok) => notes.push([d.id, ok]) });
  const err = await fs.readFile(ext.deckyUri(zed, '/home/x')).catch(e => e);
  assert.equal(err.code, 'Unavailable');
  assert.deepEqual(notes, [['z', false]]);
  let status = 'unreachable';
  const statusChanged = new EventEmitter();
  const state = { devices: [zed], connectedDevice: undefined, rejected: false, statusOf: () => status, onDidChangeStatus: statusChanged.event };
  const deco = new ext.DeckyFileDecorations(state);
  let fired = 0;
  deco.onDidChangeFileDecorations(() => fired++);
  const uri = ext.deckyUri(zed, '/home/x');
  const lost = deco.provideFileDecoration(uri);
  assert.deepEqual([lost.badge, lost.color.id], ['!', 'list.warningForeground']);
  assert.match(lost.tooltip, /^Lost connection to Zed/);
  status = 'disconnected';
  statusChanged.fire();
  assert.equal(fired, 1, 'a status change redraws the decorations');
  assert.equal(deco.provideFileDecoration(uri), undefined, 'paired and reachable: no mark, even without a session');
  status = 'unpaired';
  assert.match(deco.provideFileDecoration(uri).tooltip, /^Not paired with Zed/);
  assert.match(deco.provideFileDecoration(ext.deckyUri({ host: '10.4.4.4', port: 8765 }, '/a')).tooltip, /^No saved Decky device 10\.4\.4\.4/);
  assert.equal(deco.provideFileDecoration(Uri.from({ scheme: 'file', path: '/a' })), undefined);
  deco.dispose();
  return 'connection error → noteReachable(false); unreachable / unpaired / unknown device marked, reachable not';
});

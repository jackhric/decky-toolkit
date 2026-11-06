import assert from 'assert/strict';
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import * as path from 'path';
import {
  check, clientSrc, configDir, ctx, device, ext, globalState, inOtherConfigDir, noopEvent, pairedIdentity, secrets,
  settings, settle,
} from './harness.mjs';

await check('packages/client is plain Node: nothing under it imports vscode', async () => {
  const offenders = [];
  for (const f of (await import('fs')).readdirSync(clientSrc)) {
    if (/\bfrom ['"]vscode['"]|require\(['"]vscode['"]\)/.test(readFileSync(path.join(clientSrc, f), 'utf8'))) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});

await check('identity file: write/read/remove, 0700 dir and 0600 file, invalid or newer files read as null and stay', async () => {
  const id = ext.identityFile;
  await inOtherConfigDir(async (dir, file) => {
    assert.equal(id.identityPath(), file, 'DECKY_TOOLKIT_CONFIG_DIR replaces the directory');
    assert.equal(await id.read(), null, 'missing');
    const value = { version: 1, device: { host: '10.1.2.3', port: 8765, name: 'deck', deviceId: 'abc' }, ...pairedIdentity };
    await id.write(value);
    assert.deepEqual(await id.read(), value);
    if (process.platform !== 'win32') {
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.equal(statSync(file).mode & 0o777, 0o600);
    }
    assert.deepEqual((await import('fs')).readdirSync(dir), ['identity.json'], 'no temp file left behind');
    await id.write({ ...value, device: { host: '10.1.2.4', port: 1, name: 'x' } });
    assert.equal((await id.read()).device.host, '10.1.2.4', 'replaced in place');
    await id.remove();
    assert.equal(await id.read(), null);
    await id.remove();
    writeFileSync(file, '{not json');
    assert.equal(await id.read(), null, 'invalid');
    const newer = JSON.stringify({ ...value, version: 2 });
    writeFileSync(file, newer);
    assert.equal(await id.read(), null, 'newer version');
    assert.equal(await id.exists(), true);
    assert.equal(readFileSync(file, 'utf8'), newer, 'left alone');
  });
  const xdg = process.env.XDG_CONFIG_HOME;
  delete process.env.DECKY_TOOLKIT_CONFIG_DIR;
  try {
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-smoke';
    if (process.platform !== 'win32') assert.equal(id.identityPath(), '/tmp/xdg-smoke/decky-toolkit/identity.json');
  } finally {
    if (xdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = xdg;
    process.env.DECKY_TOOLKIT_CONFIG_DIR = configDir;
  }
});

await check('identity file watcher: fires on an external atomic write and on removal', async () => {
  await inOtherConfigDir(async (_dir, file) => {
    const seen = [];
    const w = ext.identityFile.watch(v => seen.push(v));
    try {
      await settle(20);
      writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, device: { host: 'h', port: 1, name: 'n' }, ...pairedIdentity }));
      renameSync(`${file}.tmp`, file);
      for (let i = 0; i < 50 && !seen.length; i++) await settle(10);
      assert.equal(seen.at(-1)?.device.host, 'h');
      seen.length = 0;
      rmSync(file);
      for (let i = 0; i < 50 && !seen.length; i++) await settle(10);
      assert.deepEqual(seen, [null]);
    } finally {
      w.close();
    }
  });
});

await check('CLI pairing: an identity file with no saved device seeds the list, and one written while the editor runs is adopted', async () => {
  await inOtherConfigDir(async (_dir, file) => {
    const state = new Map();
    const mkCtx = () => ({
      subscriptions: [], extensionUri: ctx.extensionUri,
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: noopEvent },
      globalState: { get: (k, d) => (state.has(k) ? state.get(k) : d), update: async (k, v) => { state.set(k, v); } },
      workspaceState: ctx.workspaceState,
    });
    const writeFile = device => {
      writeFileSync(`${file}.cli.tmp`, JSON.stringify({ version: 1, device, ...pairedIdentity }), { mode: 0o600 });
      renameSync(`${file}.cli.tmp`, file);
    };
    writeFile({ host: '10.1.2.3', port: 8765, name: 'deck', deviceId: 'abc' });
    const host = settings.host;
    settings.host = '';
    const c = new ext.Connection(mkCtx());
    try {
      await c.initDevices();
      assert.deepEqual(c.devices.map(d => [d.name, d.host, d.port]), [['deck', '10.1.2.3', 8765]], 'seeded from the file');
      assert.equal(c.activeDevice?.id, c.devices[0].id);
      assert.deepEqual(await c.identityFor({ host: '10.1.2.3', port: 8765 }), pairedIdentity);
      writeFile({ host: '10.1.2.4', port: 8765, name: 'other deck' });
      for (let i = 0; i < 100 && c.devices[0]?.host !== '10.1.2.4'; i++) await settle(10);
      assert.deepEqual(c.devices.map(d => d.host), ['10.1.2.4'], 'the device from a later external pairing replaces the saved one');
      assert.equal(c.devices[0].name, 'other deck');
      assert.equal(await c.identityFor({ host: '10.1.2.3', port: 8765 }), undefined, 'the old device is no longer paired');
    } finally {
      settings.host = host;
      c.dispose();
    }
  });
});

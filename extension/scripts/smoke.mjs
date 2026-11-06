// Activation smoke test against a stub `vscode` module; needs no device and no VS Code.
// Usage: node scripts/smoke.mjs
import assert from 'assert/strict';
import { calls, check, ctx, ext, mcpCalls, results, tlsServer } from './smoke/harness.mjs';

// The areas share one extension instance and fake device, and later checks build on the state earlier ones leave.
for (const area of ['identity', 'views', 'deploy', 'screen', 'connection', 'games', 'discovery', 'transport']) {
  await import(`./smoke/${area}.mjs`);
}

await check('no unexpected error messages', async () => {
  assert.deepEqual(calls.unexpectedErrors, []);
});

await check('the extension never calls the MCP tools (it uses the client API)', async () => {
  assert.deepEqual(mcpCalls, []);
});

for (const d of ctx.subscriptions) d.dispose?.();
ext.deactivate();
tlsServer.closeAllConnections();
tlsServer.close();
const failed = results.filter(r => !r).length;
console.log(failed ? `\n${failed} check(s) failed` : `\nall ${results.length} smoke checks passed`);
process.exit(failed ? 1 : 0);

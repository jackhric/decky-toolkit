// src/steam/tweak.ts under plain Node (type stripping): `pnpm test`.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { installTweakApi, list, restoreAll, setEnabled, setOff, tryTweak, tweak } from "../../src/steam/tweak.ts";

console.warn = () => {};

afterEach(() => {
  restoreAll();
  setOff([]);
});

function counter() {
  const c = { applied: 0, undone: 0 };
  const apply = () => {
    c.applied++;
    return () => {
      c.undone++;
    };
  };
  return { c, apply };
}

const status = (name: string) => list().find((t) => t.name === name)?.status;

test("applies, releases once and reports active then idle", () => {
  const { c, apply } = counter();
  const release = tweak("a", apply);
  assert.equal(status("a"), "active");
  release();
  release();
  assert.deepEqual(c, { applied: 1, undone: 1 });
  assert.equal(status("a"), "idle");
});

test("a missing internal is skipped and changes nothing", () => {
  const release = tweak("missing", () => undefined);
  assert.equal(status("missing"), "skipped");
  release();
});

test("a throw undoes what was tracked, reports failed and never escapes", () => {
  const undone: string[] = [];
  const release = tweak("broken", (track) => {
    track(() => undone.push("first"));
    track(() => undone.push("second"));
    throw new Error("boom");
  });
  assert.deepEqual(undone, ["second", "first"]);
  assert.deepEqual(list().find((t) => t.name === "broken"), { name: "broken", status: "failed", message: "boom" });
  release();
  assert.deepEqual(undone, ["second", "first"]);
});

test("a throwing undo does not stop the others or escape", () => {
  const undone: string[] = [];
  const release = tweak("undo-throws", (track) => {
    track(() => undone.push("tracked"));
    return () => {
      throw new Error("undo failed");
    };
  });
  assert.doesNotThrow(release);
  assert.deepEqual(undone, ["tracked"]);
});

test("off undoes, on applies again, and a tweak claimed while off waits", () => {
  const { c, apply } = counter();
  tweak("t", apply);
  setEnabled("t", false);
  assert.deepEqual(c, { applied: 1, undone: 1 });
  assert.equal(status("t"), "off");
  const late = counter();
  setOff(["t", "later"]);
  tweak("later", late.apply);
  assert.equal(late.c.applied, 0);
  assert.equal(status("later"), "off");
  setEnabled("t", true);
  setEnabled("later", true);
  assert.deepEqual(c, { applied: 2, undone: 1 });
  assert.equal(late.c.applied, 1);
});

test("all turns every tweak off and on; unknown names are refused", () => {
  const a = counter();
  const b = counter();
  tweak("a", a.apply);
  tweak("b", b.apply);
  setEnabled("all", false);
  assert.deepEqual(list().map((t) => t.status), ["off", "off"]);
  setEnabled("all", true);
  assert.equal(a.c.applied + b.c.applied, 4);
  assert.throws(() => setEnabled("typo", false), /unknown tweak "typo"; known: a, b/);
});

test("saved names not claimed yet are listed as off", () => {
  setOff(["page-tweak"]);
  assert.deepEqual(list(), [{ name: "page-tweak", status: "off" }]);
});

test("a trial reverts itself, early on off, and never shadows a plugin tweak", async () => {
  const { c, apply } = counter();
  const t = tryTweak("trial", apply, 0.05);
  assert.equal(t.status, "active");
  assert.ok(t.trial && t.reverts_at! >= Date.now());
  await new Promise((r) => setTimeout(r, 1100));
  assert.deepEqual(c, { applied: 1, undone: 1 });
  assert.equal(status("trial"), undefined);

  tryTweak("trial", apply, 30);
  setEnabled("trial", false);
  assert.deepEqual(c, { applied: 2, undone: 2 });

  tweak("plugin", () => () => {});
  assert.throws(() => tryTweak("plugin", apply, 30), /give the trial another name/);
  assert.equal(tryTweak("bad", (() => 42) as any, 30).status, "failed");
});

test("restoreAll undoes everything, ends trials and removes the window API it installed", () => {
  const { c, apply } = counter();
  installTweakApi();
  assert.ok((globalThis as any).__deckyToolkitSteam);
  tweak("x", apply);
  tryTweak("y", apply, 30);
  restoreAll();
  assert.deepEqual(c, { applied: 2, undone: 2 });
  assert.equal((globalThis as any).__deckyToolkitSteam, undefined);
  assert.deepEqual(list(), []);
});

test("installing over a leftover instance restores it first", () => {
  let restored = 0;
  (globalThis as any).__deckyToolkitSteam = { restoreAll: () => restored++ };
  installTweakApi();
  assert.equal(restored, 1);
  (globalThis as any).__deckyToolkitSteam = { restoreAll: () => { throw new Error("old instance broken"); } };
  assert.doesNotThrow(installTweakApi);
});

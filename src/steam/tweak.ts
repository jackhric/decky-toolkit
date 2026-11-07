// No imports: tests/frontend runs this file under plain Node.

export type Undo = () => void;
export type Apply = (track: (undo: Undo) => void) => Undo | void;
// idle: nothing claims it right now (a page-scoped tweak while its page is closed).
export type TweakStatus = "active" | "skipped" | "failed" | "off" | "idle";
export type TweakInfo = { name: string; status: TweakStatus; message?: string; trial?: true; reverts_at?: number };

type Claim = { apply: Apply; undo?: Undo };
type Entry = { name: string; claims: Set<Claim>; status: TweakStatus; message?: string; trial?: { at: number; timer?: ReturnType<typeof setTimeout> } };

const API_KEY = "__deckyToolkitSteam";
const MAX_TRIAL_SECONDS = 300;

const entries = new Map<string, Entry>();
const off = new Set<string>();
const warned = new Set<string>();

function warnOnce(name: string, err: unknown) {
  if (warned.has(name)) return;
  warned.add(name);
  console.warn(`[Decky Toolkit] Steam tweak "${name}" skipped, Steam left as it was:`, err);
}

function runAll(name: string, undos: Undo[]) {
  for (const u of [...undos].reverse()) {
    try {
      u();
    } catch (err) {
      warnOnce(`${name} (undo)`, err);
    }
  }
}

function engage(entry: Entry, claim: Claim) {
  const partial: Undo[] = [];
  try {
    const own = claim.apply((u) => partial.push(u));
    if (own !== undefined && typeof own !== "function") throw new Error("apply must return an undo function or nothing");
    const undos = own ? [...partial, own] : partial;
    entry.status = undos.length ? "active" : "skipped";
    entry.message = undefined;
    if (undos.length) claim.undo = () => runAll(entry.name, undos);
  } catch (err) {
    runAll(entry.name, partial);
    warnOnce(entry.name, err);
    entry.status = "failed";
    entry.message = err instanceof Error ? err.message : String(err);
  }
}

function disengage(claim: Claim) {
  const undo = claim.undo;
  claim.undo = undefined;
  undo?.();
}

function entryFor(name: string): Entry {
  let entry = entries.get(name);
  if (!entry) entries.set(name, (entry = { name, claims: new Set(), status: "idle" }));
  return entry;
}

function toggle(entry: Entry, on: boolean) {
  if (on === (entry.status !== "off")) return;
  if (on) {
    entry.status = "idle";
    for (const c of entry.claims) engage(entry, c);
  } else {
    for (const c of entry.claims) disengage(c);
    entry.status = "off";
    entry.message = undefined;
  }
}

/**
 * Changes Steam through an internal and returns how to release it. `apply` returns its own undo, or nothing when the
 * internal is missing (then it must have changed nothing). A throw while applying is treated the same way, after
 * undoing whatever `apply` registered with `track`. While the tweak is off (`setOff`) it is not applied, and it is
 * applied again when turned back on. The returned release runs at most once and never throws.
 */
export function tweak(name: string, apply: Apply): Undo {
  const entry = entryFor(name);
  const claim: Claim = { apply };
  entry.claims.add(claim);
  if (off.has(name)) entry.status = "off";
  else engage(entry, claim);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    disengage(claim);
    entry.claims.delete(claim);
    if (!entry.claims.size && entry.status !== "off") {
      entry.status = "idle";
      entry.message = undefined;
    }
  };
}

function info(e: Entry): TweakInfo {
  return {
    name: e.name,
    status: e.status,
    ...(e.message && { message: e.message }),
    ...(e.trial && { trial: true as const, reverts_at: e.trial.at }),
  };
}

export function list(): TweakInfo[] {
  const out = [...entries.values()].map(info);
  for (const name of off) if (!entries.has(name)) out.push({ name, status: "off" });
  return out;
}

/** Turns off exactly these tweaks (the saved setting) and every other one back on. */
export function setOff(names: Iterable<string>): TweakInfo[] {
  off.clear();
  for (const n of names) off.add(n);
  for (const entry of entries.values()) if (!entry.trial) toggle(entry, !off.has(entry.name));
  return list();
}

function endTrial(entry: Entry) {
  clearTimeout(entry.trial?.timer);
  for (const c of entry.claims) disengage(c);
  if (entries.get(entry.name) === entry) entries.delete(entry.name);
}

/** Not saved: the backend's ui_tweak saves the resulting `off` list. Turning a trial off reverts it now. */
export function setEnabled(name: string, on: boolean): TweakInfo[] {
  if (name === "all") {
    if (!on) for (const e of [...entries.values()]) if (e.trial) endTrial(e);
    return setOff(on ? [] : [...off, ...[...entries.values()].filter((e) => !e.trial).map((e) => e.name)]);
  }
  const entry = entries.get(name);
  if (entry?.trial) {
    if (on) throw new Error(`"${name}" is a trial; run it again with try`);
    endTrial(entry);
    return list();
  }
  if (!entry && !off.has(name)) {
    throw new Error(`unknown tweak "${name}"; known: ${list().map((t) => t.name).join(", ") || "none"}`);
  }
  const next = new Set(off);
  if (on) next.delete(name);
  else next.add(name);
  return setOff(next);
}

/** Applies a patch for `seconds`, then undoes it. Not saved; a frontend reload or setEnabled(name, false) ends it early. */
export function tryTweak(name: string, apply: Apply, seconds: number): TweakInfo {
  const existing = entries.get(name);
  if (existing && !existing.trial) throw new Error(`"${name}" is a Decky Toolkit tweak; give the trial another name`);
  if (existing) endTrial(existing);
  const ms = Math.max(1, Math.min(MAX_TRIAL_SECONDS, seconds)) * 1000;
  const entry: Entry = { name, claims: new Set(), status: "idle", trial: { at: Date.now() + ms } };
  const claim: Claim = { apply };
  entry.claims.add(claim);
  engage(entry, claim);
  if (entry.status !== "active") return info(entry);
  entries.set(name, entry);
  entry.trial!.timer = setTimeout(() => endTrial(entry), ms);
  return info(entry);
}

const api = { version: 1, list, off: () => [...off], setOff, setEnabled, try: tryTweak, restoreAll };

/** Undoes every tweak still applied; called when the plugin unloads, so a reload never leaves Steam changed. Never throws. */
export function restoreAll() {
  for (const entry of [...entries.values()]) {
    try {
      clearTimeout(entry.trial?.timer);
      for (const c of entry.claims) disengage(c);
    } catch (err) {
      warnOnce(`${entry.name} (undo)`, err);
    }
  }
  entries.clear();
  try {
    const g = globalThis as any;
    if (g[API_KEY] === api) delete g[API_KEY];
  } catch {
    // nothing to clean up
  }
}

/**
 * Publishes the registry on `window.__deckyToolkitSteam` for the backend's ui_tweak tool. An instance left over from
 * a reload that skipped onDismount is restored first, so its patches never stack under ours.
 */
export function installTweakApi() {
  const g = globalThis as any;
  try {
    const prev = g[API_KEY];
    if (prev && prev !== api) prev.restoreAll();
  } catch (err) {
    warnOnce("previous instance (undo)", err);
  }
  g[API_KEY] = api;
}

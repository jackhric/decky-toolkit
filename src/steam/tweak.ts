import { useEffect } from "react";

export type Undo = () => void;

const active = new Set<Undo>();
const warned = new Set<string>();

function warnOnce(name: string, err: unknown) {
  if (warned.has(name)) return;
  warned.add(name);
  console.warn(`[Decky Toolkit] Steam tweak "${name}" skipped, Steam left as it was:`, err);
}

/**
 * Changes Steam through an internal and returns how to undo it. `apply` returns its own undo, or nothing when the
 * internal is missing (then it must have changed nothing). A throw while applying is treated the same way, after
 * undoing whatever `apply` registered with `track`. The returned undo runs at most once and never throws.
 */
export function tweak(name: string, apply: (track: (undo: Undo) => void) => Undo | void): Undo {
  const partial: Undo[] = [];
  const runAll = (undos: Undo[]) => {
    for (const u of undos.reverse()) {
      try {
        u();
      } catch (err) {
        warnOnce(`${name} (undo)`, err);
      }
    }
  };
  let undos: Undo[];
  try {
    const own = apply((u) => partial.push(u));
    undos = own ? [...partial, own] : partial;
  } catch (err) {
    runAll(partial);
    warnOnce(name, err);
    return () => {};
  }
  if (!undos.length) return () => {};
  let done = false;
  const undo = () => {
    if (done) return;
    done = true;
    active.delete(undo);
    runAll(undos);
  };
  active.add(undo);
  return undo;
}

/** A tweak for as long as the calling component is mounted. */
export function useTweak(name: string, apply: Parameters<typeof tweak>[1]) {
  useEffect(() => tweak(name, apply), []);
}

/** Undoes every tweak still applied; called when the plugin unloads, so a reload never leaves Steam changed. */
export function restoreAll() {
  for (const undo of [...active]) undo();
}

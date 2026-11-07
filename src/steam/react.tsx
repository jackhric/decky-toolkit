import { afterPatch, findModuleExport } from "@decky/ui";
import { Component, ReactNode, useEffect } from "react";
import { Apply, tweak, Undo, warnOnce } from "./tweak";

/** A tweak for as long as the calling component is mounted. */
export function useTweak(name: string, apply: Apply) {
  useEffect(() => tweak(name, apply), []);
}

/** Renders nothing instead of the children once they throw, so injected UI can never take Steam's tree down. */
export class Guard extends Component<{ name: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    warnOnce(this.props.name, err);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export type Fiber = { tag: number; type: any; elementType: any; return?: Fiber | null; alternate?: Fiber | null };

export function fiberOf(node: Element | null | undefined): Fiber | undefined {
  if (!node) return undefined;
  const key = Object.keys(node).find((k) => k.startsWith("__reactFiber$"));
  return key ? (node as any)[key] : undefined;
}

const MEMO = Symbol.for("react.memo");
const source = (fn: unknown) => (typeof fn === "function" ? Function.prototype.toString.call(fn) : "");

/** The React.memo export whose component source contains every needle (the original's, under any patch). */
export function findMemo(needles: string[]): any {
  return findModuleExport((e) => e?.$$typeof === MEMO && needles.every((n) => source(e.type).includes(n)));
}

/** The mounted fiber of `memo` at or above `node`. */
export function memoFiber(node: Element | null | undefined, memo: unknown, maxDepth = 20): Fiber | undefined {
  let f: Fiber | null | undefined = fiberOf(node);
  for (let i = 0; f && i < maxDepth; i++, f = f.return) if (f.elementType === memo) return f;
  return undefined;
}

/**
 * afterPatch on a React.memo, the way Decky patches its router: `edit` may only add to Steam's `ret`, and a throw in
 * it leaves `ret` as Steam rendered it. A mounted fiber keeps the function it was created with, so after patching and
 * after unpatching it is pointed at `memo.type` (the current value, which may be another plugin's wrapper on top of
 * ours), then `rerender` makes it render once. The undo is registered with `track` before anything can throw.
 */
export function patchMemo(
  name: string,
  track: (undo: Undo) => void,
  memo: any,
  mounted: () => Fiber | undefined,
  rerender: () => void,
  edit: (props: any, ret: any) => void,
) {
  const handler = Object.assign(
    (args: any[], ret: any) => {
      try {
        edit(args[0], ret);
      } catch (err) {
        warnOnce(name, err);
      }
      return ret;
    },
    { __deckyToolkit: name },
  );
  const sync = () => {
    const f = mounted();
    for (const x of [f, f?.alternate]) if (x && x.elementType === memo) x.type = memo.type;
  };
  const patch = afterPatch(memo, "type", handler);
  track(() => {
    for (const step of [() => patch.unpatch(), sync, rerender]) {
      try {
        step();
      } catch (err) {
        warnOnce(`${name} (undo)`, err);
      }
    }
  });
  sync();
  rerender();
}

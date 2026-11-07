import { useEffect } from "react";
import { Apply, tweak } from "./tweak";

/** A tweak for as long as the calling component is mounted. */
export function useTweak(name: string, apply: Apply) {
  useEffect(() => tweak(name, apply), []);
}

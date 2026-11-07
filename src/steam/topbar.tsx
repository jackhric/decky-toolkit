import { findClassModule, Focusable, Navigation, QuickAccessTab } from "@decky/ui";
import { Mark } from "../Mark";
import { deckyState, headerHideCounter, mainDocument } from "./internals";
import { findMemo, Guard, memoFiber, patchMemo } from "./react";
import { theme } from "./theme";
import { tweak, warnOnce } from "./tweak";

export const TOP_BAR_ICON = "top-bar-icon";
const KEY = "decky-toolkit-top-bar";
const ICON_PX = 18;
// Stable parts of the top bar's source; it is also rendered inside Quick Access with `quickAccessHeader`.
const NEEDLES = ["quickAccessHeader", "BShowHeader"];

const isSearch = (c: any) => c?.props?.children?.props?.iconMovesOnHover !== undefined;

function openPanel(plugin: string) {
  try {
    deckyState()?.setActivePlugin(plugin);
  } catch (err) {
    warnOnce(`${TOP_BAR_ICON} (open)`, err);
  }
  try {
    Navigation.OpenQuickAccessMenu(QuickAccessTab.Decky);
  } catch (err) {
    warnOnce(`${TOP_BAR_ICON} (open)`, err);
  }
}

type Classes = { HeaderItem: string; Clickable: string };

function TopBarButton({ plugin, classes, useConnected }: { plugin: string; classes: Classes; useConnected: () => boolean }) {
  const connected = useConnected();
  return (
    <Focusable
      className={`${classes.HeaderItem} ${classes.Clickable}`}
      noFocusRing
      role="button"
      aria-label={plugin}
      onOKActionDescription={plugin}
      onActivate={() => openPanel(plugin)}
    >
      <Mark
        size={ICON_PX}
        // Steam's header CSS sizes svgs; pin ours to its glyph size.
        style={{ display: "block", width: ICON_PX, height: ICON_PX, color: connected ? theme.positive : theme.textMuted, transition: "color 0.4s" }}
      />
    </Focusable>
  );
}

/** The plugin's mark in Steam's top bar right after the search field (main window only), opening its Quick Access panel. */
export function showTopBarIcon(plugin: string, useConnected: () => boolean) {
  return tweak(TOP_BAR_ICON, (track) => {
    const classes = findClassModule((m) => m.HeaderItem && m.Clickable && m.NotificationsIcon) as Classes | undefined;
    const memo = findMemo(NEEDLES);
    if (!classes || !memo) return;
    const mounted = () => memoFiber(mainDocument()?.getElementById("header"), memo);
    const rerender = () => {
      const counter = headerHideCounter();
      if (!counter) return;
      counter.m_iHideHeaderCount++;
      counter.m_iHideHeaderCount--;
    };
    const button = (
      <Guard key={KEY} name={TOP_BAR_ICON}>
        <TopBarButton plugin={plugin} classes={classes} useConnected={useConnected} />
      </Guard>
    );
    patchMemo(TOP_BAR_ICON, track, memo, mounted, rerender, (props, ret) => {
      if (props?.quickAccessHeader) return;
      const items = ret?.props?.children?.props?.children;
      if (!Array.isArray(items) || items.some((c) => c?.key === KEY)) return;
      // Right after the search field, found by its iconMovesOnHover prop; else just before the bell's group (last item).
      const group = items.find((c) => Array.isArray(c?.props?.children) && c.props.children.some(isSearch))?.props.children;
      if (!group) items.splice(Math.max(0, items.length - 1), 0, button);
      else if (!group.some((c: any) => c?.key === KEY)) group.splice(group.findIndex(isSearch) + 1, 0, button);
    });
  });
}

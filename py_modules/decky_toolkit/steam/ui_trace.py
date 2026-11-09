"""The `ui` log source: a recorder in the Steam UI pages that keeps every focus, visibility, side menu, route, dialog
and keyboard change with its time. Installed on the first read; reads pull what it kept (state lives in the pages).

Gamepad focus (`.gpfocus` moving), page visibility and window focus are DOM events, so even a menu that shows for a
few ms is caught. Route, side menu, Quick Access tab, panel, dialog, keyboard and running app are Steam store values
with no change event we can rely on, so they are sampled every 20 ms on the main window's timer (SharedJSContext is a
background page whose timers Chromium may throttle)."""
import asyncio
import json
from typing import Any, AsyncIterator, Awaitable, Callable

from . import cdp
from .ui import QUICK_ACCESS_TABS, SIDE_MENUS

TargetEvaluate = Callable[[str, str], Awaitable[Any]]
# CEF target -> the name its document's events carry. SharedJSContext also records the main window's document.
TARGETS = {"SharedJSContext": None, "QuickAccess": "quick_access", "MainMenu": "main_menu"}
RING = 1000
SAMPLE_MS = 20
POLL_SECONDS = 0.1

# Shared by every page: install once per document (a reloaded page gets a new one), push events, return those after
# `since` (ms since epoch). Every Runtime.evaluate in a page shares one global scope, hence the IIFE.
_JS = """((since, label, main) => {
  const K = '__deckyToolkitUiTrace';
  const now = () => performance.timeOrigin + performance.now();
  let t = window[K];
  if (!t) {
    t = window[K] = {since: now(), events: [], docs: new WeakSet()};
    t.push = (text) => { t.events.push([now(), text]); if (t.events.length > %(ring)d) t.events.shift(); };
  }
  const desc = (el) => {
    const s = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
    return el.tagName + (s ? ' ' + JSON.stringify(s) : '');
  };
  const watch = (win, name) => {
    const doc = win && win.document;
    if (!doc || t.docs.has(doc)) return;
    t.docs.add(doc);
    t.push(name + ' ' + doc.visibilityState);
    let focused = doc.querySelector('.gpfocus');
    if (focused) t.push(name + ' focus ' + desc(focused));
    doc.addEventListener('visibilitychange', () => t.push(name + ' ' + doc.visibilityState));
    win.addEventListener('focus', (e) => { if (e.target === win) t.push(name + ' window focus'); });
    win.addEventListener('blur', (e) => { if (e.target === win) t.push(name + ' window blur'); });
    new win.MutationObserver((ms) => {
      for (const m of ms) {
        const el = m.target;
        // Steam sets the class more than once on the element it focuses; one entry per move.
        if (el !== focused && el.classList && el.classList.contains('gpfocus') && !(' ' + (m.oldValue || '') + ' ').includes(' gpfocus ')) {
          focused = el;
          t.push(name + ' focus ' + desc(el));
        }
      }
    }).observe(doc.documentElement, {attributes: true, attributeFilter: ['class'], attributeOldValue: true, subtree: true});
  };
  if (label) watch(window, label);
  if (main) {
    const W = window.SteamUIStore?.WindowStore?.GamepadUIMainWindowInstance;
    const bw = W?.m_BrowserWindow;
    watch(bw, 'big_picture');
    if (bw && t.sampled !== bw) {
      t.sampled = bw;
      const menus = %(menus)s, tabs = %(tabs)s;
      const read = () => {
        const w = window.SteamUIStore?.WindowStore?.GamepadUIMainWindowInstance, m = w?.MenuStore;
        const d = w?.m_BrowserWindow?.document?.querySelector('.ModalOverlayContent.active [role=dialog], .ModalOverlayContent.active .DialogContent');
        const title = d && ((d.querySelector('.DialogHeader')?.innerText || d.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 60));
        const app = window.SteamUIStore?.MainRunningAppID;
        const tab = m?.GetQuickAccessTab?.();
        return {route: w?.LocationPathName ?? 'none', side_menu: menus[m?.GetOpenSideMenu?.()] ?? 'none',
                quick_access_tab: tabs[tab] ?? (tab == null ? 'none' : String(tab)),
                panel: window.DeckyPluginLoader?.deckyState?.publicState?.().activePlugin?.name ?? 'none',
                dialog: d ? JSON.stringify(title) : 'none', keyboard: w?.m_VirtualKeyboardManager?.m_bIsVirtualKeyboardShowing?.m_currentValue ? 'shown' : 'hidden',
                app: app ? app + ' ' + (window.appStore?.GetAppOverviewByAppID?.(app)?.display_name ?? '') : 'none'};
      };
      let last = {};
      const tick = () => {
        try {
          const s = read();
          for (const k in s) if (s[k] !== last[k]) t.push(k + ' ' + s[k]);
          last = s;
        } catch (e) { /* the store is mid-reload; sample again next tick */ }
      };
      tick();
      bw.setInterval(tick, %(sample)d);
    }
  }
  return {since: t.since, now: now(), events: t.events.filter((e) => e[0] > since)};
})(%%s, %%s, %%s)""" % {
    "ring": RING, "sample": SAMPLE_MS,
    "menus": json.dumps({str(k): v for k, v in SIDE_MENUS.items()}),
    "tabs": json.dumps({str(v): k for k, v in QUICK_ACCESS_TABS.items()}),
}


def _iso(ms: float) -> str:
    from datetime import datetime
    return datetime.fromtimestamp(ms / 1000).astimezone().isoformat(timespec="milliseconds")


class UiTrace:
    def __init__(self, evaluate: TargetEvaluate | None = None):
        self._evaluate = evaluate or (lambda target, js: cdp.evaluate_in(target, js, timeout=5))

    @staticmethod
    def parse_cursor(since: Any) -> list[float]:
        """A cursor holds one position per page (each page has its own clock); a single number applies to all."""
        try:
            parts = [float(x) for x in str(since).split(",")]
        except ValueError:
            parts = []
        if len(parts) == 1:
            parts *= len(TARGETS)
        if len(parts) != len(TARGETS):
            raise ValueError(f"since {since!r} is not a ui cursor (pass the cursor a previous read returned)")
        return parts

    async def _pull(self, target: str, label: str | None, since: float) -> dict[str, Any]:
        js = _JS % (json.dumps(since), json.dumps(label), json.dumps(label is None))
        try:
            raw = await self._evaluate(target, js)
        except cdp.CdpError as e:
            return {"target": target, "error": str(e).splitlines()[0]}
        if not isinstance(raw, dict):
            return {"target": target, "error": "the page returned no trace"}
        return {"target": target, **raw}

    async def read(self, since: list[float] | None = None) -> dict[str, Any]:
        """Events after the cursor `since` from every page, oldest first: {recording, cursor, entries}."""
        after = since or [0.0] * len(TARGETS)
        pulls = await asyncio.gather(*(self._pull(t, label, a) for (t, label), a in zip(TARGETS.items(), after)))
        events = sorted((e for p in pulls for e in p.get("events") or []), key=lambda e: e[0])
        # A page that did not answer keeps its old position, so nothing it records meanwhile is skipped.
        cursor = ",".join(f"{p['now'] if isinstance(p.get('now'), (int, float)) else a:.3f}"
                          for p, a in zip(pulls, after))
        entries, prev = [], None
        for ts, text in events:
            entries.append({"time": _iso(ts), "dt_ms": None if prev is None else round(ts - prev, 1), "text": text})
            prev = ts
        recording = [{"target": p["target"], "since": _iso(p["since"])} if "since" in p
                     else {"target": p["target"], "error": p.get("error")} for p in pulls]
        return {"recording": recording, "cursor": cursor, "entries": entries}

    async def follow(self, since: list[float]) -> AsyncIterator[dict[str, Any]]:
        while True:
            out = await self.read(since)
            since = self.parse_cursor(out["cursor"])
            for e in out["entries"]:
                yield e
            await asyncio.sleep(POLL_SECONDS)

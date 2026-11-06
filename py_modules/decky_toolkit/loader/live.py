"""Live sync for plugin development: write single files into an installed plugin and reload it in place.

A frontend-only reload re-imports `dist/index.js` through Decky's own `importPlugin` (~10 ms, the backend keeps
running). Either reload puts the user back where they were: the plugin's Quick Access panel, its own route, the
selected settings tab and the gamepad focus.
"""
import asyncio
import json
import os
from typing import Any

from ..steam import cdp
from ..guard import check_write
from .plugins import plugin_name, plugins_dir, reload_plugin

RELOAD_MODES = ("frontend", "backend")
QUICK_ACCESS = "QuickAccess_uid2"
BIG_PICTURE = "Steam Big Picture Mode"


def _plugin_root(dirname: str) -> tuple[str, str]:
    name = plugin_name(dirname)
    return name, os.path.realpath(os.path.join(plugins_dir(), dirname))


def write_file(dirname: str, relpath: str, data: bytes) -> dict[str, Any]:
    """Atomically replace (or create) `relpath` inside the installed plugin `dirname`."""
    _, root = _plugin_root(dirname)
    if not relpath or os.path.isabs(relpath) or "\\" in relpath:
        raise ValueError("path must be relative to the plugin directory")
    target = os.path.realpath(os.path.join(root, relpath))
    if not target.startswith(root + os.sep):
        raise ValueError("path must stay inside the plugin directory")
    check_write(target)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    tmp = os.path.join(os.path.dirname(target), f".{os.path.basename(target)}.live-{os.getpid()}.tmp")
    try:
        with open(tmp, "wb") as f:
            f.write(data)
        os.chmod(tmp, 0o644)
        os.replace(tmp, target)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return {"dir": dirname, "path": os.path.relpath(target, root), "bytes": len(data)}


# What the user looks at inside one tab: the page heading (a settings sidebar tab) and the gamepad focus.
_SNAPSHOT = """(() => ({ header: document.querySelector('.DialogHeader')?.textContent ?? null,
  focus: document.querySelector('.gpfocus')?.textContent?.trim() ?? null }))()"""

# Steam selects a sidebar page on click, not on focus.
_RESTORE = """(async (want) => {
  const byText = t => [...document.querySelectorAll('.Focusable')].find(e => e.textContent.trim() === t);
  for (let i = 0; i < 20 && !document.querySelector('.Focusable'); i++) await new Promise(r => setTimeout(r, 25));
  const restored = [];
  if (want.header && document.querySelector('.DialogHeader')?.textContent !== want.header) {
    const tab = byText(want.header);
    if (tab) { tab.click(); restored.push('tab ' + want.header); }
  }
  if (want.focus) { const el = byText(want.focus); if (el) { el.focus(); restored.push('focus ' + want.focus); } }
  return restored;
})(__WANT__)"""

_RELOAD = """(async (name, mode) => {
  const L = window.DeckyPluginLoader, S = L.deckyState;
  const path = SteamUIStore.WindowStore.GamepadUIMainWindowInstance?.LocationPathName ?? null;
  const menu = SteamUIStore.GetFocusedWindowInstance?.()?.MenuStore?.GetOpenSideMenu?.() ?? null;
  const wasActive = S.publicState().activePlugin?.name === name;
  const old = L.plugins.find(p => p.name === name);
  const before = new Map(L.routerHook.routerState._routes);
  const errors = [];
  const origError = console.error;
  console.error = function (...args) {
    try {
      const text = args.map(a => a instanceof Error ? (a.stack || String(a)) : typeof a === 'string' ? a : '')
        .filter(s => s && !/^(background|color):/.test(s)).join(' ').replace(/%c/g, '').trim();
      if (text.includes(name)) errors.push(text.slice(0, 4000));
    } catch {}
    return origError.apply(this, args);
  };
  const t = performance.now();
  try {
    if (mode === 'backend') {
      await window.DeckyBackend.call('loader/reload_plugin', name);
      // The call returns before the loader has restarted the backend and re-imported the bundle.
      for (let i = 0; i < 600 && L.plugins.find(p => p.name === name) === old; i++) await new Promise(r => setTimeout(r, 25));
    } else {
      await L.importPlugin(name, old?.version);
    }
  } finally {
    console.error = origError;
  }
  const loadMs = Math.round(performance.now() - t);
  const reloaded = L.plugins.find(p => p.name === name) !== old;
  const after = L.routerHook.routerState._routes;
  // Decky records no route owner; a reloaded plugin re-registers its routes as new entries.
  const own = [...after.keys()].filter(r => before.get(r) !== after.get(r));
  const restored = [];
  if (wasActive) { S.setActivePlugin(name); restored.push('panel'); }
  // Never pull the Steam UI over a game the user is playing.
  const inGame = !!SteamUIStore.MainRunningAppID && menu !== 1 && menu !== 2;
  if (path && own.includes(path) && !inGame) {
    DFL.Navigation.Navigate(path);
    restored.push('route ' + path);
    if (menu === 2) { DFL.Navigation.OpenQuickAccessMenu(DFL.QuickAccessTab.Decky); restored.push('quick access'); }
  }
  return { load_ms: loadMs, reloaded, errors: errors.slice(0, 5), restored, routes: own, menu };
})(__NAME__, __MODE__)"""

# The inspector holds an evaluated promise only weakly; once the reload's own chain (a dynamic import) is all that
# keeps it alive, V8 may collect it mid-reload ("Promise was collected"). A global keeps it until it settles.
_HELD = """(() => {
  const p = __CALL__;
  window.__deckyToolkitLive = p;
  return p.finally(() => { if (window.__deckyToolkitLive === p) delete window.__deckyToolkitLive; });
})()"""


async def _snapshot(title: str) -> dict[str, Any] | None:
    try:
        return await cdp.evaluate_in(title, _SNAPSHOT, timeout=3)
    except (cdp.CdpError, OSError, asyncio.TimeoutError):
        return None


async def reload(dirname: str, mode: str = "frontend") -> dict[str, Any]:
    """Reload a plugin in place and restore the UI around it. mode: 'frontend' or 'backend'."""
    if mode not in RELOAD_MODES:
        raise ValueError(f"mode must be one of {', '.join(RELOAD_MODES)}")
    name, _ = _plugin_root(dirname)
    own_dir = os.path.basename(os.environ.get("DECKY_PLUGIN_DIR", "").rstrip("/"))
    if mode == "backend" and dirname == own_dir:
        # Our own backend restart ends this process; nobody would be left to restore the UI.
        return {"dir": dirname, "name": name, "mode": mode, **await reload_plugin(dirname)}
    bpm, qam = await asyncio.gather(_snapshot(BIG_PICTURE), _snapshot(QUICK_ACCESS))
    call = _RELOAD.replace("__NAME__", json.dumps(name)).replace("__MODE__", json.dumps(mode))
    expr = _HELD.replace("__CALL__", call)
    try:
        result = await cdp.evaluate_in(None, expr, timeout=20)
    except cdp.CdpError as e:
        if "Promise was collected" not in str(e):
            raise
        result = await cdp.evaluate_in(None, expr, timeout=20)
    # Tab and focus only inside the plugin's own UI: matching by text anywhere else could focus a stranger.
    restored = result.get("restored", [])
    if result.get("menu") == 2 and "panel" in restored:
        snap, target = qam, QUICK_ACCESS
    elif any(r.startswith("route ") for r in restored):
        snap, target = bpm, BIG_PICTURE
    else:
        snap, target = None, None
    if snap and (snap.get("header") or snap.get("focus")):
        try:
            result["restored"] += await cdp.evaluate_in(target, _RESTORE.replace("__WANT__", json.dumps(snap)), timeout=3)
        except (cdp.CdpError, OSError, asyncio.TimeoutError):
            pass
    result.pop("menu", None)
    return {"dir": dirname, "name": name, "mode": mode, **result}

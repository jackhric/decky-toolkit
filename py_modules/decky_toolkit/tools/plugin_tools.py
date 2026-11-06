"""MCP tools that other plugins register from their frontend with `registerTool` from `decky-toolkit/tools`
(cli/src/tools.ts). The helper keeps them in a registry on `window` in SharedJSContext; this module reads it over one
long-lived DevTools session, exposes each tool as `<plugin dir prefix>_<name>` and runs `execute` in the page."""
import asyncio
import itertools
import json
import logging
import os
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from ..loader import sourcemap
from ..steam import cdp
from . import ToolRegistry, error_result, ok_result
from ..loader.plugins import plugins_dir

if TYPE_CHECKING:
    from ..server.events import EventHub

BINDING = "__deckyToolkitToolsChanged"
MAX_NAME = 64
NAME = re.compile(r"^[a-z0-9_]+$")
CALL_TIMEOUT_MS = 120_000
BACKOFF_SECONDS = (1, 2, 5, 10)
STABLE_SECONDS = 30

# Owns the registry's lifecycle: a tool belongs to the plugin entry in DeckyPluginLoader.plugins that was current when
# first seen (Decky unloads a plugin before importing its bundle again, so a registration made while its bundle loads
# is adopted by the entry pushed right after). A different entry, or a newer load (bundle URL) of the same plugin,
# drops it. Decky's importPlugin filters `plugins` into a new array and later pushes the new entry into that same array,
# so the listener compares entries, not the array: a read between the two would otherwise never hear of the push.
_SYNC = """(() => {
  const R = (window.__deckyToolkitTools ??= { version: 1, tools: new Set() });
  const L = window.DeckyPluginLoader;
  if (!L?.plugins) return '[]';
  if (!window.__deckyToolkitToolsWatch) {
    let seen = [...L.plugins];
    L.deckyState.eventBus.addEventListener('update', () => {
      const now = L.plugins;
      if (now.length !== seen.length || now.some((p, i) => p !== seen[i])) {
        seen = [...now];
        window.__deckyToolkitToolsChanged?.('');
      }
    });
    window.__deckyToolkitToolsWatch = true;
  }
  const latest = new Map();
  for (const t of R.tools) latest.set(t.plugin, t.url);
  for (const t of R.tools) {
    const entry = L.plugins.find(p => p.name === t.plugin);
    if (t.url !== latest.get(t.plugin) || (t.owner && t.owner !== entry)) R.tools.delete(t);
    else t.owner ??= entry;
  }
  return JSON.stringify([...R.tools].filter(t => t.owner).map(t => ({
    plugin: t.plugin, name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
    outputSchema: t.outputSchema, annotations: t.annotations })));
})()"""

# The evaluated promise is held on window: the inspector alone holds it weakly ("Promise was collected").
_CALL = """((plugin, name, args, ms, id) => {
  const calls = (window.__deckyToolkitCalls ??= new Map());
  // Frames below the plugin's execute are the helper's and this wrapper's.
  const cut = s => { const l = s.split('\\n'); const i = l.findIndex(x => /deckyToolkitCall|<anonymous>/.test(x)); return (i > 0 ? l.slice(0, i) : l).join('\\n'); };
  const ac = new AbortController();
  const t = [...(window.__deckyToolkitTools?.tools ?? [])].find(t => t.plugin === plugin && t.name === name && t.owner);
  const p = (async () => {
    if (!t) return JSON.stringify({ gone: true });
    const timer = setTimeout(() => ac.abort(new Error(`timed out after ${ms} ms`)), ms);
    try {
      return JSON.stringify(await t.call(args, ac.signal), (k, v) => typeof v === 'bigint' ? String(v) : v);
    } catch (e) {
      return JSON.stringify({ error: { name: String(e?.name ?? 'Error'), message: String(e?.message ?? e),
        stack: typeof e?.stack === 'string' ? cut(e.stack) : null } });
    } finally {
      clearTimeout(timer);
    }
  })().finally(() => calls.delete(id));
  calls.set(id, { p, ac });
  return p;
})(__ARGS__)"""

_ABORT = "window.__deckyToolkitCalls?.get(__ID__)?.ac.abort(new Error('the agent cancelled the call'))"


def prefix_of(dirname: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", dirname.lower()).strip("_")


@dataclass
class PluginTool:
    name: str
    plugin: str
    dir: str
    tool: str
    description: str
    input_schema: dict[str, Any]
    output_schema: dict[str, Any] | None
    title: str | None
    annotations: dict[str, Any] | None

    def describe(self) -> dict[str, Any]:
        out: dict[str, Any] = {"name": self.name, "description": f"{self.description} (from the Decky plugin {self.plugin})",
                               "inputSchema": self.input_schema}
        if self.title:
            out["title"] = self.title
        if self.output_schema:
            out["outputSchema"] = self.output_schema
        if self.annotations:
            out["annotations"] = self.annotations
        return out


class PluginTools:
    def __init__(self, logger: logging.Logger, events: "EventHub"):
        self.log = logger
        self.events = events
        self.builtin: set[str] = set()
        self._registered: list[dict[str, Any]] = []
        self._tools: dict[str, PluginTool] = {}
        self._refused: list[dict[str, Any]] = []
        self._tab: cdp.Tab | None = None
        self._task: asyncio.Task[None] | None = None
        self._dirty = asyncio.Event()
        self._ids = itertools.count(1)
        self.error: str | None = None

    # ---- naming ----

    def attach(self, reg: ToolRegistry) -> None:
        self.builtin = set(reg.names())
        reg.plugin_tools = self
        self._resolve()

    def _dirs(self) -> dict[str, str]:
        out = {}
        root = plugins_dir()
        for d in sorted(os.listdir(root)) if os.path.isdir(root) else []:
            try:
                with open(os.path.join(root, d, "plugin.json")) as f:
                    name = json.load(f).get("name")
            except (OSError, ValueError):
                continue
            if isinstance(name, str):
                out.setdefault(name, d)
        return out

    def _resolve(self) -> None:
        areas = {n.split("_", 1)[0] for n in self.builtin}
        dirs = self._dirs() if self._registered else {}
        tools: dict[str, PluginTool] = {}
        refused: list[dict[str, Any]] = []
        for r in self._registered:
            plugin, tool = str(r.get("plugin")), str(r.get("name"))
            d = dirs.get(plugin)
            prefix = prefix_of(d or "")
            name = f"{prefix}_{tool}"
            if d is None:
                reason = f"no installed plugin is named {plugin!r}"
            elif not NAME.match(tool):
                reason = "tool names are lowercase letters, digits and _"
            elif not prefix:
                reason = f"the plugin directory {d!r} gives no tool name prefix; use letters or digits in it"
            elif prefix in areas:
                reason = f"the plugin directory {d!r} gives the prefix {prefix!r}, a built-in tool area; rename the directory"
            elif len(name) > MAX_NAME:
                reason = f"{name} is longer than {MAX_NAME} characters"
            elif name in self.builtin or name in tools:
                other = tools[name].plugin if name in tools else "Decky Toolkit"
                reason = f"{name} is already a tool of {other}"
            else:
                schema = r.get("inputSchema")
                tools[name] = PluginTool(name, plugin, d, tool, str(r.get("description") or ""),
                                         schema if isinstance(schema, dict) else {"type": "object", "properties": {}},
                                         r.get("outputSchema") or None, r.get("title") or None, r.get("annotations") or None)
                continue
            refused.append({"plugin": plugin, "dir": d, "name": tool, "reason": reason})
        added, removed = tools.keys() - self._tools.keys(), self._tools.keys() - tools.keys()
        if added or removed:
            self.log.info("plugin tools: %s", ", ".join([f"+{n}" for n in sorted(added)] + [f"-{n}" for n in sorted(removed)]))
        if tools != self._tools:
            self.events.refresh("tools")
        for r in refused:
            if r not in self._refused:
                self.log.warning("plugin tools: refused %s from %s: %s", r["name"], r["plugin"], r["reason"])
        self._tools, self._refused = tools, refused

    # ---- what the registry and plugin_list see ----

    def describe(self) -> list[dict[str, Any]]:
        return [t.describe() for t in self._tools.values()]

    def get(self, name: str) -> PluginTool | None:
        return self._tools.get(name)

    def of_plugin(self, dirname: str) -> dict[str, Any] | None:
        tools = [t.name for t in self._tools.values() if t.dir == dirname]
        refused = [{"name": r["name"], "reason": r["reason"]} for r in self._refused if r["dir"] == dirname]
        return {"tools": tools, "refused": refused} if tools or refused else None

    # ---- calls ----

    async def call(self, tool: PluginTool, arguments: dict[str, Any]) -> dict[str, Any]:
        tab = self._tab
        if tab is None:
            return error_result(f"{tool.name}: the Steam UI is not reachable right now ({self.error or 'connecting'})")
        call_id = next(self._ids)
        args = ", ".join(json.dumps(a) for a in (tool.plugin, tool.tool, arguments, CALL_TIMEOUT_MS, call_id))
        try:
            raw = await tab.evaluate(_CALL.replace("__ARGS__", args), timeout=CALL_TIMEOUT_MS / 1000 + 5)
        except asyncio.CancelledError:
            if self._tab is tab:
                asyncio.ensure_future(tab.evaluate(_ABORT.replace("__ID__", str(call_id)), await_promise=False, timeout=3))
            raise
        out = json.loads(raw)
        if out.get("gone"):
            self._dirty.set()
            return error_result(f"{tool.name} is gone: {tool.plugin} unloaded or reloaded without it")
        if "invalid" in out:
            return error_result(f"Invalid arguments for {tool.name}: {out['invalid']}")
        if "error" in out:
            e = out["error"]
            text = e.get("stack") or f"{e.get('name')}: {e.get('message')}"
            dirs = self._dirs()
            text = sourcemap.map_stack(text, lambda name: os.path.join(plugins_dir(), dirs[name], "dist") if name in dirs else None)
            return error_result(text)
        value = out.get("value")
        result = ok_result(value)
        if tool.output_schema and isinstance(value, dict):
            result["structuredContent"] = value
        return result

    # ---- connection ----

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="plugin-tools")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None

    def _on_event(self, msg: dict[str, Any]) -> None:
        method, params = msg.get("method"), msg.get("params") or {}
        # A Steam UI reload starts a fresh window: its registry (and our unload watcher) are gone.
        if (method == "Runtime.bindingCalled" and params.get("name") == BINDING) or (
                method == "Page.frameNavigated" and not (params.get("frame") or {}).get("parentId")):
            self._dirty.set()

    async def refresh(self) -> None:
        if self._tab is not None:
            self._registered = json.loads(await self._tab.evaluate(_SYNC, timeout=5))
            self._resolve()

    async def _refresher(self) -> None:
        while True:
            await self._dirty.wait()
            self._dirty.clear()
            # Also woken when Decky loads or unloads any plugin (install, reload, its file watcher).
            self.events.refresh("plugins")
            try:
                await self.refresh()
            except (cdp.CdpError, asyncio.TimeoutError, ValueError) as e:
                self.log.warning("plugin tools: could not read the registry: %s", e)

    async def _run(self) -> None:
        failures = 0
        loop = asyncio.get_running_loop()
        while True:
            started = loop.time()
            try:
                async with cdp.Tab(await cdp.find_target(), self._on_event) as tab:
                    # Survives Steam UI reloads, and the page's helpers call it whenever their tools change.
                    await tab.send("Runtime.addBinding", {"name": BINDING})
                    await tab.send("Page.enable")
                    self._tab, self.error = tab, None
                    self._dirty.set()
                    refresher = asyncio.create_task(self._refresher())
                    try:
                        await tab.wait_closed()
                    finally:
                        refresher.cancel()
                        await asyncio.gather(refresher, return_exceptions=True)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - Steam restarting is routine; keep retrying
                msg = f"{type(e).__name__}: {e}"
                if msg != self.error:
                    self.log.info("plugin tools: SharedJSContext unavailable: %s", msg)
                self.error = msg
            finally:
                self._tab = None
            if self._registered:
                self._registered = []
                self._resolve()
            failures = 0 if loop.time() - started > STABLE_SECONDS else failures + 1
            await asyncio.sleep(BACKOFF_SECONDS[min(failures, len(BACKOFF_SECONDS)) - 1] if failures else BACKOFF_SECONDS[0])


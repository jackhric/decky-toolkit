"""Decky toasts in the Steam UI, for the ui_toast tool and POST /api/v1/ui/toast."""
import json
from typing import Any

from . import cdp


async def toast(title: str, body: str, duration_ms: int = 5000) -> Any:
    js = ("(async () => { const t = window.DeckyPluginLoader?.toaster; if (!t) throw new Error('DeckyPluginLoader.toaster missing');"
          f" t.toast({{ title: {json.dumps(title)}, body: {json.dumps(body)}, duration: {int(duration_ms)} }}); return 'ok'; }})()")
    return await cdp.evaluate_in(None, js)

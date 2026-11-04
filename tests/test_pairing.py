"""PairingRequests: limits, replacement, pruning, one-time token. Run with: ./scripts/test.sh"""
import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from decky_toolkit import pairing as P  # noqa: E402
from decky_toolkit.pairing import PairingLimit, PairingRequests  # noqa: E402


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def make():
    clock, events = Clock(), []
    return PairingRequests(clock=clock, on_change=lambda e, r: events.append(e)), clock, events


def test_create_validates_and_notifies():
    p, _, events = make()
    req = p.create("  VS Code   on  box ", "vscode", "10.0.0.2")
    assert req.client_name == "VS Code on box" and req.status == "pending" and len(req.code) == 4 and req.code.isdigit()
    assert len(req.id) >= 20
    assert events == ["create"]
    for name, kind in (("", "vscode"), (None, "vscode"), ("x" * 65, "vscode"), ("x", "toaster")):
        with pytest.raises(ValueError):
            p.create(name, kind, "10.0.0.2")
    p.create("x" * 64, "other", "10.0.0.3")


def test_limits_and_replacement():
    p, _, _ = make()
    first = p.create("a", "vscode", "10.0.0.2")
    p.create("b", "vscode", "10.0.0.2")
    with pytest.raises(PairingLimit):
        p.create("c", "vscode", "10.0.0.2")
    again = p.create("a", "vscode", "10.0.0.2")
    assert p.get(first.id) is None and first.changed.is_set(), "the old request is dropped and its pollers woken"
    assert again in p.pending() and len(p.pending()) == 2
    for i in range(8):
        p.create(f"n{i}", "browser", f"10.0.1.{i}")
    assert len(p.pending()) == P.MAX_PENDING
    with pytest.raises(PairingLimit):
        p.create("eleventh", "browser", "10.0.2.1")
    # Resolved requests do not count against the limit.
    p.deny(again.id)
    p.create("eleventh", "browser", "10.0.2.1")


def test_codes_unique_among_pending(monkeypatch):
    p, _, _ = make()
    seq = iter([7, 7, 7, 42])
    monkeypatch.setattr(P.secrets, "randbelow", lambda n: next(seq))
    assert p.create("a", "vscode", "1").code == "0007"
    assert p.create("b", "vscode", "2").code == "0042"


def test_token_and_cookie_delivered_once():
    p, _, events = make()
    req = p.create("a", "vscode", "1")
    assert not p.claim_token(req)
    p.approve(req.id)
    assert events[-1] == "approve"
    assert p.claim_token(req) and not p.claim_token(req)
    assert p.claim_cookie(req) and not p.claim_cookie(req)
    with pytest.raises(ValueError):
        p.deny(req.id)
    with pytest.raises(ValueError):
        p.approve("missing")


def test_prune_idle_pending_and_old_resolved():
    p, clock, events = make()
    idle = p.create("idle", "vscode", "1")
    polled = p.create("polled", "vscode", "2")
    done = p.create("done", "vscode", "3")
    p.approve(done.id)
    clock.t += 50
    p.touch(polled.id)
    clock.t += 11
    assert p.prune() == 1 and p.get(idle.id) is None and events[-1] == "prune"
    assert p.get(polled.id) and p.get(done.id)
    events.clear()
    assert p.prune() == 0 and events == []
    clock.t += P.RESOLVED_KEEP_SECONDS
    p.touch(polled.id)
    assert p.prune() == 1 and p.get(done.id) is None and p.get(polled.id)


def test_waiting_poller_is_never_pruned():
    p, clock, _ = make()
    req = p.create("a", "vscode", "1")

    async def run():
        waiting = asyncio.ensure_future(p.wait(req, 5))
        await asyncio.sleep(0.01)
        clock.t += 120
        assert p.prune() == 0
        p.approve(req.id)
        await asyncio.wait_for(waiting, 1)
        assert req.waiters == 0
    asyncio.run(run())


def test_wait_times_out_and_cancel():
    p, _, events = make()
    req = p.create("a", "vscode", "1")

    async def run():
        await p.wait(req, 0.05)
        assert req.status == "pending"
    asyncio.run(run())
    assert p.cancel(req.id) and events[-1] == "cancel" and p.get(req.id) is None
    assert not p.cancel(req.id)

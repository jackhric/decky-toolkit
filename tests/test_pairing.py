"""PairingRequests: limits, replacement, pruning, code derivation, one-time credentials. Run with: ./scripts/test.sh"""
import asyncio
import hashlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from certauth import PUBLIC_KEY  # noqa: E402
from decky_toolkit import pairing as P  # noqa: E402
from decky_toolkit.pairing import PairingLimit, PairingRequests  # noqa: E402
from decky_toolkit.tls import pem_to_der  # noqa: E402


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def make():
    clock, events = Clock(), []
    return PairingRequests(clock=clock, on_change=lambda e, r: events.append(e)), clock, events


def create(p, name, kind, remote, key=PUBLIC_KEY):
    return p.create(name, kind, key, remote)


def test_create_validates_and_notifies():
    p, _, events = make()
    req = create(p, "  VS Code   on  box ", "vscode", "10.0.0.2")
    assert req.client_name == "VS Code on box" and req.status == "pending" and len(req.code) == 4 and req.code.isdigit()
    assert len(req.id) >= 20
    assert events == ["create"]
    for name, kind in (("", "vscode"), (None, "vscode"), ("x" * 65, "vscode"), ("x", "toaster")):
        with pytest.raises(ValueError):
            create(p, name, kind, "10.0.0.2")
    create(p, "x" * 64, "other", "10.0.0.3")


def test_limits_and_replacement():
    p, _, _ = make()
    first = create(p, "a", "vscode", "10.0.0.2")
    create(p, "b", "vscode", "10.0.0.2")
    with pytest.raises(PairingLimit):
        create(p, "c", "vscode", "10.0.0.2")
    again = create(p, "a", "vscode", "10.0.0.2")
    assert p.get(first.id) is None and first.changed.is_set(), "the old request is dropped and its pollers woken"
    assert again in p.pending() and len(p.pending()) == 2
    for i in range(8):
        create(p, f"n{i}", "mcp", f"10.0.1.{i}")
    assert len(p.pending()) == P.MAX_PENDING
    with pytest.raises(PairingLimit):
        create(p, "eleventh", "mcp", "10.0.2.1")
    # Resolved requests do not count against the limit.
    p.deny(again.id)
    create(p, "eleventh", "mcp", "10.0.2.1")


def test_code_binds_server_cert_client_key_and_id(monkeypatch):
    server_cert = PUBLIC_KEY.replace("PUBLIC KEY", "CERTIFICATE")  # any DER will do for the derivation
    p = PairingRequests(server_cert)
    monkeypatch.setattr(P.secrets, "token_urlsafe", lambda n: "fixed-id")
    req = create(p, "a", "vscode", "1")
    digest = hashlib.sha256(pem_to_der(server_cert, "CERTIFICATE") + pem_to_der(PUBLIC_KEY, "PUBLIC KEY") + b"fixed-id")
    assert req.code == f"{int.from_bytes(digest.digest()[:4], 'big') % 10000:04d}"
    assert P.pairing_code(b"", pem_to_der(PUBLIC_KEY, "PUBLIC KEY"), "fixed-id") != req.code
    assert req.public_key.replace("\n", "") == PUBLIC_KEY.replace("\n", "")
    for key in (None, "", "nope", server_cert):
        with pytest.raises(ValueError):
            create(p, "b", "vscode", "1", key=key)


def test_credentials_delivered_once():
    p, _, events = make()
    req = create(p, "a", "vscode", "1")
    assert not p.claim_credentials(req)
    p.approve(req.id, "CERT")
    assert events[-1] == "approve" and req.client_cert == "CERT"
    assert p.claim_credentials(req) and not p.claim_credentials(req)
    with pytest.raises(ValueError):
        p.deny(req.id)
    with pytest.raises(ValueError):
        p.approve("missing", "CERT")


def test_prune_idle_pending_and_old_resolved():
    p, clock, events = make()
    idle = create(p, "idle", "vscode", "1")
    polled = create(p, "polled", "vscode", "2")
    done = create(p, "done", "vscode", "3")
    p.approve(done.id, "CERT")
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
    req = create(p, "a", "vscode", "1")

    async def run():
        waiting = asyncio.ensure_future(p.wait(req, 5))
        await asyncio.sleep(0.01)
        clock.t += 120
        assert p.prune() == 0
        p.approve(req.id, "CERT")
        await asyncio.wait_for(waiting, 1)
        assert req.waiters == 0
    asyncio.run(run())


def test_wait_times_out_and_cancel():
    p, _, events = make()
    req = create(p, "a", "vscode", "1")

    async def run():
        await p.wait(req, 0.05)
        assert req.status == "pending"
    asyncio.run(run())
    assert p.cancel(req.id) and events[-1] == "cancel" and p.get(req.id) is None
    assert not p.cancel(req.id)

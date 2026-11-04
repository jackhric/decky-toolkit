"""Pairing requests: a client asks for the token, the device owner allows or denies it in the Decky panel."""
import asyncio
import secrets
import time
from dataclasses import dataclass, field
from typing import Callable

CLIENT_KINDS = ("vscode", "browser", "mcp", "other")
MAX_PENDING = 10
MAX_PENDING_PER_REMOTE = 2
MAX_NAME_LEN = 64
PENDING_IDLE_SECONDS = 60.0
RESOLVED_KEEP_SECONDS = 300.0
PRUNE_EVERY_SECONDS = 10.0
MAX_WAIT_SECONDS = 25.0
POLL_AFTER_MS = 1000

# (event, request): event is "create", "approve", "deny", "cancel" or "prune" (request None).
OnChange = Callable[[str, "PairingRequest | None"], None]


class PairingLimit(Exception):
    """Too many pending requests overall or from one address."""


@dataclass(eq=False)
class PairingRequest:
    id: str
    code: str
    client_name: str
    client_kind: str
    remote: str
    created_at: float
    last_poll: float
    status: str = "pending"
    resolved_at: float | None = None
    token_delivered: bool = False
    cookie_delivered: bool = False
    waiters: int = 0
    changed: asyncio.Event = field(default_factory=asyncio.Event, repr=False)

    def public(self, now: float) -> dict:
        return {
            "id": self.id, "code": self.code, "client_name": self.client_name, "client_kind": self.client_kind,
            "remote": self.remote, "status": self.status, "age_s": round(now - self.created_at, 1),
        }


class PairingRequests:
    def __init__(self, clock: Callable[[], float] = time.monotonic, on_change: OnChange | None = None):
        self.clock = clock
        self.on_change = on_change
        self._requests: dict[str, PairingRequest] = {}

    def _notify(self, event: str, req: PairingRequest | None) -> None:
        if self.on_change:
            self.on_change(event, req)

    def pending(self) -> list[PairingRequest]:
        return [r for r in self._requests.values() if r.status == "pending"]

    def list(self) -> list[dict]:
        now = self.clock()
        return [r.public(now) for r in self._requests.values()]

    def get(self, request_id: str) -> PairingRequest | None:
        return self._requests.get(request_id)

    def create(self, client_name: object, client_kind: object, remote: str) -> PairingRequest:
        if not isinstance(client_name, str) or not client_name.strip():
            raise ValueError("client_name must be a non-empty string")
        client_name = " ".join(client_name.split())
        if len(client_name) > MAX_NAME_LEN:
            raise ValueError(f"client_name must be at most {MAX_NAME_LEN} characters")
        if client_kind not in CLIENT_KINDS:
            raise ValueError(f"client_kind must be one of {', '.join(CLIENT_KINDS)}")
        pending = self.pending()
        # A client that retries (restart, reload) replaces its own request instead of piling up codes.
        replaced = next((r for r in pending if r.remote == remote and r.client_name == client_name), None)
        if replaced:
            pending.remove(replaced)
        if len(pending) >= MAX_PENDING:
            raise PairingLimit("too many pending pairing requests")
        if sum(r.remote == remote for r in pending) >= MAX_PENDING_PER_REMOTE:
            raise PairingLimit("too many pending pairing requests from this address")
        if replaced:
            self._drop(replaced)
        taken = {r.code for r in pending}
        code = f"{secrets.randbelow(10000):04d}"
        while code in taken:
            code = f"{secrets.randbelow(10000):04d}"
        now = self.clock()
        req = PairingRequest(id=secrets.token_urlsafe(16), code=code, client_name=client_name,
                             client_kind=client_kind, remote=remote, created_at=now, last_poll=now)
        self._requests[req.id] = req
        self._notify("create", req)
        return req

    def touch(self, request_id: str) -> PairingRequest | None:
        req = self._requests.get(request_id)
        if req:
            req.last_poll = self.clock()
        return req

    async def wait(self, req: PairingRequest, timeout: float) -> None:
        """Returns when the request is resolved or dropped, or after `timeout` seconds."""
        if req.status != "pending":
            return
        req.waiters += 1
        try:
            await asyncio.wait_for(req.changed.wait(), timeout)
        except TimeoutError:
            pass
        finally:
            req.waiters -= 1
            req.last_poll = self.clock()

    def _resolve(self, request_id: str, status: str) -> PairingRequest:
        req = self._requests.get(request_id)
        if req is None:
            raise ValueError("unknown or expired pairing request")
        if req.status != "pending":
            raise ValueError(f"pairing request already {req.status}")
        req.status = status
        req.resolved_at = self.clock()
        req.changed.set()
        self._notify("approve" if status == "approved" else "deny", req)
        return req

    def approve(self, request_id: str) -> PairingRequest:
        return self._resolve(request_id, "approved")

    def deny(self, request_id: str) -> PairingRequest:
        return self._resolve(request_id, "denied")

    def _drop(self, req: PairingRequest) -> None:
        self._requests.pop(req.id, None)
        req.changed.set()

    def cancel(self, request_id: str) -> bool:
        req = self._requests.get(request_id)
        if req is None or req.status != "pending":
            return False
        self._drop(req)
        self._notify("cancel", req)
        return True

    def claim_token(self, req: PairingRequest) -> bool:
        """True exactly once per approved request."""
        if req.status != "approved" or req.token_delivered:
            return False
        req.token_delivered = True
        return True

    def claim_cookie(self, req: PairingRequest) -> bool:
        if req.status != "approved" or req.cookie_delivered:
            return False
        req.cookie_delivered = True
        return True

    def prune(self) -> int:
        now = self.clock()
        stale = [
            r for r in self._requests.values()
            if (r.status == "pending" and r.waiters == 0 and now - r.last_poll > PENDING_IDLE_SECONDS)
            or (r.resolved_at is not None and now - r.resolved_at > RESOLVED_KEEP_SECONDS)
        ]
        for r in stale:
            self._drop(r)
        if stale:
            self._notify("prune", None)
        return len(stale)

    async def run_pruner(self, every: float = PRUNE_EVERY_SECONDS) -> None:
        while True:
            await asyncio.sleep(every)
            self.prune()

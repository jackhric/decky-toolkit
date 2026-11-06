"""Pairing requests: a client asks for a certificate, the device owner allows or denies it in the Decky panel."""
import asyncio
import hashlib
import secrets
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Callable

from .tls import der_to_pem, parse_public_key, pem_to_der

if TYPE_CHECKING:
    from .events import EventHub

CLIENT_KINDS = ("vscode", "mcp", "other")
MAX_PENDING = 10
MAX_PENDING_PER_REMOTE = 2
MAX_NAME_LEN = 64
PENDING_IDLE_SECONDS = 60.0
RESOLVED_KEEP_SECONDS = 300.0
PRUNE_EVERY_SECONDS = 10.0
MAX_WAIT_SECONDS = 25.0
POLL_AFTER_MS = 1000

def pairing_code(server_cert_der: bytes, client_spki_der: bytes, request_id: str) -> str:
    """Both ends derive this from what they saw, so a relay that swaps either key shows a different code."""
    digest = hashlib.sha256(server_cert_der + client_spki_der + request_id.encode()).digest()
    return f"{int.from_bytes(digest[:4], 'big') % 10000:04d}"


class PairingLimit(Exception):
    """Too many pending requests overall or from one address."""


@dataclass(eq=False)
class PairingRequest:
    id: str
    code: str
    client_name: str
    client_kind: str
    public_key: str
    remote: str
    created_at: float
    last_poll: float
    status: str = "pending"
    resolved_at: float | None = None
    client_cert: str | None = None
    credentials_delivered: bool = False
    waiters: int = 0
    changed: asyncio.Event = field(default_factory=asyncio.Event, repr=False)

    def public(self, now: float) -> dict:
        return {
            "id": self.id, "code": self.code, "client_name": self.client_name, "client_kind": self.client_kind,
            "remote": self.remote, "status": self.status, "age_s": round(now - self.created_at, 1),
        }


class PairingRequests:
    def __init__(self, events: "EventHub", server_cert: str = "", clock: Callable[[], float] = time.monotonic):
        self.events = events
        self.server_cert = server_cert
        self._server_cert_der = pem_to_der(server_cert, "CERTIFICATE") if server_cert else b""
        self.clock = clock
        self._requests: dict[str, PairingRequest] = {}

    def _changed(self, created: PairingRequest | None = None) -> None:
        if created is not None:
            self.events.frontend("decky_toolkit_pair_request", {
                "id": created.id, "code": created.code, "client_name": created.client_name,
                "client_kind": created.client_kind, "remote": created.remote})
        self.events.frontend("decky_toolkit_pair_requests", self.list())
        self.events.refresh("pairing")

    def pending(self) -> list[PairingRequest]:
        return [r for r in self._requests.values() if r.status == "pending"]

    def list(self) -> list[dict]:
        now = self.clock()
        return [r.public(now) for r in self._requests.values()]

    def get(self, request_id: str) -> PairingRequest | None:
        return self._requests.get(request_id)

    def create(self, client_name: object, client_kind: object, public_key: object, remote: str) -> PairingRequest:
        if not isinstance(client_name, str) or not client_name.strip():
            raise ValueError("client_name must be a non-empty string")
        client_name = " ".join(client_name.split())
        if len(client_name) > MAX_NAME_LEN:
            raise ValueError(f"client_name must be at most {MAX_NAME_LEN} characters")
        if client_kind not in CLIENT_KINDS:
            raise ValueError(f"client_kind must be one of {', '.join(CLIENT_KINDS)}")
        spki = parse_public_key(public_key)
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
        now = self.clock()
        request_id = secrets.token_urlsafe(16)
        req = PairingRequest(id=request_id, code=pairing_code(self._server_cert_der, spki, request_id),
                             client_name=client_name, client_kind=client_kind,
                             public_key=der_to_pem(spki, "PUBLIC KEY"), remote=remote, created_at=now, last_poll=now)
        self._requests[req.id] = req
        self._changed(req)
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

    def pending_request(self, request_id: str) -> PairingRequest:
        req = self._requests.get(request_id)
        if req is None:
            raise ValueError("unknown or expired pairing request")
        if req.status != "pending":
            raise ValueError(f"pairing request already {req.status}")
        return req

    def _resolve(self, request_id: str, status: str) -> PairingRequest:
        req = self.pending_request(request_id)
        req.status = status
        req.resolved_at = self.clock()
        req.changed.set()
        self._changed()
        return req

    def approve(self, request_id: str, client_cert: str) -> PairingRequest:
        self.pending_request(request_id).client_cert = client_cert
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
        self._changed()
        return True

    def claim_credentials(self, req: PairingRequest) -> bool:
        """True exactly once per approved request."""
        if req.status != "approved" or req.credentials_delivered:
            return False
        req.credentials_delivered = True
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
            self._changed()
        return len(stale)

    async def run_pruner(self, every: float = PRUNE_EVERY_SECONDS) -> None:
        while True:
            await asyncio.sleep(every)
            self.prune()

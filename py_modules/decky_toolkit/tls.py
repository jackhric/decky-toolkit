"""Device identity and paired clients: the device's self-signed certificate is both its TLS server certificate
and the authority that signs each paired client's certificate; a client is authorised by its fingerprint."""
import base64
import binascii
import hashlib
import json
import os
import re
import shutil
import ssl
import tempfile
import time
from typing import Callable

from .tools.system import run

VALID_DAYS = "36500"
SEEN_EVERY_SECONDS = 60
# The extension polls /stream/stats every 5 s while it is connected.
CONNECTED_SECONDS = 15
_PEM = re.compile(r"-----BEGIN ([A-Z ]+)-----\s*([A-Za-z0-9+/=\s]+?)-----END \1-----")
# DER prefix of an uncompressed EC P-256 SubjectPublicKeyInfo (id-ecPublicKey, prime256v1), then 0x04 X Y.
_P256_SPKI_PREFIX = bytes.fromhex("3059301306072a8648ce3d020106082a8648ce3d030107034200")
_P256_P = 2**256 - 2**224 + 2**192 + 2**96 - 1
_P256_B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B


class TlsError(RuntimeError):
    pass


def pem_to_der(pem: str, label: str) -> bytes:
    m = _PEM.search(pem) if isinstance(pem, str) else None
    if not m or m.group(1) != label:
        raise ValueError(f"expected a PEM {label}")
    try:
        return base64.b64decode("".join(m.group(2).split()), validate=True)
    except binascii.Error:
        raise ValueError(f"expected a PEM {label}") from None


def der_to_pem(der: bytes, label: str) -> str:
    b64 = base64.b64encode(der).decode()
    lines = "\n".join(b64[i:i + 64] for i in range(0, len(b64), 64))
    return f"-----BEGIN {label}-----\n{lines}\n-----END {label}-----\n"


def fingerprint_der(der: bytes) -> str:
    return hashlib.sha256(der).hexdigest()


def fingerprint(cert_pem: str) -> str:
    return fingerprint_der(pem_to_der(cert_pem, "CERTIFICATE"))


def parse_public_key(pem: object) -> bytes:
    """The SPKI DER of an EC P-256 public key in PEM form; ValueError for anything else."""
    der = pem_to_der(pem, "PUBLIC KEY")  # type: ignore[arg-type]
    if len(der) != len(_P256_SPKI_PREFIX) + 65 or not der.startswith(_P256_SPKI_PREFIX) or der[26] != 4:
        raise ValueError("public_key must be an uncompressed EC P-256 key")
    x, y = int.from_bytes(der[27:59], "big"), int.from_bytes(der[59:], "big")
    if x >= _P256_P or y >= _P256_P or (y * y - (x * x * x - 3 * x + _P256_B)) % _P256_P:
        raise ValueError("public_key is not a point on P-256")
    return der


def _subject_cn(name: str) -> str:
    # openssl's -subj gives '/', '=', '+' and '\' meaning and mangles non-ASCII without -utf8. The CN is
    # cosmetic (clients are identified by fingerprint, named in clients.json), so keep a safe subset.
    return re.sub(r"[^A-Za-z0-9 ._-]", "_", name).strip() or "client"


async def _openssl(*args: str) -> None:
    try:
        code, out = await run("openssl", *args)
    except FileNotFoundError:
        raise TlsError("openssl not found") from None
    if code != 0:
        raise TlsError(f"openssl {args[0]} failed: {out.strip()}")


def _write_private(path: str, text: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)


class Identity:
    def __init__(self, settings_dir: str):
        self.dir = os.path.join(settings_dir, "tls")
        self.cert_path = os.path.join(self.dir, "server.crt")
        self.key_path = os.path.join(self.dir, "server.key")
        self.clients_path = os.path.join(self.dir, "clients.json")
        self.cert_pem = ""

    async def ensure(self) -> None:
        """Mints the key and certificate on first use; nothing ever rotates them (deleting the dir resets)."""
        os.makedirs(self.dir, mode=0o700, exist_ok=True)
        os.chmod(self.dir, 0o700)
        if not (os.path.exists(self.cert_path) and os.path.exists(self.key_path)):
            await self._mint()
        with open(self.cert_path) as f:
            pem = f.read()
        pem_to_der(pem, "CERTIFICATE")
        self.cert_pem = pem

    async def _mint(self) -> None:
        work = tempfile.mkdtemp(dir=self.dir)
        try:
            key, crt = os.path.join(work, "server.key"), os.path.join(work, "server.crt")
            await _openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
                           "-keyout", key, "-out", crt, "-days", VALID_DAYS, "-subj", "/CN=Decky Toolkit",
                           "-addext", "basicConstraints=critical,CA:TRUE",
                           "-addext", "keyUsage=critical,digitalSignature,keyCertSign")
            for p in (key, crt):
                os.chmod(p, 0o600)
            # Key first: a crash in between leaves no certificate, so the next start mints both again.
            os.replace(key, self.key_path)
            os.replace(crt, self.cert_path)
        finally:
            shutil.rmtree(work, ignore_errors=True)

    @property
    def cert_der(self) -> bytes:
        return pem_to_der(self.cert_pem, "CERTIFICATE")

    async def sign_client(self, public_key_pem: str, name: str) -> str:
        """A client-auth certificate for the given key, signed by the device; no CSR, the key stays with the client."""
        spki = parse_public_key(public_key_pem)
        work = tempfile.mkdtemp(dir=self.dir)
        try:
            pub, ext, crt = (os.path.join(work, n) for n in ("client.pub", "ext", "client.crt"))
            _write_private(pub, der_to_pem(spki, "PUBLIC KEY"))
            _write_private(ext, "extendedKeyUsage=clientAuth\nkeyUsage=digitalSignature\n")
            await _openssl("x509", "-new", "-force_pubkey", pub, "-subj", f"/CN={_subject_cn(name)}",
                           "-CA", self.cert_path, "-CAkey", self.key_path, "-days", VALID_DAYS,
                           "-extfile", ext, "-out", crt)
            with open(crt) as f:
                return f.read()
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def server_context(self) -> ssl.SSLContext:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_3
        ctx.load_cert_chain(self.cert_path, self.key_path)
        ctx.load_verify_locations(cafile=self.cert_path)
        # Optional so /health and pairing work without a certificate; a certificate we did not sign still
        # fails the handshake, and a forgotten one is refused per request, so the context never changes.
        ctx.verify_mode = ssl.CERT_OPTIONAL
        return ctx


class PairedClients:
    def __init__(self, path: str, clock: Callable[[], float] = time.time,
                 on_change: Callable[[list[dict]], None] | None = None):
        self.path = path
        self.clock = clock
        self.on_change = on_change
        try:
            with open(path) as f:
                data = json.load(f)
            self._clients = {c["fingerprint"]: c for c in data if isinstance(c, dict) and "fingerprint" in c}
        except (FileNotFoundError, json.JSONDecodeError, TypeError):
            self._clients = {}
        self._active: dict[str, float] = {}

    def _connected(self, fp: str, now: float) -> bool:
        return now - self._active.get(fp, float("-inf")) < CONNECTED_SECONDS

    def list(self) -> list[dict]:
        now = self.clock()
        return [{**c, "connected": self._connected(c["fingerprint"], now)} for c in self._clients.values()]

    def any_connected(self) -> bool:
        now = self.clock()
        return any(self._connected(fp, now) for fp in self._clients)

    def contains(self, fp: str) -> bool:
        return fp in self._clients

    def add(self, fp: str, name: str, kind: str) -> dict:
        client = {"fingerprint": fp, "name": name, "kind": kind, "added_at": int(self.clock()), "last_seen": None}
        self._clients[fp] = client
        self._save()
        return dict(client)

    def replace_all(self, fp: str, name: str, kind: str) -> list[dict]:
        """Make this the only paired client; returns the clients it replaced."""
        replaced = [dict(c) for f, c in self._clients.items() if f != fp]
        self._clients = {}
        self._active = {}
        self.add(fp, name, kind)
        return replaced

    def remove(self, fp: str) -> bool:
        self._active.pop(fp, None)
        if self._clients.pop(fp, None) is None:
            return False
        self._save()
        return True

    def touch(self, fp: str) -> dict | None:
        """The client with this fingerprint, if paired, recording that it was seen (written at most once a minute)."""
        client = self._clients.get(fp)
        if client is None:
            return None
        self._active[fp] = self.clock()
        now = int(self.clock())
        if client["last_seen"] is None or now - client["last_seen"] >= SEEN_EVERY_SECONDS:
            client["last_seen"] = now
            self._save()
        return client

    def _save(self) -> None:
        tmp = self.path + ".tmp"
        _write_private(tmp, json.dumps(list(self._clients.values()), indent=2))
        os.replace(tmp, self.path)
        if self.on_change:
            self.on_change(self.list())

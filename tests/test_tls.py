"""Device identity, client certificates, the paired-client store and real mutual-TLS handshakes. Needs openssl.
Run with: ./scripts/test.sh"""
import asyncio
import hashlib
import json
import logging
import os
import ssl
import stat
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from aiohttp import ClientError, ClientSession, ClientTimeout, TCPConnector, web  # noqa: E402

from decky_toolkit import tls  # noqa: E402
from decky_toolkit.auth import CertAuth  # noqa: E402
from decky_toolkit.http import Api  # noqa: E402
from decky_toolkit.pairing import PairingRequests, pairing_code  # noqa: E402
from decky_toolkit.protocol import McpServer  # noqa: E402
from decky_toolkit.tls import Identity, PairedClients  # noqa: E402
from decky_toolkit.tools import ToolRegistry  # noqa: E402

LOG = logging.getLogger("t")


def openssl(*args: str) -> str:
    return subprocess.run(["openssl", *args], check=True, capture_output=True, text=True).stdout


def keypair(directory: Path, name: str = "client", algorithm: tuple[str, ...] = ("EC", "-pkeyopt", "ec_paramgen_curve:P-256")):
    key, pub = directory / f"{name}.key", directory / f"{name}.pub"
    openssl("genpkey", "-algorithm", *algorithm, "-out", str(key))
    openssl("pkey", "-in", str(key), "-pubout", "-out", str(pub))
    return key, pub.read_text()


def identity(directory: Path) -> Identity:
    ident = Identity(str(directory))
    asyncio.run(ident.ensure())
    return ident


def test_identity_minted_once_owner_only(tmp_path):
    ident = identity(tmp_path)
    tls_dir = tmp_path / "tls"
    assert stat.S_IMODE(tls_dir.stat().st_mode) == 0o700
    for name in ("server.key", "server.crt"):
        assert stat.S_IMODE((tls_dir / name).stat().st_mode) == 0o600
    assert sorted(os.listdir(tls_dir)) == ["server.crt", "server.key"], "the mint's work dir is gone"
    text = openssl("x509", "-in", ident.cert_path, "-noout", "-subject", "-ext", "basicConstraints,keyUsage")
    assert "CN=Decky Toolkit" in text and "CA:TRUE" in text and "Certificate Sign" in text
    assert identity(tmp_path).cert_pem == ident.cert_pem, "an existing identity is never replaced"


def test_sign_client_and_fingerprint(tmp_path):
    ident = identity(tmp_path)
    _, pub = keypair(tmp_path)
    cert = asyncio.run(ident.sign_client(pub, "VS Code/on=box+1 é"))
    (tmp_path / "client.crt").write_text(cert)
    assert openssl("verify", "-CAfile", ident.cert_path, str(tmp_path / "client.crt")).strip().endswith("OK")
    text = openssl("x509", "-in", str(tmp_path / "client.crt"), "-noout", "-subject", "-ext", "extendedKeyUsage")
    assert "CN=VS Code_on_box_1 _" in text and "TLS Web Client Authentication" in text
    assert openssl("x509", "-in", str(tmp_path / "client.crt"), "-noout", "-pubkey") == pub
    assert tls.fingerprint(cert) == hashlib.sha256(ssl.PEM_cert_to_DER_cert(cert)).hexdigest()
    assert sorted(os.listdir(tmp_path / "tls")) == ["server.crt", "server.key"]


def test_parse_public_key_accepts_only_p256(tmp_path):
    _, pub = keypair(tmp_path)
    assert len(tls.parse_public_key(pub)) == 91
    _, ed = keypair(tmp_path, "ed", ("ED25519",))
    _, p384 = keypair(tmp_path, "p384", ("EC", "-pkeyopt", "ec_paramgen_curve:P-384"))
    der = bytearray(tls.parse_public_key(pub))
    der[-1] ^= 1
    for bad in (ed, p384, tls.der_to_pem(bytes(der), "PUBLIC KEY"), pub.replace("PUBLIC KEY", "CERTIFICATE"), "", None, 3):
        with pytest.raises(ValueError):
            tls.parse_public_key(bad)


def test_paired_clients_store(tmp_path):
    path = tmp_path / "clients.json"
    now = [1000.0]
    changes = []
    clients = PairedClients(str(path), clock=lambda: now[0], on_change=changes.append)
    assert clients.list() == [] and clients.touch("aa") is None
    clients.add("aa", "VS Code on box", "vscode")
    clients.add("bb", "agent", "mcp")
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert clients.contains("aa") and len(changes) == 2
    assert clients.touch("aa")["last_seen"] == 1000
    now[0] += 30
    clients.touch("aa")
    assert len(changes) == 3, "last_seen is written at most once a minute"
    now[0] += 31
    assert clients.touch("aa")["last_seen"] == 1061 and len(changes) == 4
    again = PairedClients(str(path))
    assert [c["connected"] for c in clients.list()] == [True, False]
    in_memory = {"connected": None, "connected_since": None}
    assert [{**c, **in_memory} for c in again.list()] == [{**c, **in_memory} for c in clients.list()]
    assert not again.any_connected(), "connected is in memory only"
    assert again.list()[0] == {"fingerprint": "aa", "name": "VS Code on box", "kind": "vscode", "added_at": 1000,
                               "last_seen": 1061, "connected": False, "connected_since": None, "remote": None}
    assert clients.remove("bb") and not clients.remove("bb") and not clients.contains("bb")
    assert [c["fingerprint"] for c in json.loads(path.read_text())] == ["aa"]
    clients.add("bb", "agent", "mcp")
    n = len(changes)
    replaced = clients.replace_all("cc", "VS Code on other", "vscode")
    assert sorted(c["fingerprint"] for c in replaced) == ["aa", "bb"]
    assert [c["fingerprint"] for c in json.loads(path.read_text())] == ["cc"]
    assert len(changes) == n + 1 and changes[-1] == clients.list(), "one save, one change event"
    assert clients.replace_all("cc", "VS Code on other", "vscode") == [] and len(clients.list()) == 1
    path.write_text("not json")
    assert PairedClients(str(path)).list() == []


def test_paired_clients_connected(tmp_path):
    now = [1000.0]
    clients = PairedClients(str(tmp_path / "clients.json"), clock=lambda: now[0])
    clients.add("aa", "VS Code on box", "vscode")
    assert not clients.any_connected() and clients.list()[0]["connected"] is False
    clients.touch("aa")
    now[0] += 14
    assert clients.any_connected() and clients.list()[0]["connected"] is True
    now[0] += 2
    assert not clients.any_connected(), "connected means an authenticated request in the last 15 s"
    clients.touch("aa")
    clients.remove("aa")
    assert not clients.any_connected()


def test_paired_clients_session(tmp_path):
    now = [1000.0]
    clients = PairedClients(str(tmp_path / "clients.json"), clock=lambda: now[0])
    clients.add("aa", "VS Code on box", "vscode")
    assert clients.connected() is None
    assert clients.list()[0]["connected_since"] is None and clients.list()[0]["remote"] is None
    clients.touch("aa", "10.0.0.30")
    for _ in range(10):
        now[0] += 10
        clients.touch("aa")
    c = clients.connected()
    assert c["connected_since"] == 1000 and c["remote"] == "10.0.0.30", "requests keep the session and the last address"
    clients.touch("aa", "10.0.0.31")
    assert clients.connected()["remote"] == "10.0.0.31"
    now[0] += 15
    assert clients.connected() is None and clients.list()[0]["connected_since"] is None
    assert clients.list()[0]["remote"] == "10.0.0.31", "the last address outlives the session"
    clients.touch("aa", "10.0.0.30")
    assert clients.connected()["connected_since"] == 1115, "a request after a gap starts a new session"
    clients.replace_all("bb", "agent", "mcp")
    assert clients.connected() is None and clients.list()[0]["remote"] is None


def client_context(server_cert: str | None = None, cert: tuple[Path, Path] | None = None) -> ssl.SSLContext:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    if server_cert is None:
        ctx.verify_mode = ssl.CERT_NONE
    else:
        ctx.load_verify_locations(cadata=server_cert)
    if cert:
        ctx.load_cert_chain(*map(str, cert))
    return ctx


def test_mutual_tls_end_to_end(tmp_path):
    ident = identity(tmp_path / "device")
    other = identity(tmp_path / "other")
    clients = PairedClients(ident.clients_path)
    pairing = PairingRequests(ident.cert_pem)
    key, pub = keypair(tmp_path)

    async def get(base: str, path: str, ctx: ssl.SSLContext) -> int:
        async with ClientSession(connector=TCPConnector(ssl=ctx), timeout=ClientTimeout(total=5)) as s:
            async with s.get(base + path) as r:
                return r.status

    async def run():
        api = Api(auth=CertAuth(clients), mcp=McpServer(ToolRegistry(), LOG), capturer=None, logger=LOG, pairing=pairing)
        runner = web.AppRunner(api.build_app())
        await runner.setup()
        await web.TCPSite(runner, "127.0.0.1", 0, ssl_context=ident.server_context()).start()
        base = f"https://127.0.0.1:{runner.addresses[0][1]}"
        try:
            anon = client_context()
            assert await get(base, "/health", anon) == 200
            assert await get(base, "/stream/stats", anon) == 401

            async with ClientSession(connector=TCPConnector(ssl=anon), timeout=ClientTimeout(total=5)) as s:
                body = {"client_name": "VS Code on box", "client_kind": "vscode", "public_key": pub}
                async with s.post(f"{base}/pair/request", json=body) as r:
                    assert r.status == 201
                    created = await r.json()
                seen = await asyncio.to_thread(ssl.get_server_certificate, ("127.0.0.1", runner.addresses[0][1]))
                seen_der = ssl.PEM_cert_to_DER_cert(seen)
                assert created["code"] == pairing_code(seen_der, tls.parse_public_key(pub), created["id"])
                req = pairing.pending_request(created["id"])
                cert = await ident.sign_client(req.public_key, req.client_name)
                pairing.approve(req.id, cert)
                clients.add(tls.fingerprint(cert), req.client_name, req.client_kind)
                async with s.get(f"{base}/pair/request/{req.id}") as r:
                    approved = await r.json()
                async with s.get(f"{base}/pair/request/{req.id}") as r:
                    assert await r.json() == {"status": "approved"}, "credentials go out once"
            assert approved == {"status": "approved", "client_cert": cert, "server_cert": ident.cert_pem, "api_version": 2}

            (tmp_path / "client.crt").write_text(approved["client_cert"])
            paired = client_context(approved["server_cert"], (tmp_path / "client.crt", key))
            assert await get(base, "/stream/stats", paired) == 200
            assert clients.touch(tls.fingerprint(cert))["last_seen"] is not None

            # Same key, signed by another device: refused during the handshake, not by a status code.
            (tmp_path / "foreign.crt").write_text(await other.sign_client(pub, "x"))
            with pytest.raises((ClientError, ssl.SSLError)):
                await get(base, "/stream/stats", client_context(cert=(tmp_path / "foreign.crt", key)))

            assert clients.remove(tls.fingerprint(cert))
            assert await get(base, "/stream/stats", paired) == 401
            assert await get(base, "/health", paired) == 200
        finally:
            await runner.cleanup()
    asyncio.run(run())

"""Client-certificate auth for route tests: the peer fingerprint comes from a header instead of a TLS session
(tests/test_tls.py covers the real handshake)."""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))

from decky_toolkit.server.auth import CertAuth  # noqa: E402
from decky_toolkit.server.tls import PairedClients  # noqa: E402

FINGERPRINT = "ab" * 32
PEER_HEADER = "X-Test-Peer"
H = {PEER_HEADER: FINGERPRINT}
PUBLIC_KEY = """-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAESQDuutwaAHkhubNAsPZXnvcDla7d
zyZmEJqpi2Rbi3bEkRSxidvFLACS7AtgC8hZXnWC5vtgYzJ2Go3ZMs4yNw==
-----END PUBLIC KEY-----
"""


def stub_auth(clients: PairedClients | None = None) -> CertAuth:
    if clients is None:
        clients = PairedClients(str(Path(tempfile.mkdtemp()) / "clients.json"))
        clients.add(FINGERPRINT, "test client", "vscode")
    return CertAuth(clients, peer=lambda request: request.headers.get(PEER_HEADER))

"""The one exception table: HTTP status and error code for the routes, and which failures tools report without a
traceback (all but the OSError catch-all)."""
from .games.files import TooLarge
from .input.service import InputDisabled, InputUnavailable
from .media.capture import CaptureUnavailable
from .server.pairing import PairingLimit
from .steam.cdp import CdpError

# First match wins, so subclasses come before their bases (TooLarge is a ValueError, the 409s and 403/404 are OSErrors).
ERRORS: tuple[tuple[type[BaseException], int, str | None], ...] = (
    (TooLarge, 413, "EFBIG"),
    (ValueError, 400, None),
    (PermissionError, 403, "EACCES"),
    (FileNotFoundError, 404, "ENOENT"),
    (FileExistsError, 409, "EEXIST"),
    (IsADirectoryError, 409, "EISDIR"),
    (NotADirectoryError, 409, "ENOTDIR"),
    (PairingLimit, 429, None),
    (CdpError, 502, None),
    (InputUnavailable, 503, None),
    (InputDisabled, 503, None),
    (CaptureUnavailable, 503, None),
    (OSError, 500, None),
)
HANDLED = tuple(t for t, _, _ in ERRORS)
EXPECTED = tuple(t for t, status, _ in ERRORS if status != 500)


def status_of(e: BaseException) -> tuple[int, str | None]:
    return next((status, code) for t, status, code in ERRORS if isinstance(e, t))


def body(e: BaseException) -> dict[str, str]:
    _, code = status_of(e)
    return {"error": str(e), **({"code": code} if code else {})}

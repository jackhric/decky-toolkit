"""Minimal /dev/uinput device creation (stdlib only; struct and ioctl values for x86_64)."""
import fcntl
import os
import struct

_IOC_WRITE = 1
_IOC_READ = 2


def _ioc(direction: int, nr: int, size: int) -> int:
    return (direction << 30) | (size << 16) | (ord("U") << 8) | nr


UI_DEV_CREATE = _ioc(0, 1, 0)
UI_DEV_DESTROY = _ioc(0, 2, 0)
UI_DEV_SETUP = _ioc(_IOC_WRITE, 3, 92)
UI_ABS_SETUP = _ioc(_IOC_WRITE, 4, 28)
UI_SET_EVBIT = _ioc(_IOC_WRITE, 100, 4)
UI_SET_KEYBIT = _ioc(_IOC_WRITE, 101, 4)
UI_SET_RELBIT = _ioc(_IOC_WRITE, 102, 4)
UI_SET_ABSBIT = _ioc(_IOC_WRITE, 103, 4)
UI_SET_PROPBIT = _ioc(_IOC_WRITE, 110, 4)


def UI_GET_SYSNAME(n: int) -> int:
    return _ioc(_IOC_READ, 44, n)


EV_SYN, EV_KEY, EV_REL, EV_ABS = 0x00, 0x01, 0x02, 0x03
SYN_REPORT = 0
REL_X, REL_Y, REL_HWHEEL, REL_WHEEL = 0x00, 0x01, 0x06, 0x08
ABS_X, ABS_Y, ABS_Z, ABS_RX, ABS_RY, ABS_RZ = 0x00, 0x01, 0x02, 0x03, 0x04, 0x05
ABS_HAT0X, ABS_HAT0Y = 0x10, 0x11
BTN_LEFT, BTN_RIGHT, BTN_MIDDLE, BTN_SIDE, BTN_EXTRA = 0x110, 0x111, 0x112, 0x113, 0x114
BTN_A, BTN_B, BTN_X, BTN_Y = 0x130, 0x131, 0x133, 0x134
BTN_TL, BTN_TR, BTN_SELECT, BTN_START, BTN_MODE, BTN_THUMBL, BTN_THUMBR = 0x136, 0x137, 0x13A, 0x13B, 0x13C, 0x13D, 0x13E
BUS_USB, BUS_VIRTUAL = 0x03, 0x06

EVENT = struct.Struct("@qqHHi")      # struct input_event: timeval, type, code, value
SETUP = struct.Struct("@HHHH80sI")   # struct uinput_setup: input_id, name[80], ff_effects_max
ABS_SETUP = struct.Struct("@H2x6i")  # struct uinput_abs_setup: code, pad, input_absinfo
assert (EVENT.size, SETUP.size, ABS_SETUP.size) == (24, 92, 28)

DEV_PATH = "/dev/uinput"


def available() -> bool:
    return os.access(DEV_PATH, os.W_OK)


class Device:
    def __init__(self, name: str, *, keys=(), rels=(), abs: dict[int, tuple[int, int, int, int, int]] | None = None,
                 props=(), bustype: int = BUS_VIRTUAL, vendor: int = 0x1209, product: int = 0x0001, version: int = 1):
        """abs: {code: (min, max, fuzz, flat, resolution)}"""
        self.name = name
        self.fd = os.open(DEV_PATH, os.O_WRONLY | os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            if keys:
                fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_KEY)
                for k in keys:
                    fcntl.ioctl(self.fd, UI_SET_KEYBIT, k)
            if rels:
                fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_REL)
                for r in rels:
                    fcntl.ioctl(self.fd, UI_SET_RELBIT, r)
            if abs:
                fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_ABS)
                for code, (lo, hi, fuzz, flat, res) in abs.items():
                    fcntl.ioctl(self.fd, UI_SET_ABSBIT, code)
                    fcntl.ioctl(self.fd, UI_ABS_SETUP, ABS_SETUP.pack(code, 0, lo, hi, fuzz, flat, res))
            for p in props:
                fcntl.ioctl(self.fd, UI_SET_PROPBIT, p)
            fcntl.ioctl(self.fd, UI_DEV_SETUP, SETUP.pack(bustype, vendor, product, version, name.encode()[:79], 0))
            fcntl.ioctl(self.fd, UI_DEV_CREATE)
        except BaseException:
            os.close(self.fd)
            raise
        buf = bytearray(64)
        fcntl.ioctl(self.fd, UI_GET_SYSNAME(len(buf)), buf)
        self.sysname = buf.split(b"\0", 1)[0].decode()

    def emit(self, events) -> None:
        """events: iterable of (type, code, value); a SYN_REPORT is appended."""
        data = b"".join(EVENT.pack(0, 0, t, c, v) for t, c, v in events)
        os.write(self.fd, data + EVENT.pack(0, 0, EV_SYN, SYN_REPORT, 0))

    def close(self) -> None:
        if self.fd >= 0:
            try:
                fcntl.ioctl(self.fd, UI_DEV_DESTROY)
            finally:
                os.close(self.fd)
                self.fd = -1

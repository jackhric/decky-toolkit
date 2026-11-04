import fcntl
import os
import struct
import time

_IOC_WRITE = 1
_IOC_READ = 2


def _ioc(direction, nr, size):
    return (direction << 30) | (size << 16) | (ord("U") << 8) | nr


UI_DEV_CREATE = _ioc(0, 1, 0)                 # 0x5501
UI_DEV_DESTROY = _ioc(0, 2, 0)                # 0x5502
UI_DEV_SETUP = _ioc(_IOC_WRITE, 3, 92)        # 0x405c5503
UI_ABS_SETUP = _ioc(_IOC_WRITE, 4, 28)        # 0x401c5504
UI_SET_EVBIT = _ioc(_IOC_WRITE, 100, 4)       # 0x40045564
UI_SET_KEYBIT = _ioc(_IOC_WRITE, 101, 4)      # 0x40045565
UI_SET_RELBIT = _ioc(_IOC_WRITE, 102, 4)      # 0x40045566
UI_SET_ABSBIT = _ioc(_IOC_WRITE, 103, 4)      # 0x40045567
UI_SET_PROPBIT = _ioc(_IOC_WRITE, 110, 4)     # 0x4004556e


def UI_GET_SYSNAME(n):
    return _ioc(_IOC_READ, 44, n)


EV_SYN, EV_KEY, EV_REL, EV_ABS, EV_MSC = 0x00, 0x01, 0x02, 0x03, 0x04
SYN_REPORT = 0
REL_X, REL_Y, REL_HWHEEL, REL_WHEEL = 0x00, 0x01, 0x06, 0x08
REL_WHEEL_HI_RES, REL_HWHEEL_HI_RES = 0x0B, 0x0C
ABS_X, ABS_Y, ABS_Z, ABS_RX, ABS_RY, ABS_RZ = 0x00, 0x01, 0x02, 0x03, 0x04, 0x05
ABS_HAT0X, ABS_HAT0Y = 0x10, 0x11
ABS_MT_SLOT, ABS_MT_POSITION_X, ABS_MT_POSITION_Y, ABS_MT_TRACKING_ID = 0x2F, 0x35, 0x36, 0x39
BTN_LEFT, BTN_RIGHT, BTN_MIDDLE, BTN_SIDE, BTN_EXTRA = 0x110, 0x111, 0x112, 0x113, 0x114
BTN_TOOL_PEN, BTN_TOOL_FINGER, BTN_TOUCH = 0x140, 0x145, 0x14A
BTN_A, BTN_B, BTN_X, BTN_Y = 0x130, 0x131, 0x133, 0x134
BTN_TL, BTN_TR, BTN_SELECT, BTN_START, BTN_MODE, BTN_THUMBL, BTN_THUMBR = 0x136, 0x137, 0x13A, 0x13B, 0x13C, 0x13D, 0x13E
INPUT_PROP_POINTER, INPUT_PROP_DIRECT = 0x00, 0x01
BUS_USB, BUS_VIRTUAL = 0x03, 0x06

_EVENT = struct.Struct("@qqHHi")      # struct input_event on 64-bit: timeval(16) + u16 + u16 + s32 = 24
_SETUP = struct.Struct("@HHHH80sI")   # struct uinput_setup: input_id(8) + name[80] + ff_effects_max = 92
_ABS = struct.Struct("@H2x6i")        # struct uinput_abs_setup: code + pad + input_absinfo(24) = 28
assert (_EVENT.size, _SETUP.size, _ABS.size) == (24, 92, 28)


class Device:
    def __init__(self, name, *, keys=(), rels=(), abs=None, props=(),
                 bustype=BUS_VIRTUAL, vendor=0x1209, product=0x0001, version=1):
        """abs: {code: (min, max, fuzz, flat, resolution)}"""
        self.fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK | os.O_CLOEXEC)
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
                    fcntl.ioctl(self.fd, UI_ABS_SETUP, _ABS.pack(code, 0, lo, hi, fuzz, flat, res))
            for p in props:
                fcntl.ioctl(self.fd, UI_SET_PROPBIT, p)
            fcntl.ioctl(self.fd, UI_DEV_SETUP,
                        _SETUP.pack(bustype, vendor, product, version, name.encode()[:79], 0))
            fcntl.ioctl(self.fd, UI_DEV_CREATE)
        except BaseException:
            os.close(self.fd)
            raise
        buf = bytearray(64)
        fcntl.ioctl(self.fd, UI_GET_SYSNAME(len(buf)), buf)
        self.sysname = buf.split(b"\0", 1)[0].decode()   # e.g. "input42"

    def emit(self, events):
        """events: iterable of (type, code, value); a SYN_REPORT is appended."""
        data = b"".join(_EVENT.pack(0, 0, t, c, v) for t, c, v in events)
        os.write(self.fd, data + _EVENT.pack(0, 0, EV_SYN, SYN_REPORT, 0))

    def close(self):
        if self.fd >= 0:
            try:
                fcntl.ioctl(self.fd, UI_DEV_DESTROY)
            finally:
                os.close(self.fd)
                self.fd = -1

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

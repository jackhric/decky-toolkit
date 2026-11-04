import ctypes, select, subprocess, time
ei_lib = ctypes.CDLL("libei.so.1")
P = ctypes.c_void_p
for name, res, args in [
    ("ei_new_sender", P, [P]), ("ei_configure_name", None, [P, ctypes.c_char_p]),
    ("ei_setup_backend_socket", ctypes.c_int, [P, ctypes.c_char_p]), ("ei_get_fd", ctypes.c_int, [P]),
    ("ei_dispatch", None, [P]), ("ei_get_event", P, [P]), ("ei_event_get_type", ctypes.c_int, [P]),
    ("ei_event_get_seat", P, [P]), ("ei_event_get_device", P, [P]), ("ei_event_unref", P, [P]),
    ("ei_seat_bind_capabilities", None, [P, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int]),
    ("ei_device_has_capability", ctypes.c_bool, [P, ctypes.c_int]), ("ei_device_ref", P, [P]),
    ("ei_device_get_name", ctypes.c_char_p, [P]),
    ("ei_device_start_emulating", None, [P, ctypes.c_uint32]),
    ("ei_device_pointer_motion_absolute", None, [P, ctypes.c_double, ctypes.c_double]),
    ("ei_device_frame", None, [P, ctypes.c_uint64]), ("ei_now", ctypes.c_uint64, [P]),
    ("ei_unref", P, [P]),
]:
    f = getattr(ei_lib, name); f.restype = res; f.argtypes = args

def loc():
    r = subprocess.run(["sudo", "-u", "jackh", "env", "DISPLAY=:0", "xdotool", "getmouselocation"], capture_output=True, text=True)
    return r.stdout.split(" screen")[0]

ei = ei_lib.ei_new_sender(None)
ei_lib.ei_configure_name(ei, b"decky-mcp")
assert ei_lib.ei_setup_backend_socket(ei, b"/run/user/1000/gamescope-0-ei") == 0
fd = ei_lib.ei_get_fd(ei)
dev = None
deadline = time.time() + 3
while dev is None and time.time() < deadline:
    select.select([fd], [], [], 0.2)
    ei_lib.ei_dispatch(ei)
    while (ev := ei_lib.ei_get_event(ei)):
        t = ei_lib.ei_event_get_type(ev)
        print("event", t)
        if t == 3:   # SEAT_ADDED
            ei_lib.ei_seat_bind_capabilities(ei_lib.ei_event_get_seat(ev), 1 << 1, 1 << 5, 1 << 2, 0)
        elif t == 8:  # DEVICE_RESUMED
            d = ei_lib.ei_event_get_device(ev)
            print("device", ei_lib.ei_device_get_name(d), "abs:", ei_lib.ei_device_has_capability(d, 1 << 1))
            dev = ei_lib.ei_device_ref(d)
        ei_lib.ei_event_unref(ev)
print("before", loc())
ei_lib.ei_device_start_emulating(dev, 1)
for x, y in [(965, 545), (300, 200), (960, 540)]:
    ei_lib.ei_device_pointer_motion_absolute(dev, x, y)
    ei_lib.ei_device_frame(dev, ei_lib.ei_now(ei))
    ei_lib.ei_dispatch(ei)
    time.sleep(0.3)
    print(f"ei abs {x},{y} ->", loc())
ei_lib.ei_unref(ei)

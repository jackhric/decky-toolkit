"""KeyboardEvent.code / key names -> Linux evdev KEY_* codes, plus US-layout ASCII text."""

CODES: dict[str, int] = {
    **{f"Key{c}": v for c, v in zip(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        (30, 48, 46, 32, 18, 33, 34, 35, 23, 36, 37, 38, 50, 49, 24, 25, 16, 19, 31, 20, 22, 47, 17, 45, 21, 44))},
    **{f"Digit{i}": i + 1 for i in range(1, 10)}, "Digit0": 11,
    **{f"F{i}": 58 + i for i in range(1, 11)}, "F11": 87, "F12": 88,
    **{f"F{i}": 170 + i for i in range(13, 25)},
    "Escape": 1, "Minus": 12, "Equal": 13, "Backspace": 14, "Tab": 15, "BracketLeft": 26, "BracketRight": 27,
    "Enter": 28, "ControlLeft": 29, "Semicolon": 39, "Quote": 40, "Backquote": 41, "ShiftLeft": 42,
    "Backslash": 43, "Comma": 51, "Period": 52, "Slash": 53, "ShiftRight": 54, "AltLeft": 56, "Space": 57,
    "CapsLock": 58, "NumLock": 69, "ScrollLock": 70, "IntlBackslash": 86, "IntlRo": 89, "ControlRight": 97,
    "PrintScreen": 99, "AltRight": 100, "Home": 102, "ArrowUp": 103, "PageUp": 104, "ArrowLeft": 105,
    "ArrowRight": 106, "End": 107, "ArrowDown": 108, "PageDown": 109, "Insert": 110, "Delete": 111,
    "Pause": 119, "IntlYen": 124, "MetaLeft": 125, "MetaRight": 126, "ContextMenu": 127,
    "Numpad7": 71, "Numpad8": 72, "Numpad9": 73, "NumpadSubtract": 74, "Numpad4": 75, "Numpad5": 76,
    "Numpad6": 77, "NumpadAdd": 78, "Numpad1": 79, "Numpad2": 80, "Numpad3": 81, "Numpad0": 82,
    "NumpadDecimal": 83, "NumpadEnter": 96, "NumpadDivide": 98, "NumpadMultiply": 55, "NumpadEqual": 117,
    "AudioVolumeMute": 113, "AudioVolumeDown": 114, "AudioVolumeUp": 115,
    "MediaPlayPause": 164, "MediaTrackNext": 163, "MediaTrackPrevious": 165, "MediaStop": 166,
}

# Linux KEY_* names whose spelling differs from the KeyboardEvent.code-derived aliases below.
_KEY_NAMES = {
    "ESC": 1, "LEFTBRACE": 26, "RIGHTBRACE": 27, "LEFTCTRL": 29, "APOSTROPHE": 40, "GRAVE": 41,
    "LEFTSHIFT": 42, "DOT": 52, "RIGHTSHIFT": 54, "KPASTERISK": 55, "LEFTALT": 56, "SYSRQ": 99,
    "RIGHTCTRL": 97, "RIGHTALT": 100, "UP": 103, "LEFT": 105, "RIGHT": 106, "DOWN": 108, "LEFTMETA": 125,
    "RIGHTMETA": 126, "COMPOSE": 127, "MUTE": 113, "VOLUMEDOWN": 114, "VOLUMEUP": 115, "PLAYPAUSE": 164,
    "NEXTSONG": 163, "PREVIOUSSONG": 165, "STOPCD": 166, "KPENTER": 96, "KPMINUS": 74, "KPPLUS": 78,
    "KPSLASH": 98, "KPDOT": 83, "KPEQUAL": 117, **{f"KP{i}": CODES[f"Numpad{i}"] for i in range(10)},
}

ALIASES: dict[str, int] = {
    "ctrl": 29, "control": 29, "shift": 42, "alt": 56, "meta": 125, "super": 125, "win": 125, "cmd": 125,
    "altgr": 100, "esc": 1, "escape": 1, "enter": 28, "return": 28, "tab": 15, "space": 57, "backspace": 14,
    "delete": 111, "del": 111, "insert": 110, "home": 102, "end": 107, "pageup": 104, "pgup": 104,
    "pagedown": 109, "pgdn": 109, "up": 103, "down": 108, "left": 105, "right": 106, "capslock": 58,
    "menu": 127, "printscreen": 99, "volumeup": 115, "volumedown": 114, "mute": 113, "playpause": 164,
}

# US layout: character -> (KeyboardEvent.code, shift)
_US_UNSHIFTED = {"-": "Minus", "=": "Equal", "[": "BracketLeft", "]": "BracketRight", ";": "Semicolon",
                 "'": "Quote", "`": "Backquote", "\\": "Backslash", ",": "Comma", ".": "Period", "/": "Slash",
                 " ": "Space", "\n": "Enter", "\t": "Tab"}
_US_SHIFTED = {"_": "Minus", "+": "Equal", "{": "BracketLeft", "}": "BracketRight", ":": "Semicolon",
               '"': "Quote", "~": "Backquote", "|": "Backslash", "<": "Comma", ">": "Period", "?": "Slash",
               "!": "Digit1", "@": "Digit2", "#": "Digit3", "$": "Digit4", "%": "Digit5", "^": "Digit6",
               "&": "Digit7", "*": "Digit8", "(": "Digit9", ")": "Digit0"}

TEXT: dict[str, tuple[int, bool]] = {
    **{c: (CODES[f"Key{c.upper()}"], False) for c in "abcdefghijklmnopqrstuvwxyz"},
    **{c: (CODES[f"Key{c}"], True) for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"},
    **{c: (CODES[f"Digit{c}"], False) for c in "0123456789"},
    **{c: (CODES[n], False) for c, n in _US_UNSHIFTED.items()},
    **{c: (CODES[n], True) for c, n in _US_SHIFTED.items()},
}

SHIFT = CODES["ShiftLeft"]
_LOWER = {k.lower(): v for k, v in CODES.items()}


def key_code(name: str | int) -> int:
    """Resolve one key: an evdev code, KeyboardEvent.code ("KeyA"), KEY_* name, alias ("ctrl") or character."""
    if isinstance(name, bool):
        raise ValueError(f"unknown key: {name!r}")
    if isinstance(name, int):
        if 1 <= name <= 0x2FF:
            return name
        raise ValueError(f"key code out of range: {name}")
    if not isinstance(name, str) or not name:
        raise ValueError(f"unknown key: {name!r}")
    if name in CODES:
        return CODES[name]
    if len(name) == 1 and name in TEXT:
        return TEXT[name.lower()][0] if name.isalpha() else TEXT[name][0]
    low = name.lower()
    if low in ALIASES:
        return ALIASES[low]
    if low in _LOWER:
        return _LOWER[low]
    if low.startswith("key_"):
        rest = name[4:].upper()
        if rest in _KEY_NAMES:
            return _KEY_NAMES[rest]
        for candidate in (f"key{rest.lower()}", f"digit{rest.lower()}", rest.lower()):
            if candidate in _LOWER:
                return _LOWER[candidate]
            if candidate in ALIASES:
                return ALIASES[candidate]
    if low.isdigit():
        return key_code(int(low))
    raise ValueError(f"unknown key: {name!r}")


def parse_combo(combo: str) -> list[int]:
    """"ctrl+shift+a" -> [29, 42, 30]. A literal "+" can be written as "plus"."""
    if not isinstance(combo, str) or not combo.strip():
        raise ValueError("empty key combo")
    parts = [p.strip() for p in combo.split("+")]
    if any(not p for p in parts):
        raise ValueError(f"malformed key combo: {combo!r}")
    return [CODES["Equal"] if p.lower() == "plus" else key_code(p) for p in parts]


def text_keys(text: str) -> list[tuple[int, bool]]:
    """US-layout ASCII text -> [(keycode, shift)]. Raises ValueError on characters it cannot type."""
    out = []
    for ch in text.replace("\r\n", "\n"):
        if ch not in TEXT:
            raise ValueError(f"cannot type {ch!r} with a US keyboard layout (ASCII only)")
        out.append(TEXT[ch])
    return out

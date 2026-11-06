"""Valve's text KeyValues (.vdf/.acf) format: nested quoted keys, values and { } blocks."""
from typing import Any


def _tokens(text: str):
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c.isspace():
            i += 1
        elif c == "/" and text.startswith("//", i):
            nl = text.find("\n", i)
            i = n if nl < 0 else nl + 1
        elif c in "{}":
            yield c
            i += 1
        elif c == '"':
            out = []
            i += 1
            while i < n and text[i] != '"':
                if text[i] == "\\" and i + 1 < n:
                    nxt = text[i + 1]
                    out.append({"n": "\n", "t": "\t", "\\": "\\", '"': '"'}.get(nxt, "\\" + nxt))
                    i += 2
                    continue
                out.append(text[i])
                i += 1
            i += 1
            yield ("s", "".join(out))
        else:
            j = i
            while j < n and not text[j].isspace() and text[j] not in '{}"':
                j += 1
            yield ("s", text[i:j])
            i = j


def loads(text: str) -> dict[str, Any]:
    """Parse to nested dicts. Repeated keys keep the last value; a [cond] suffix after a value is dropped."""
    root: dict[str, Any] = {}
    stack = [root]
    key: str | None = None
    for tok in _tokens(text):
        if tok == "{":
            child: dict[str, Any] = {}
            stack[-1][key if key is not None else ""] = child
            stack.append(child)
            key = None
        elif tok == "}":
            if len(stack) > 1:
                stack.pop()
            key = None
        else:
            s = tok[1]
            if key is None:
                if s.startswith("[") and s.endswith("]"):
                    continue
                key = s
            else:
                stack[-1][key] = s
                key = None
    return root


def load(path: str) -> dict[str, Any]:
    with open(path, encoding="utf-8", errors="replace") as f:
        return loads(f.read())

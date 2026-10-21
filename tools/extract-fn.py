#!/usr/bin/env python3
"""Print one function/method verbatim, from its declaration to its matching closing brace.

Line-range extracts split functions, and a reviewer that cannot see the end of `tickOnce` cannot judge whether a
lock is released on failure. This finds the symbol by name instead of guessing its extent.

A body brace is the first `{` outside parentheses whose preceding non-space character is `)`, `>`, `=`, `,` or
`{`. That skips the brace of a return type such as `Promise<{ ... }>`, which is what made a naive counter stop
after two lines (2026-10-20).

Usage: extract-fn.py <file> <symbol>
"""
import re, sys

path, symbol = sys.argv[1], sys.argv[2]
lines = open(path, encoding="utf-8").read().split("\n")
decl = re.compile(
    rf"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var)\s+{re.escape(symbol)}\b|"
    rf"^\s*(?:export\s+)?(?:async\s+)?{re.escape(symbol)}\s*\("
)
start = next((i for i, line in enumerate(lines) if decl.search(line)), None)
if start is None:
    sys.stderr.write(f"extract-fn: symbol {symbol} not found in {path}\n")
    sys.exit(2)

text = "\n".join(lines[start:])
paren = 0
body = None
prev_nonspace = ""
for idx, ch in enumerate(text):
    if ch in "([":
        paren += 1
    elif ch in ")]":
        paren = max(0, paren - 1)
    elif ch == "{" and paren == 0 and prev_nonspace in (")", ">", "=", ",", "{"):
        body = idx
        break
    if not ch.isspace():
        prev_nonspace = ch
if body is None:
    body = text.find("{")
    if body < 0:
        line_no = start + 1
        print(f"{line_no:5d}  {lines[start]}")
        sys.exit(0)

depth = 0
end = None
for idx in range(body, len(text)):
    if text[idx] == "{":
        depth += 1
    elif text[idx] == "}":
        depth -= 1
        if depth == 0:
            end = idx
            break
if end is None:
    end = len(text) - 1
chunk = text[: end + 1]
offset = start
for n, line in enumerate(chunk.split("\n")):
    print(f"{offset + n + 1:5d}  {line}")

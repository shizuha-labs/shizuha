"""Vendored fail-closed YAML subset parser for the CI guard tests.

Why this exists (PLAT-9226 parity lane): the premerge-parity runner image
ships no PyYAML and has no PyPI egress, so the guard step's
`pip install pyyaml` fallback could never succeed and every PR — and master —
went red on the PLAT-4734 guard. The guard's contract is parse-don't-
pattern-match and fail-closed, so instead of degrading it to a skip this
module really parses the workflow YAML subset the guards need whenever
PyYAML is absent.

Supported constructs (everything the repo's workflows and the guard's
self-test fixtures use):

  * block mappings and block sequences, in both indentation styles
    (sequence items indented under the key, or at the key's own column);
  * flow collections `{...}` / `[...]`, including multi-line and empty `{}`;
  * literal (`|`) and folded (`>`) block scalars with chomping
    (`-`/`+`) and explicit-indent indicators;
  * single-quoted / double-quoted / plain scalars, comments, blank lines,
    and a single leading `---` document marker.

Contract:

  * FAILS CLOSED. Any construct outside this subset — anchors, aliases,
    tags, multi-document streams, multi-line plain scalars, tabs in
    indentation, unterminated flow collections — raises :class:`MiniYamlError`.
    A parse gap turns the guard red; it can never silently read as green.
  * Scalars are returned as plain strings. The guards walk structure and
    scan string `run:` bodies; they do not depend on YAML type resolution
    (the one visible divergence from PyYAML 1.1: `on:` stays the string
    ``"on"`` instead of the bool ``True`` — nothing keys off it).

Block-scalar trailing-newline chomping is approximated (detection scans
line content, not trailing whitespace).
"""

from __future__ import annotations

import re

__all__ = ["MiniYamlError", "loads"]


class MiniYamlError(ValueError):
    """Raised on any input this parser cannot fully and unambiguously parse."""


_BLOCK_HEADER = re.compile(r"^([|>])((?:[+-]|\d)(?:[+-]|\d)?)?$")


def loads(text: str):
    """Parse *text* (a single YAML document) or raise :class:`MiniYamlError`."""
    if not isinstance(text, str):
        raise MiniYamlError("mini-yaml: input must be a string")
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return _Parser(lines).parse_document()


class _Parser:
    def __init__(self, lines):
        self.lines = lines
        self.i = 0

    # ── line helpers ──────────────────────────────────────────────────────

    def _indent_of(self, raw, lineno):
        n = 0
        for ch in raw:
            if ch == " ":
                n += 1
            elif ch == "\t":
                raise MiniYamlError(f"line {lineno}: tab in indentation")
            else:
                return n
        return n

    @staticmethod
    def _spaces_only_indent(raw):
        return len(raw) - len(raw.lstrip(" "))

    @staticmethod
    def _strip_comment(s):
        """Drop a trailing ``# comment`` (only outside quotes, only when the
        ``#`` is at content start or preceded by whitespace)."""
        in_s = in_d = esc = False
        for idx, ch in enumerate(s):
            if esc:
                esc = False
                continue
            if ch == "\\" and in_d:
                esc = True
                continue
            if ch == "'" and not in_d:
                in_s = not in_s
            elif ch == '"' and not in_s:
                in_d = not in_d
            elif ch == "#" and not in_s and not in_d:
                if idx == 0 or s[idx - 1] in " \t":
                    return s[:idx].rstrip()
        return s.rstrip()

    def _peek(self):
        """Next significant (non-blank, non-comment) line as (indent, content),
        consuming blanks/comments; None at EOF."""
        while self.i < len(self.lines):
            raw = self.lines[self.i]
            indent = self._indent_of(raw, self.i + 1)
            content = raw[indent:]
            if content == "" or content.startswith("#"):
                self.i += 1
                continue
            return indent, content
        return None

    # ── document / block dispatch ─────────────────────────────────────────

    def parse_document(self):
        while self.i < len(self.lines):
            raw = self.lines[self.i]
            content = raw.strip()
            if content in ("---", "...", "") or content.startswith("#"):
                self.i += 1
                continue
            break
        value = self._parse_block(0)
        while self.i < len(self.lines):
            raw = self.lines[self.i]
            content = raw.strip()
            if content in ("...", "") or content.startswith("#"):
                self.i += 1
                continue
            raise MiniYamlError(
                f"line {self.i + 1}: multi-document streams unsupported; "
                f"unexpected content {content[:40]!r}"
            )
        return value

    def _parse_block(self, min_indent):
        peeked = self._peek()
        if peeked is None:
            return None
        indent, content = peeked
        if indent < min_indent:
            return None
        if content.startswith("- ") or content == "-":
            return self._parse_sequence(indent)
        if self._key_split(content) is not None:
            return self._parse_mapping(indent)
        return self._parse_scalar_lines(indent, content)

    # ── sequences ─────────────────────────────────────────────────────────

    def _parse_sequence(self, seq_indent):
        items = []
        while True:
            peeked = self._peek()
            if peeked is None:
                break
            indent, content = peeked
            if indent < seq_indent:
                break
            if indent > seq_indent:
                raise MiniYamlError(f"line {self.i + 1}: bad sequence indentation")
            if not (content.startswith("- ") or content == "-"):
                break
            if content == "-":
                self.i += 1
                nxt = self._peek()
                if nxt is None or nxt[0] <= seq_indent:
                    items.append(None)
                else:
                    items.append(self._parse_block(seq_indent + 1))
                continue
            rest = content[1:].lstrip(" ")
            item_col = indent + 1 + (len(content) - 1 - len(rest))
            # Rewrite "- rest" to spaces + rest and parse the item as a block
            # starting at the item's content column.
            self.lines[self.i] = " " * item_col + rest
            items.append(self._parse_block(item_col))
        return items

    # ── mappings ──────────────────────────────────────────────────────────

    @staticmethod
    def _key_split(content):
        """Split ``key: value`` outside quotes; None when the line has no key."""
        in_s = in_d = esc = False
        for idx, ch in enumerate(content):
            if esc:
                esc = False
                continue
            if ch == "\\" and in_d:
                esc = True
                continue
            if ch == "'" and not in_d:
                in_s = not in_s
            elif ch == '"' and not in_s:
                in_d = not in_d
            elif ch == ":" and not in_s and not in_d:
                if idx + 1 == len(content) or content[idx + 1] in " \t":
                    return content[:idx], content[idx + 1:]
        return None

    def _parse_mapping(self, map_indent):
        result = {}
        while True:
            peeked = self._peek()
            if peeked is None:
                break
            indent, content = peeked
            if indent < map_indent:
                break
            if indent > map_indent:
                raise MiniYamlError(f"line {self.i + 1}: unexpected indentation in mapping")
            if content.startswith("- ") or content == "-":
                raise MiniYamlError(
                    f"line {self.i + 1}: sequence item where a mapping key was expected"
                )
            split = self._key_split(content)
            if split is None:
                raise MiniYamlError(
                    f"line {self.i + 1}: expected 'key: value', got {content[:40]!r}"
                )
            key = self._unquote(split[0].strip(), self.i + 1)
            if key is None:
                raise MiniYamlError(f"line {self.i + 1}: empty mapping key")
            value_raw = split[1].strip()
            if value_raw == "":
                self.i += 1
                nxt = self._peek()
                if nxt is not None and nxt[0] > map_indent:
                    result[key] = self._parse_block(map_indent + 1)
                elif nxt is not None and nxt[0] == map_indent and (
                    nxt[1].startswith("- ") or nxt[1] == "-"
                ):
                    result[key] = self._parse_sequence(map_indent)
                else:
                    result[key] = None
                continue
            if value_raw[0] in "|>":
                result[key] = self._parse_block_scalar(value_raw, map_indent)
                continue
            if value_raw[0] in "{[":
                result[key] = self._parse_flow_from_lines(value_raw)
                continue
            if value_raw[0] in "*&!%@":
                raise MiniYamlError(
                    f"line {self.i + 1}: unsupported YAML construct {value_raw[:20]!r}"
                )
            self.i += 1
            result[key] = self._unquote(value_raw, self.i)
            nxt = self._peek()
            if nxt is not None and nxt[0] > map_indent:
                raise MiniYamlError(
                    f"line {self.i + 1}: multi-line plain scalars unsupported (fail-closed)"
                )
        return result

    # ── scalars ───────────────────────────────────────────────────────────

    @staticmethod
    def _unquote(raw, lineno):
        raw = raw.strip()
        if raw == "":
            return None
        if len(raw) >= 2 and raw.startswith("'") and raw.endswith("'"):
            return raw[1:-1].replace("''", "'")
        if len(raw) >= 2 and raw.startswith('"') and raw.endswith('"'):
            return re.sub(r"\\(.)", r"\1", raw[1:-1])
        if raw[0] in "*&!%@":
            raise MiniYamlError(f"line {lineno}: unsupported YAML construct {raw[:20]!r}")
        return raw

    def _parse_scalar_lines(self, indent, content):
        """A bare (non-key) scalar line — sequence items like ``- echo hello``."""
        self.i += 1
        value = self._unquote(content, self.i)
        nxt = self._peek()
        if nxt is not None and nxt[0] >= indent:
            raise MiniYamlError(
                f"line {self.i + 1}: multi-line plain scalars unsupported (fail-closed)"
            )
        return value

    # ── block scalars ─────────────────────────────────────────────────────

    def _parse_block_scalar(self, header, parent_indent):
        match = _BLOCK_HEADER.match(header)
        if not match:
            raise MiniYamlError(
                f"line {self.i + 1}: unsupported block scalar header {header!r}"
            )
        folded = match.group(1) == ">"
        chomp = ""
        explicit_indent = None
        for ch in match.group(2) or "":
            if ch in "+-":
                if chomp:
                    raise MiniYamlError(f"line {self.i + 1}: duplicate chomping indicator")
                chomp = ch
            else:
                if explicit_indent is not None:
                    raise MiniYamlError(f"line {self.i + 1}: duplicate indent indicator")
                explicit_indent = int(ch)
        self.i += 1  # consume the header line

        content_indent = parent_indent + explicit_indent if explicit_indent else None
        body = []
        while self.i < len(self.lines):
            raw = self.lines[self.i]
            if raw.strip() == "":
                body.append(None)
                self.i += 1
                continue
            ind = self._spaces_only_indent(raw)
            if content_indent is None:
                if ind <= parent_indent:
                    break
                content_indent = ind
            if ind < content_indent:
                break
            body.append(raw[content_indent:])
            self.i += 1

        if chomp != "+":
            while body and body[-1] is None:
                body.pop()
        lines_out = ["" if entry is None else entry for entry in body]
        if folded:
            value = self._fold(lines_out)
        else:
            value = "\n".join(lines_out)
        if chomp != "-" and lines_out:
            value += "\n"
        return value

    @staticmethod
    def _fold(lines_out):
        parts = []
        prev_was_line = False
        for ln in lines_out:
            if ln == "":
                parts.append("\n")
                prev_was_line = False
            else:
                if prev_was_line:
                    parts.append(" ")
                parts.append(ln)
                prev_was_line = True
        return "".join(parts)

    # ── flow collections ──────────────────────────────────────────────────

    def _parse_flow_from_lines(self, first):
        buf = first
        self.i += 1  # consume the line the flow started on
        while not self._flow_balanced(buf):
            if self.i >= len(self.lines):
                raise MiniYamlError("unterminated flow collection")
            buf += " " + self.lines[self.i].strip()
            self.i += 1
        value, pos = self._flow_value(buf, 0)
        rest = buf[pos:].strip()
        if rest:
            raise MiniYamlError(f"trailing content after flow collection: {rest[:20]!r}")
        return value

    @staticmethod
    def _flow_balanced(s):
        depth = 0
        in_s = in_d = esc = False
        for ch in s:
            if esc:
                esc = False
                continue
            if ch == "\\" and in_d:
                esc = True
                continue
            if ch == "'" and not in_d:
                in_s = not in_s
            elif ch == '"' and not in_s:
                in_d = not in_d
            elif not in_s and not in_d:
                if ch in "{[":
                    depth += 1
                elif ch in "}]":
                    depth -= 1
        return depth == 0 and not in_s and not in_d

    def _flow_value(self, s, pos):
        while pos < len(s) and s[pos] == " ":
            pos += 1
        if pos >= len(s):
            raise MiniYamlError("unexpected end of flow collection")
        ch = s[pos]
        if ch == "{":
            return self._flow_map(s, pos)
        if ch == "[":
            return self._flow_seq(s, pos)
        if ch in "'\"":
            return self._flow_quoted(s, pos)
        end = pos
        while end < len(s) and s[end] not in ",}[]:":
            end += 1
        raw = s[pos:end].strip()
        if raw == "":
            raise MiniYamlError("empty flow scalar")
        return self._unquote(raw, self.i + 1), end

    def _flow_map(self, s, pos):
        pos += 1  # '{'
        result = {}
        while True:
            while pos < len(s) and s[pos] in " ,":
                pos += 1
            if pos >= len(s):
                raise MiniYamlError("unterminated flow mapping")
            if s[pos] == "}":
                return result, pos + 1
            key, pos = self._flow_value(s, pos)
            while pos < len(s) and s[pos] == " ":
                pos += 1
            if pos < len(s) and s[pos] == ":":
                val, pos = self._flow_value(s, pos + 1)
                result[key] = val
            else:
                result[key] = None
            while pos < len(s) and s[pos] == " ":
                pos += 1
            if pos < len(s) and s[pos] == ",":
                pos += 1
            elif pos < len(s) and s[pos] != "}":
                raise MiniYamlError(f"expected ',' or '}}' in flow mapping near {s[pos:pos+20]!r}")

    def _flow_seq(self, s, pos):
        pos += 1  # '['
        result = []
        while True:
            while pos < len(s) and s[pos] in " ,":
                pos += 1
            if pos >= len(s):
                raise MiniYamlError("unterminated flow sequence")
            if s[pos] == "]":
                return result, pos + 1
            value, pos = self._flow_value(s, pos)
            result.append(value)
            while pos < len(s) and s[pos] == " ":
                pos += 1
            if pos < len(s) and s[pos] == ",":
                pos += 1
            elif pos < len(s) and s[pos] != "]":
                raise MiniYamlError(f"expected ',' or ']' in flow sequence near {s[pos:pos+20]!r}")

    @staticmethod
    def _flow_quoted(s, pos):
        quote = s[pos]
        pos += 1
        buf = []
        while pos < len(s):
            ch = s[pos]
            if quote == "'" and ch == "'":
                if pos + 1 < len(s) and s[pos + 1] == "'":
                    buf.append("'")
                    pos += 2
                    continue
                return "".join(buf), pos + 1
            if quote == '"' and ch == "\\":
                buf.append(s[pos + 1] if pos + 1 < len(s) else "")
                pos += 2
                continue
            if quote == '"' and ch == '"':
                return "".join(buf), pos + 1
            buf.append(ch)
            pos += 1
        raise MiniYamlError("unterminated quoted flow scalar")

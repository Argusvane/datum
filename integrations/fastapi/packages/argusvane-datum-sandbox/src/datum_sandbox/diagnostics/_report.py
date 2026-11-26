"""`SettingsReport`: every effective value, where it came from, and what the sandbox runs.

The report is plain data: `str()` is the block the start logs on `datum.sandbox.settings`, `to_json()` the read a
management route serves. Text values pass through `scrub` (a URL's user information, query values and fragment values
masked) in both forms; `to_json(hide_paths=True)` also leaves out every value that names a path of the host, and
`without_paths` masks the absolute paths inside free text (an engine's notes).
"""

import enum
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import PurePath
from typing import Final

from datum_sandbox.wasi import EngineInfo

_URL: Final = re.compile(r"([A-Za-z][A-Za-z0-9+.-]*)://(\S+)")
_TRAILING: Final = ").,;]'\""


class Source(enum.StrEnum):
    """Where a value came from."""

    DEFAULT = "default"
    """Nothing set it: the library's (or the host's) default."""
    CONFIGURED = "configured"
    """The configuration set it, and it is used as given."""
    CLAMPED = "clamped"
    """The configuration set it outside its bound; the nearest bound is used."""
    REPLACED = "replaced"
    """The application supplied this input itself, in place of the setting."""


def _masked_pairs(text: str) -> str:
    """Mask every value of a query or fragment: `k=v` keeps `k`, a bare value is masked whole."""
    return "&".join(f"{pair.partition('=')[0]}=***" if "=" in pair else "***" for pair in text.split("&") if pair)


def _scrub_url(match: re.Match[str]) -> str:
    scheme, token = match.group(1), match.group(2)
    tail = ""
    while token and token[-1] in _TRAILING:  # punctuation around a URL in prose is not part of it
        token, tail = token[:-1], token[-1] + tail
    if "@" in token:  # everything up to the last "@" is user information (a "/" or "?" in a password included)
        token = "***@" + token.rpartition("@")[2]
    token, hash_mark, fragment = token.partition("#")
    token, question, query = token.partition("?")
    out = scheme + "://" + token
    if question:
        out += "?" + _masked_pairs(query)
    if hash_mark:
        out += "#" + _masked_pairs(fragment)
    return out + tail


def scrub(text: str) -> str:
    """Mask every URL's user information, query values and fragment values in `text` (`https://***@host/p?k=***`)."""
    return _URL.sub(_scrub_url, text)


_PATH: Final = re.compile(r"(?<![\w:/.~-])(?:/|~/|[A-Za-z]:\\)[^\s,;()\[\]]+")


def without_paths(text: str) -> str:
    """Replace every absolute file path in `text` with `<path>` (a URL's own path is not one: it follows a host)."""
    return _PATH.sub("<path>", scrub(text))


def _shown(value: object) -> object:
    if isinstance(value, str):
        return scrub(value)
    if isinstance(value, PurePath):
        return scrub(str(value))
    if isinstance(value, enum.Enum):
        return value.value
    return value


@dataclass(frozen=True, slots=True)
class ReportEntry:
    """One key: its effective value, its source, what was asked and the bound (a clamp), the resolved count (slots).

    `path` marks a value that names a path of the host (a directory, a program override): `to_json(hide_paths=True)`
    leaves it out.
    """

    key: str
    value: object
    source: Source
    asked: object = None
    bound: str | None = None
    resolved: object = None
    path: bool = False

    def text(self) -> str:
        """Return the entry as one line: `key = value (source)`, with the clamp and the resolved count if any."""
        value = _shown(self.value)
        shown = "unset" if value is None else str(value)
        if self.resolved is not None:
            shown = f"{shown} ({self.resolved})"
        if self.source is Source.CLAMPED:
            where = f"clamped from {_shown(self.asked)} to the bound {self.bound}"
        else:
            where = self.source.value
        return f"{self.key} = {shown} ({where})"

    def to_json(self) -> dict[str, object]:
        """Return the entry as a JSON object (the value numeric where it is a number, `resolved` beside it)."""
        body: dict[str, object] = {"key": self.key, "value": _shown(self.value), "source": self.source.value}
        if self.source is Source.CLAMPED:
            body["asked"] = _shown(self.asked)
            body["bound"] = self.bound
        if self.resolved is not None:
            body["resolved"] = self.resolved
        return body


@dataclass(frozen=True, slots=True)
class ProgramFacts:
    """A program as the store read it: its kind, its SHA-256, the ABI it declares, and where it came from."""

    kind: str
    sha256: str
    abi: str
    source: str
    """`packaged`, or the override's path (a host path: hidden from the management read)."""


@dataclass(frozen=True, slots=True)
class SettingsReport:
    """The effective settings, key by key, and (from a sandbox) the engine and the programs it runs."""

    entries: tuple[ReportEntry, ...]
    engine: EngineInfo | None = None
    programs: tuple[ProgramFacts, ...] = ()
    lines: tuple[str, ...] = field(default=())
    """Further state lines (the trace and capture state), printed after the entries."""

    def get(self, key: str) -> ReportEntry:
        """Return the entry for `key`; `KeyError` when there is none."""
        for entry in self.entries:
            if entry.key == key:
                return entry
        raise KeyError(key)

    def keys(self) -> tuple[str, ...]:
        """Return the keys, in report order."""
        return tuple(entry.key for entry in self.entries)

    def replaced(self, updates: Mapping[str, object]) -> "SettingsReport":
        """Return a copy whose named entries read the given values with source REPLACED."""
        entries = tuple(
            ReportEntry(entry.key, updates[entry.key], Source.REPLACED, resolved=entry.resolved, path=entry.path)
            if entry.key in updates
            else entry
            for entry in self.entries
        )
        return SettingsReport(entries, self.engine, self.programs, self.lines)

    def with_runtime(
        self, *, engine: EngineInfo | None, programs: Sequence[ProgramFacts], lines: Sequence[str] = ()
    ) -> "SettingsReport":
        """Return a copy carrying the engine, the programs and the state lines."""
        return SettingsReport(self.entries, engine, tuple(programs), tuple(lines))

    def __str__(self) -> str:
        """Return the block the start logs: a heading, one indented line per key, the engine, programs, state."""
        out = ["Datum sandbox settings (value, then where it came from):"]
        out.extend(f"  {entry.text()}" for entry in self.entries)
        if self.engine is not None:
            info = self.engine
            out.append(f"  engine: {scrub(info.id)} {scrub(info.release)} mode {scrub(info.mode)}")
            out.extend(f"    note: {scrub(note)}" for note in info.notes)
        out.extend(
            f"  program {program.kind}: sha256 {program.sha256} abi {program.abi} ({scrub(program.source)})"
            for program in self.programs
        )
        out.extend(f"  {scrub(line)}" for line in self.lines)
        return "\n".join(out)

    def to_json(self, *, hide_paths: bool = True) -> dict[str, object]:
        """Return the report as JSON; with `hide_paths` the path entries, program locations and engine notes go."""
        entries = [entry.to_json() for entry in self.entries if not (hide_paths and entry.path)]
        body: dict[str, object] = {"entries": entries}
        if self.engine is not None:
            engine: dict[str, object] = {
                "id": scrub(self.engine.id),
                "release": scrub(self.engine.release),
                "mode": scrub(self.engine.mode),
            }
            if not hide_paths:
                engine["notes"] = [scrub(note) for note in self.engine.notes]
            body["engine"] = engine
        body["programs"] = [
            {
                "kind": program.kind,
                "sha256": program.sha256,
                "abi": program.abi,
                "source": "packaged"
                if program.source == "packaged"
                else ("override" if hide_paths else scrub(program.source)),
            }
            for program in self.programs
        ]
        return body

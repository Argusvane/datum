"""The answer frame of a sandbox run, its nonce and the stdin that carries it.

The whole of stdout is the frame: the started marker, the begin marker, the answer, the end marker, each once and in
that order, with nothing but JSON whitespace (space, tab, line feed, carriage return) around the markers. Anything else
(a line a rule module reached stdout with, a second frame, a lone marker, another nonce's markers around the answer) is
not an answer and the run is refused: fail closed. The frame is read over bytes, so no guest byte is decoded before it
is judged; the answer is handed back as bytes and decoded strictly by the caller.

A marker is ``@@datum:<nonce>:<kind>@@``. The nonce in each of the three marker positions is compared with the run's in
constant time (`hmac.compare_digest`), so how long the frame check takes says nothing about how much of a forged nonce
matched.
"""

import hmac
import re
import secrets
from typing import Final, Literal

type MarkerKind = Literal["started", "begin", "end"]

NONCE_BYTES: Final = 16
"""Random bytes in a nonce."""
NONCE_LENGTH: Final = 2 * NONCE_BYTES
"""Lower-case hex characters in a nonce."""
FRAME_SPACE: Final = b" \t\n\r"
"""The whitespace allowed around the markers: JSON's (RFC 8259 section 2), never `bytes.strip()`'s wider set."""

_NONCE: Final = re.compile(r"[0-9a-f]{32}")
_PREFIX: Final = b"@@datum:"
_KINDS: Final[tuple[MarkerKind, ...]] = ("started", "begin", "end")


def new_nonce() -> str:
    """Return a fresh run nonce: 16 bytes from `secrets` as 32 lower-case hex characters."""
    return secrets.token_hex(NONCE_BYTES)


def is_nonce(nonce: str) -> bool:
    """Say whether `nonce` is one the run script accepts: exactly 32 lower-case hex characters."""
    return _NONCE.fullmatch(nonce) is not None


def _require_nonce(nonce: str) -> bytes:
    if not is_nonce(nonce):
        raise ValueError("a run nonce is 32 lower-case hex characters")
    return nonce.encode("ascii")


def run_stdin(nonce: str, input_json: bytes) -> bytes:
    """Return a sandbox run's stdin: the nonce, a line feed, then the input JSON (UTF-8)."""
    return _require_nonce(nonce) + b"\n" + input_json


def marker(nonce: str, kind: MarkerKind) -> bytes:
    """Return the marker the run script prints: ``@@datum:<nonce>:<kind>@@``."""
    return _PREFIX + _require_nonce(nonce) + b":" + kind.encode("ascii") + b"@@"


def _marker_at(stdout: bytes, at: int, nonce: bytes, kind: MarkerKind) -> int:
    """Return the end of the `kind` marker that starts at `at`, or -1; the nonce is compared in constant time."""
    suffix = b":" + kind.encode("ascii") + b"@@"
    nonce_at = at + len(_PREFIX)
    end = nonce_at + NONCE_LENGTH + len(suffix)
    if end > len(stdout) or stdout[at:nonce_at] != _PREFIX or stdout[nonce_at + NONCE_LENGTH : end] != suffix:
        return -1
    if not hmac.compare_digest(stdout[nonce_at : nonce_at + NONCE_LENGTH], nonce):
        return -1
    return end


def _skip_space(stdout: bytes, at: int, stop: int) -> int:
    while at < stop and stdout[at] in FRAME_SPACE:
        at += 1
    return at


def framed(stdout: bytes, nonce: str) -> bytes | None:
    """Return the answer between this run's begin and end markers, trimmed of JSON whitespace, or `None`.

    `None` means stdout is anything but exactly one frame of this nonce: a marker missing, repeated or out of order, any
    byte but JSON whitespace outside the answer, or a marker of this nonce inside the answer.
    """
    expected = _require_nonce(nonce)
    stop = len(stdout)
    while stop > 0 and stdout[stop - 1] in FRAME_SPACE:
        stop -= 1
    started_end = _marker_at(stdout, _skip_space(stdout, 0, stop), expected, "started")
    if started_end < 0:
        return None
    begin_end = _marker_at(stdout, _skip_space(stdout, started_end, stop), expected, "begin")
    end_at = stop - len(marker(nonce, "end"))
    if begin_end < 0 or end_at < begin_end or _marker_at(stdout, end_at, expected, "end") != stop:
        return None
    # Each marker of this nonce exactly once in the whole of stdout (non-overlapping, left to right) and first found
    # where the frame has it: a marker inside the answer, or one sharing bytes with the frame's own, refuses the run.
    begin_at = begin_end - len(marker(nonce, "begin"))
    started_at = started_end - len(marker(nonce, "started"))
    for kind, at in zip(_KINDS, (started_at, begin_at, end_at), strict=True):
        mark = marker(nonce, kind)
        if stdout.count(mark) != 1 or stdout.find(mark) != at:
            return None
    return stdout[begin_end:end_at].strip(FRAME_SPACE)


def started(stdout: bytes, nonce: str) -> bool:
    """Say whether the guest's first line ran: this run's started marker is anywhere in stdout."""
    return marker(nonce, "started") in stdout


def has_stray_output(stdout: bytes, nonce: str) -> bool:
    """Say whether stdout holds this run's begin and end markers once each (for the message: refused either way)."""
    return stdout.count(marker(nonce, "begin")) == 1 and stdout.count(marker(nonce, "end")) == 1

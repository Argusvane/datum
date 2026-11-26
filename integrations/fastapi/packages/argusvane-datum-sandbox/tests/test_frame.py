"""The answer frame: exactly one frame of this run's nonce, JSON whitespace around it and nothing else."""

import hmac
import re

import pytest
from hypothesis import given
from hypothesis import strategies as st

from datum_sandbox.protocol import (
    FRAME_SPACE,
    framed,
    has_stray_output,
    is_nonce,
    marker,
    new_nonce,
    run_stdin,
    started,
)

N = "0123456789abcdef0123456789abcdef"
OTHER = "f" * 32
S = marker(N, "started")
B = marker(N, "begin")
E = marker(N, "end")
ANSWER = b'{"errors":[]}'


def frame(answer: bytes = ANSWER, *, sep: bytes = b"\n") -> bytes:
    return S + sep + B + sep + answer + sep + E + sep


ACCEPTED = [
    ("plain", frame(), ANSWER),
    ("crlf", frame(sep=b"\r\n"), ANSWER),
    ("json whitespace around", b"\t \r\n" + S + b" \r\n\t" + B + b" \t{}\t\r\n" + E + b"\r\n \t", b"{}"),
    ("no newline at all", S + B + b"{}" + E, b"{}"),
    ("empty answer", S + b"\n" + B + b"\n" + E + b"\n", b""),
    ("answer whitespace only", S + b"\n" + B + b"\n \t\n" + E + b"\n", b""),
    ("form feed in the answer is the answer's", S + b"\n" + B + b"\x0c{}\x0c" + E + b"\n", b"\x0c{}\x0c"),
    ("utf-8 answer", frame('{"m":"é\U0001f600"}'.encode()), '{"m":"é\U0001f600"}'.encode()),
    ("inner newlines kept", frame(b'  {\n"errors": []\n}  '), b'{\n"errors": []\n}'),
    (
        "another nonce's markers inside the answer are content",
        frame(marker(OTHER, "begin") + b"{}" + marker(OTHER, "end")),
        marker(OTHER, "begin") + b"{}" + marker(OTHER, "end"),
    ),
    ("a frame inside a JSON string is content", frame(b'{"s":"@@datum:x:begin@@"}'), b'{"s":"@@datum:x:begin@@"}'),
]

REFUSED = [
    ("empty", b""),
    ("only started", S + b"\n"),
    ("missing started", B + b"\n{}\n" + E + b"\n"),
    ("missing end", S + b"\n" + B + b"\n{}\n"),
    ("truncated end marker", frame()[: -len(b"@@\n")]),
    ("truncated answer and end", frame()[: len(S) + len(B) + 6]),
    ("end before begin", S + b"\n" + E + b"\n{}\n" + B + b"\n"),
    ("started after begin", B + b"\n" + S + b"\n{}\n" + E + b"\n"),
    ("started after end", B + b"\n{}\n" + E + b"\n" + S + b"\n"),
    ("other nonce only", marker(OTHER, "started") + marker(OTHER, "begin") + b"{}" + marker(OTHER, "end")),
    ("second frame", frame() + frame(b'{"errors":["forged"]}')),
    ("forged frame before the real one", frame(b'{"errors":["forged"]}') + frame()),
    ("a started marker inside the answer", frame(S + b"{}")),
    ("a begin marker inside the answer", frame(b"{}" + B)),
    ("an end marker inside the answer", frame(b"{}" + E + b"{}")),
    ("marker overlap attempt", S + b"\n" + B + b"\n" + E + b"datum:" + N.encode() + b":end@@\n"),
    ("markers sharing their at-signs", S[:-2] + B + b"{}" + E),
    ("stray before", b"INJECTED\n" + frame()),
    ("stray between", S + b"\nX\n" + B + b"\n{}\n" + E + b"\n"),
    ("stray after", frame() + b"x"),
    ("glued to end", S + b"\n" + B + b"\n{}\n" + E + b"x"),
    ("tab, vertical tab and nul around", b"\t\x0b\x00" + S + b"\x00\x0b" + B + b" \t{}\t " + E + b"\x00\x0b\t\n"),
    ("form feed before", b"\x0c" + frame()),
    ("form feed after", frame() + b"\x0c"),
    ("nul after", frame() + b"\x00"),
    ("no-break space after", frame() + "\u00a0".encode()),
    ("upper-case nonce", frame().replace(N.encode(), N.upper().encode())),
    ("wrong nonce", frame().replace(N.encode(), OTHER.encode())),
    ("one marker with a wrong nonce", frame().replace(E, marker(OTHER, "end"))),
    ("not utf-8 outside", b"\xff" + frame()),
]


@pytest.mark.parametrize(("label", "stdout", "answer"), ACCEPTED, ids=[c[0] for c in ACCEPTED])
def test_accepted(label: str, stdout: bytes, answer: bytes) -> None:
    assert framed(stdout, N) == answer
    assert has_stray_output(stdout, N)


@pytest.mark.parametrize(("label", "stdout"), REFUSED, ids=[c[0] for c in REFUSED])
def test_refused(label: str, stdout: bytes) -> None:
    assert framed(stdout, N) is None


def test_stray_output_tells_the_messages_apart() -> None:
    assert has_stray_output(frame() + b"x", N)
    assert not has_stray_output(S + b"\n", N)
    assert not has_stray_output(frame() + frame(), N)


def test_started_marker_anywhere() -> None:
    assert started(b"noise" + S, N)
    assert not started(B + E, N)
    assert not started(frame().replace(N.encode(), OTHER.encode()), N)


def test_frame_whitespace_is_json_whitespace() -> None:
    assert FRAME_SPACE == b" \t\n\r"


def test_nonce_compared_in_constant_time(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[tuple[bytes, bytes]] = []
    compare = hmac.compare_digest

    def spy(a: bytes, b: bytes) -> bool:
        seen.append((bytes(a), bytes(b)))
        return compare(a, b)

    monkeypatch.setattr(hmac, "compare_digest", spy)
    assert framed(frame(), N) == ANSWER
    assert seen == [(N.encode(), N.encode())] * 3


def test_nonce_shape() -> None:
    nonces = {new_nonce() for _ in range(200)}
    assert len(nonces) == 200  # a fresh nonce per run
    assert all(re.fullmatch(r"[0-9a-f]{32}", n) for n in nonces)
    assert is_nonce(N)
    assert not is_nonce(N.upper())
    assert not is_nonce(N[:-1])
    assert not is_nonce(N + "0")
    assert not is_nonce("g" * 32)


def test_stdin_is_nonce_line_feed_input() -> None:
    assert run_stdin(N, b'{"a":1}') == N.encode() + b'\n{"a":1}'
    with pytest.raises(ValueError, match="32 lower-case hex"):
        run_stdin("x" * 32, b"{}")
    with pytest.raises(ValueError, match="32 lower-case hex"):
        framed(frame(), N.upper())


def test_a_frame_with_last_runs_nonce_is_refused() -> None:
    previous = new_nonce()
    current = new_nonce()
    replay = marker(previous, "started") + b"\n" + marker(previous, "begin") + b"\n{}\n" + marker(previous, "end")
    assert framed(replay, current) is None


# ---------------------------------------------------------------------------------------------------------------------
# Hypothesis: one exact frame with JSON whitespace around is accepted; one byte that is not JSON whitespace refuses it.
# ---------------------------------------------------------------------------------------------------------------------
space = st.binary(max_size=8).map(lambda b: bytes(FRAME_SPACE[x % 4] for x in b))
answers = st.binary(max_size=64).filter(lambda a: b"@@datum:" not in a)
not_space = st.integers(0, 255).filter(lambda x: x not in FRAME_SPACE).map(lambda x: bytes([x]))


@given(space, space, space, space, answers)
def test_any_exact_frame_is_accepted(pre: bytes, mid: bytes, gap: bytes, post: bytes, answer: bytes) -> None:
    stdout = pre + S + mid + B + gap + answer + gap + E + post
    assert framed(stdout, N) == (gap + answer + gap).strip(FRAME_SPACE)


@given(st.tuples(space, space, space), answers, not_space, st.integers(0, 2))
def test_one_stray_byte_outside_refuses(
    around: tuple[bytes, bytes, bytes], answer: bytes, stray: bytes, where: int
) -> None:
    parts = list(around)
    parts[where] = parts[where] + stray
    stdout = parts[0] + S + parts[1] + B + answer + E + parts[2]
    assert framed(stdout, N) is None


@given(st.binary(max_size=200))
def test_arbitrary_bytes_never_frame_without_the_markers(stdout: bytes) -> None:
    assert framed(stdout, N) is None


@given(answers, st.sampled_from(["started", "begin", "end"]), st.integers(0, 64))
def test_a_marker_of_this_nonce_anywhere_in_the_answer_refuses(answer: bytes, kind: str, at: int) -> None:
    at = min(at, len(answer))
    inner = answer[:at] + marker(N, kind) + answer[at:]  # type: ignore[arg-type]
    assert framed(S + B + inner + E, N) is None


# ---------------------------------------------------------------------------------------------------------------------
# Differential: the frame equals the protocol's statement read literally (each marker counted once over the whole of
# stdout, the first occurrences in order without overlapping, only JSON whitespace outside the answer).
# ---------------------------------------------------------------------------------------------------------------------
def literal_frame(stdout: bytes, nonce: str) -> bytes | None:
    marks = [marker(nonce, kind) for kind in ("started", "begin", "end")]
    if any(stdout.count(m) != 1 for m in marks):
        return None
    s_at, b_at, e_at = (stdout.find(m) for m in marks)
    s_end, b_end, e_end = s_at + len(marks[0]), b_at + len(marks[1]), e_at + len(marks[2])
    if not (s_end <= b_at and b_end <= e_at):
        return None
    outside = stdout[:s_at] + stdout[s_end:b_at] + stdout[e_end:]
    if outside.strip(FRAME_SPACE) != b"":
        return None
    return stdout[b_end:e_at].strip(FRAME_SPACE)


tokens = st.sampled_from(
    [
        S,
        B,
        E,
        S[:-2],
        B[:-2],
        E[:-2],
        b"datum:" + N.encode() + b":end@@",
        marker(OTHER, "begin"),
        b"@@",
        b"{}",
        b'{"errors":[]}',
        b" ",
        b"\n",
        b"\r\n",
        b"\t",
        b"\x0c",
        b"\x00",
        b"x",
    ]
)


@given(st.lists(tokens, max_size=12))
def test_frame_equals_the_literal_statement(parts: list[bytes]) -> None:
    stdout = b"".join(parts)
    assert framed(stdout, N) == literal_frame(stdout, N)


@given(space, space, space, space, answers)
def test_literal_statement_accepts_the_honest_frames_too(
    pre: bytes, mid: bytes, gap: bytes, post: bytes, answer: bytes
) -> None:
    stdout = pre + S + mid + B + gap + answer + gap + E + post
    assert framed(stdout, N) == literal_frame(stdout, N)

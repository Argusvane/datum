"""The JSON reader: the refusals, the accepted boundaries, json_size."""

import contextlib
import threading

import pytest

from datum_core.jcs import jcs_bytes
from datum_sandbox.json import BadDocumentError, RefusalReason, json_size, read
from datum_sandbox.json import _reader as reader_module  # pyright: ignore[reportPrivateUsage]

BIG = 10**308


@pytest.mark.parametrize(
    ("body", "reason"),
    [
        (b"NaN", RefusalReason.NON_FINITE),
        (b"Infinity", RefusalReason.NON_FINITE),
        (b"-Infinity", RefusalReason.NON_FINITE),
        (b"[NaN]", RefusalReason.NON_FINITE),
        (b"1e999", RefusalReason.NON_FINITE),
        (b"[-1e999]", RefusalReason.NON_FINITE),
        (b"[" + b"9" * 400 + b"]", RefusalReason.NON_FINITE),
        (b"[-" + b"9" * 309 + b"]", RefusalReason.NON_FINITE),
        # shadowed by a later duplicate: a documented strict superset of JSON.parse
        (b'{"a":1e999,"a":2}', RefusalReason.NON_FINITE),
        (b'"\\ud800"', RefusalReason.LONE_SURROGATE),
        (b'"\\udc00x"', RefusalReason.LONE_SURROGATE),
        (b'{"\\ud800":1}', RefusalReason.LONE_SURROGATE),
        (b'{"a":[{"b":["x\\udfff"]}]}', RefusalReason.LONE_SURROGATE),
        (b'"\xed\xa0\x80"', RefusalReason.NOT_UTF8),
        (b'"\xff"', RefusalReason.NOT_UTF8),
        (b"\xef\xbb\xbf{}", RefusalReason.SYNTAX),
        (b"[" + b"1" * 1001 + b"]", RefusalReason.NUMBER_TOO_LONG),
        (b"[-" + b"1" * 1000 + b"]", RefusalReason.NUMBER_TOO_LONG),
        (b"[0." + b"0" * 998 + b"1]", RefusalReason.NUMBER_TOO_LONG),
        (b"[-0." + b"0" * 997 + b"1]", RefusalReason.NUMBER_TOO_LONG),
        (b"[-1e-" + b"0" * 996 + b"1]", RefusalReason.NUMBER_TOO_LONG),
        (b"[1e" + b"0" * 999 + b"]", RefusalReason.NUMBER_TOO_LONG),
        (b"[" * 257 + b"]" * 257, RefusalReason.NESTING),
        (b'{"a":' * 257 + b"1" + b"}" * 257, RefusalReason.NESTING),
        (b"[" * 100000 + b"]" * 100000, RefusalReason.NESTING),
        (b"[" * 1000000, RefusalReason.NESTING),
        (b"", RefusalReason.SYNTAX),
        (b"{} 1", RefusalReason.SYNTAX),
        (b"[1,]", RefusalReason.SYNTAX),
        (b"[01]", RefusalReason.SYNTAX),
        (b'"abc\\', RefusalReason.SYNTAX),
        (b'"a\nb"', RefusalReason.SYNTAX),
    ],
)
def test_refusals(body: bytes, reason: RefusalReason) -> None:
    with pytest.raises(BadDocumentError) as caught:
        read(body, max_depth=256)
    assert caught.value.reason is reason
    assert caught.value.code == "bad_document"
    assert str(caught.value)


def test_positions() -> None:
    cases = [
        (b"[1,]", 2),
        (b"[[1], " + b"1" * 1001 + b"]", 6),
        (b'["[[[", ' + b"[" * 4 + b"]", 10),  # brackets inside strings do not count
        (b'"\xff"', 1),
    ]
    for body, position in cases:
        with pytest.raises(BadDocumentError) as caught:
            read(body, max_depth=3 if b"[[[" in body else 256)
        assert caught.value.position == position, body


def test_position_of_a_nesting_refusal_is_the_first_excess_bracket() -> None:
    with pytest.raises(BadDocumentError) as caught:
        read(b"[" * 257 + b"]" * 257, max_depth=256)
    assert caught.value.position == 256


def test_boundaries_accepted() -> None:
    assert read(b"[" * 256 + b"]" * 256, max_depth=256)
    assert read(b'{"a":' * 256 + b"1" + b"}" * 256, max_depth=256)
    assert read(b"[" * 512 + b"]" * 512, max_depth=512)
    assert read(b"[0." + b"0" * 997 + b"1]", max_depth=256)  # 1000 characters exactly
    assert read(b"[-0." + b"0" * 996 + b"1]", max_depth=256)  # negative, 1000 characters with the minus
    assert read(b"[-1e-" + b"0" * 995 + b"1]", max_depth=256)  # negative exponent form, 1000 characters
    assert read(b"1e-400", max_depth=256) == 0.0
    assert read(b'"\\ud83d\\ude00"', max_depth=256) == "\U0001f600"
    assert read(b" \t\r\n[1]\n ", max_depth=256) == [1]
    assert read(b'{"a":1,"a":3}', max_depth=256) == {"a": 3}  # last wins, as JSON.parse
    assert read(b"-0", max_depth=256) == 0
    assert read(b"[" + b"9" * 308 + b"]", max_depth=256) == [int("9" * 308)]
    assert read(b'["[[[[", "]]]]"]', max_depth=1) == ["[[[[", "]]]]"]


def test_a_passkey_depth_of_eight() -> None:
    assert read(b"[" * 8 + b"]" * 8, max_depth=8)
    with pytest.raises(BadDocumentError):
        read(b"[" * 9 + b"]" * 9, max_depth=8)


def test_integers_stay_exact() -> None:
    assert read(b"9007199254740993", max_depth=256) == 9007199254740993
    assert read(b"18446744073709551616", max_depth=256) == 2**64


def test_deep_input_from_worker_threads() -> None:
    errors: list[BaseException] = []

    def work() -> None:
        try:
            for depth in (256, 100000):
                body = b"[" * depth + b"]" * depth
                try:
                    read(body, max_depth=256)
                except BadDocumentError:
                    assert depth > 256
        except BaseException as error:
            errors.append(error)

    threads = [threading.Thread(target=work) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert not errors


def test_no_other_exception_escapes_for_a_mutation_sweep() -> None:
    seed = b'{"a":[1,2.5,"x\\u00e9",{"b":null}],"c":true}'
    for index in range(len(seed)):
        for replacement in (b"", b"\\", b'"', b"[", b"\xff", b"9" * 1100):
            body = seed[:index] + replacement + seed[index + 1 :]
            with contextlib.suppress(BadDocumentError):
                read(body, max_depth=256)


@pytest.mark.parametrize(
    "value",
    [
        None,
        True,
        0,
        -12,
        2**64,
        1.5,
        1e21,
        1e-7,
        "",
        "plain",
        'q"b\\n\n\t\x00\x1f\x7f\u2028é€\U0001f600',
        [],
        {},
        [1, [2, {"a": [None]}], {"b": {"c": "d"}}],
        {"é": 1, "": [], "k": {"z": 1.0}},
    ],
)
def test_json_size_equals_the_length_of_the_compact_text(value: object) -> None:
    assert json_size(value) == len(jcs_bytes(value))


def test_json_size_counts_bytes_not_characters() -> None:
    assert json_size("é") == 4
    assert json_size("\U0001f600") == 6
    assert json_size("\n") == 4
    assert json_size("\x01") == 8
    assert json_size({"a": [1, 2, True, None]}) == len(b'{"a":[1,2,true,null]}')
    assert json_size(1.0) == 1
    assert json_size(10**30) == len(b"1e+30")


def test_json_size_refuses_what_has_no_json_form() -> None:
    for value in (float("nan"), object(), {1: 2}, "\ud800"):
        with pytest.raises(BadDocumentError):
            json_size(value)


def test_json_size_handles_depth_without_recursion() -> None:
    value: object = []
    for _ in range(5000):
        value = [value]
    assert json_size(value) == 2 * 5001


# The pinned variants of the accepted forms.


@pytest.mark.parametrize(
    ("body", "reason"),
    [
        # a non-finite constant first, shadowed by a later duplicate
        (b'{"a":NaN,"a":1}', RefusalReason.NON_FINITE),
        (b'{"a":-Infinity,"a":1}', RefusalReason.NON_FINITE),
        (b'["\\ud83d","\\ude00"]', RefusalReason.LONE_SURROGATE),  # a pair split across two strings
        (b'"\\ude00\\ud83d"', RefusalReason.LONE_SURROGATE),  # a reversed pair
        (b'"\\uD83Dx"', RefusalReason.LONE_SURROGATE),  # an uppercase escape, lone
        (b'{"\\ud83d":1,"k":"\\ude00"}', RefusalReason.LONE_SURROGATE),  # split between a key and a value
    ],
)
def test_pinned_refusals(body: bytes, reason: RefusalReason) -> None:
    with pytest.raises(BadDocumentError) as caught:
        read(body, max_depth=256)
    assert caught.value.reason is reason


def test_pinned_acceptances() -> None:
    # The documented asymmetry: a lone surrogate shadowed by a later duplicate is accepted (the walk sees the final
    # value only), unlike a shadowed non-finite number, which the parser refuses as it reads it.
    assert read(b'{"a":"\\ud800","a":"x"}', max_depth=256) == {"a": "x"}
    assert read(b'"\\uD83D\\uDE00"', max_depth=256) == "\U0001f600"
    assert read(b'"\\\\ud800"', max_depth=256) == "\\ud800"  # an escaped backslash, not an escape


@pytest.mark.parametrize(
    "body",
    [
        b'{"a":1,"a":1}',
        b'{"a":1,"b":2,"a":3}',
        b'[{"ok":true},{"x":{"y":1,"y":2}}]',
        b'{"\\u0061":1,"a":2}',  # a key spelled once with an escape: the same key once decoded
    ],
)
def test_unique_keys_refuses_an_object_that_repeats_a_key(body: bytes) -> None:
    with pytest.raises(BadDocumentError) as caught:
        read(body, max_depth=256, unique_keys=True)
    assert caught.value.reason is RefusalReason.DUPLICATE_KEY
    assert read(body, max_depth=256) is not None, "without unique_keys the last value wins, as JSON.parse"


def test_unique_keys_keeps_objects_whose_keys_differ() -> None:
    body = b'{"a":1,"A":2,"b":{"a":3},"c":[{"a":4},{"a":5}]}'
    assert read(body, max_depth=256, unique_keys=True) == {"a": 1, "A": 2, "b": {"a": 3}, "c": [{"a": 4}, {"a": 5}]}


def test_mixed_nesting_at_the_bound() -> None:
    def mixed(depth: int) -> bytes:
        opens = b"".join(b"[" if level % 2 else b'{"k":' for level in range(depth))
        closes = b"".join(b"]" if level % 2 else b"}" for level in reversed(range(depth)))
        return opens + b"1" + closes

    assert read(mixed(256), max_depth=256)
    with pytest.raises(BadDocumentError) as caught:
        read(mixed(257), max_depth=256)
    assert caught.value.reason is RefusalReason.NESTING


def test_bytes_only() -> None:
    assert read(bytearray(b"[1]"), max_depth=256) == [1]
    for body in (memoryview(b"[1]"), "[1]"):
        with pytest.raises(TypeError, match="bytes"):
            read(body, max_depth=256)  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]


@pytest.mark.parametrize(
    ("body", "position"),
    [
        (b'{"k\\u0000":1}', 1),
        (b'{"k\x00":1}', 1),
        (b'{"a":[{"b\\u0000" :[1]}]}', 7),
        (b'{"a":[{"b\x00"\n:[1]}]}', 7),
        (b'{"a":"ok","\\u0000":"\\u0000"}', 10),
        (b'{"a":{"b":{"c\\u0000":1}}}', 11),
        (b'{"a":{"b":{"c\x00":1}}}', 11),
    ],
)
def test_a_nul_character_in_an_object_key_is_refused_with_its_code(body: bytes, position: int) -> None:
    with pytest.raises(BadDocumentError) as caught:
        read(body, max_depth=256)
    assert caught.value.reason is RefusalReason.NUL_CHARACTER
    assert caught.value.position == position
    assert caught.value.code == "bad_document"


def test_the_nul_key_scan_runs_only_when_a_nul_spelling_is_present(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[int] = []
    real = reader_module._locate_nul_key  # pyright: ignore[reportPrivateUsage]

    def counting(text: str) -> BadDocumentError | None:
        calls.append(len(text))
        return real(text)

    monkeypatch.setattr(reader_module, "_locate_nul_key", counting)
    clean = b'{"a":"' + b"x" * (1 << 20) + b'"}'
    clean_document = read(clean, max_depth=256)
    assert isinstance(clean_document, dict)
    assert clean_document["a"] == "x" * (1 << 20)
    assert calls == []
    false_alarm = b'{"a\\\\u0000":"' + b"x" * (1 << 20) + b'"}'
    false_alarm_document = read(false_alarm, max_depth=256)
    assert isinstance(false_alarm_document, dict)
    assert "a\\u0000" in false_alarm_document
    assert len(calls) == 1


@pytest.mark.parametrize(
    ("body", "value"),
    [
        (b'"a\\u0000b"', "a\x00b"),
        (b'"a\x00b"', "a\x00b"),
        (b'{"a":"ok\\u0000"}', {"a": "ok\x00"}),
        (b'{"a":"ok\x00"}', {"a": "ok\x00"}),
        (b'{"a":[{"b":["x\x00"]}]}', {"a": [{"b": ["x\x00"]}]}),
        (b'{"a\\\\u0000":1}', {"a\\u0000": 1}),
        (b'"\\\\u0000"', "\\u0000"),
    ],
)
def test_a_nul_in_a_string_value_is_kept_and_round_trips(body: bytes, value: object) -> None:
    result = read(body, max_depth=256)
    assert result == value
    assert read(jcs_bytes(result), max_depth=256) == value


def test_a_raw_nul_outside_a_string_is_a_syntax_refusal() -> None:
    with pytest.raises(BadDocumentError) as caught:
        read(b'{"a":1}\x00', max_depth=256)
    assert caught.value.reason is RefusalReason.SYNTAX


@pytest.mark.parametrize(
    "body",
    [b'{"a":"b"}', b'"\\\\u0000"', b'{"\\\\u0000":"\\u0001\\u00e9"}', b'["\\u0001", "\\ufffd"]'],
)
def test_a_document_without_a_nul_is_still_accepted(body: bytes) -> None:
    assert read(body, max_depth=256) is not None

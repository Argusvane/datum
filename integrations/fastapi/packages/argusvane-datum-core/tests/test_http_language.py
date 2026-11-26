"""The `Accept-Language` reader (RFC 9110 12.5.4) lives in `datum_core.http`: no framework, no process state."""

import pytest

from datum_core.http.language import preferred_language


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        ("fr-CA,fr;q=0.9,en;q=0.8", "fr-CA"),
        ("en;q=0.5, de;q=0.9", "de"),
        ("*, es;q=0.4", "es"),
        ("da, en-GB;q=0.8, en;q=0.7", "da"),
        ("en;q=0, fr;q=0.001", "fr"),
        ("en;q=1.5, fr;q=0.2", "fr"),  # a weight outside the grammar is no weight
        ("not a tag, it;q=0.3", "it"),
        ("de;q=0.5, fr;q=0.5", "de"),  # first on a tie
        ("en ; q=0.4 , pt-BR ; Q=0.6", "pt-BR"),  # spaces around the separators, the parameter name in any case
        ("", None),
        (None, None),
        ("*", None),
        ("en;q=0", None),
        ("x" * 20, None),  # a primary subtag is at most eight letters
    ],
)
def test_the_preferred_language_follows_the_weights(header: str | None, expected: str | None) -> None:
    assert preferred_language(header) == expected


def test_a_hostile_header_costs_nothing_to_read() -> None:
    assert preferred_language(",".join(["a;q=0.1"] * 20000)) == "a"

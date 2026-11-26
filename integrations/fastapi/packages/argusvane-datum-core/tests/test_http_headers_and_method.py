"""The HTTP core: repeated header lines, the case-sensitive method token, the public asset names."""

from collections.abc import Mapping

from datum_core import http
from datum_core.http import Conditional, evaluate_conditional


class Lines(Mapping[str, str]):
    """A header mapping that offers `getlist`, the way Starlette's `Headers` and multi-dict types do."""

    def __init__(self, *pairs: tuple[str, str]) -> None:
        self._pairs = pairs

    def __getitem__(self, key: str) -> str:
        for name, value in self._pairs:
            if name.casefold() == key.casefold():
                return value
        raise KeyError(key)

    def __iter__(self):  # type: ignore[no-untyped-def]
        return iter({name for name, _ in self._pairs})

    def __len__(self) -> int:
        return len({name for name, _ in self._pairs})

    def getlist(self, key: str) -> list[str]:
        return [value for name, value in self._pairs if name.casefold() == key.casefold()]


def test_repeated_if_none_match_lines_combine_when_the_mapping_offers_getlist() -> None:
    headers = Lines(("If-None-Match", '"x"'), ("if-none-match", '"a"'))
    assert evaluate_conditional("GET", headers, '"a"') is Conditional.NOT_MODIFIED


def test_repeated_if_match_lines_combine_when_the_mapping_offers_getlist() -> None:
    headers = Lines(("If-Match", '"x"'), ("If-Match", '"a"'))
    assert evaluate_conditional("PUT", headers, '"a"') is Conditional.PROCEED
    assert evaluate_conditional("PUT", Lines(("If-Match", '"x"'), ("If-Match", '"y"')), '"a"') is (
        Conditional.IF_MATCH_FAILED
    )


def test_a_mapping_without_getlist_gives_its_single_value() -> None:
    assert evaluate_conditional("GET", {"If-None-Match": '"a"'}, '"a"') is Conditional.NOT_MODIFIED


def test_a_dict_holding_the_name_in_two_cases_combines_both() -> None:
    headers = {"If-None-Match": '"x"', "if-none-match": '"a"'}
    assert evaluate_conditional("GET", headers, '"a"') is Conditional.NOT_MODIFIED


def test_the_method_token_is_case_sensitive_only_exact_get_and_head_are_safe() -> None:
    headers = {"If-None-Match": '"a"'}
    assert evaluate_conditional("GET", headers, '"a"') is Conditional.NOT_MODIFIED
    assert evaluate_conditional("HEAD", headers, '"a"') is Conditional.NOT_MODIFIED
    assert evaluate_conditional("get", headers, '"a"') is Conditional.PRECONDITION_FAILED
    assert evaluate_conditional("Head", headers, '"a"') is Conditional.PRECONDITION_FAILED


def test_the_public_asset_names_are_exported_from_the_http_package() -> None:
    for name in ("AssetCatalog", "AssetFile", "AssetSource", "WithheldAssets", "NO_CACHE", "agree_build_ids"):
        assert name in http.__all__, name
        assert hasattr(http, name), name
    assert http.NO_CACHE == "no-cache"

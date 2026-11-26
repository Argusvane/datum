"""The builder's translation catalog.

`LocaleChanges`, the catalog write, the catalog validator and normaliser, and the catalog's move with a save.

Catalogs are `locale -> kind -> owner -> tree of property segments -> text`. The write never runs a hook, judges the
form's existence before the catalog store is read, then the size, then the ETag; a first write expects the ETag of
`{}`. A save moves the catalog for the language changes it was sent with (read the catalog's ETag, write against it,
up to three attempts); the definition is stored by then, so a catalog that cannot be moved is a warning, never a
failed save.
"""

from typing import Any

import pytest
from builder_support import FORM, MARKER, Rig, definition, started_builder

from datum_core.builder import (
    CatalogOutdated,
    CatalogSaved,
    LocaleChanges,
    Malformed,
    NotFound,
    Refused,
    Saved,
    TooLarge,
    Unavailable,
)
from datum_core.stores import catalog_etag
from datum_core.stores.memory import MemoryTranslationCatalogStore, StoreFullError

EMPTY = catalog_etag({})


def at(text: str, locale: str = "fr", *, owner: str = "name", prop: str = "label") -> dict[str, Any]:
    """Build a one-text catalog: the component `owner`'s `prop` in `locale`."""
    return {locale: {"components": {owner: {prop: text}}}}


def both(*catalogs: dict[str, Any]) -> dict[str, Any]:
    """Join catalogs of different locales or owners one level deep per locale and kind."""
    joined: dict[str, Any] = {}
    for catalog in catalogs:
        for locale, kinds in catalog.items():
            for kind, owners in kinds.items():
                joined.setdefault(locale, {}).setdefault(kind, {}).update(owners)
    return joined


def put(rig: Rig, catalog: dict[str, Any], key: str = FORM) -> str:
    """Store a catalog for the form (against whatever is there) and return its ETag."""
    stored = rig.translations.inner.read(key)
    expected = EMPTY if stored is None else stored.etag
    written = rig.translations.inner.write(key, catalog, expected_etag=expected)
    assert written is not None
    return written.etag


# -- LocaleChanges -----------------------------------------------------------------------------------------------------
def test_no_changes_is_empty_and_changes_are_not() -> None:
    assert LocaleChanges().is_empty
    assert LocaleChanges.none().is_empty
    assert not LocaleChanges(removed=("de",)).is_empty
    assert not LocaleChanges(renamed=(("fr", "fr-CA"),)).is_empty


@pytest.mark.parametrize("code", ["fr", "fr-CA", "zh-Hant", "en-x-private", "ab", "abcdefgh"])
def test_a_locale_code_is_a_language_and_optional_subtags(code: str) -> None:
    assert LocaleChanges(removed=(code,)).removed == (code,)


@pytest.mark.parametrize("code", ["", "f", "fr_CA", "fr CA", "123", "fr-", "-fr", "abcdefghi", "fr-" + "x" * 9, "é"])
def test_a_code_that_is_not_a_locale_is_refused_at_construction(code: str) -> None:
    with pytest.raises(ValueError, match="locale"):
        LocaleChanges(removed=(code,))
    with pytest.raises(ValueError, match="locale"):
        LocaleChanges(renamed=((code, "fr"),))
    with pytest.raises(ValueError, match="locale"):
        LocaleChanges(renamed=(("fr", code),))


def test_changes_that_contradict_themselves_are_refused_at_construction() -> None:
    with pytest.raises(ValueError, match="fr"):
        LocaleChanges(removed=("fr", "fr"))
    with pytest.raises(ValueError, match="fr"):
        LocaleChanges(renamed=(("fr", "fr"),))
    with pytest.raises(ValueError, match="fr"):
        LocaleChanges(renamed=(("fr", "fr-CA"), ("fr", "fr-QC")))
    with pytest.raises(ValueError, match="fr"):
        LocaleChanges(removed=("fr",), renamed=(("fr", "fr-CA"),))
    with pytest.raises(ValueError, match="fr-CA"):
        LocaleChanges(renamed=(("fr", "fr-CA"), ("en", "fr-CA")))


def test_at_most_sixty_four_locales_are_named() -> None:
    names = tuple(f"x{chr(97 + n // 26)}{chr(97 + n % 26)}" for n in range(64))
    assert len(LocaleChanges(removed=names).removed) == 64
    with pytest.raises(ValueError, match="64"):
        LocaleChanges(removed=(*names, "zz"))


def test_two_codes_can_swap() -> None:
    assert LocaleChanges(renamed=(("en", "fr"), ("fr", "en"))).renamed == (("en", "fr"), ("fr", "en"))


def test_changes_are_frozen() -> None:
    with pytest.raises(AttributeError):
        setattr(LocaleChanges(), "removed", ("de",))  # noqa: B010 - the assignment is the point


# -- the catalog write: order ------------------------------------------------------------------------------------------
def test_a_catalog_for_a_form_nobody_has_is_not_found_and_the_catalog_store_is_never_asked() -> None:
    with started_builder() as rig:
        for key in ("nope", "not a key!", "a" * 129):
            assert rig.service.save_translations(key, at("un"), expected_etag=EMPTY, principal=None) == NotFound(key)
        assert rig.translations.reads == []
        assert rig.translations.writes == []


def test_a_catalog_over_the_cap_is_too_large_after_the_form_was_found_and_before_the_etag_is_read() -> None:
    with started_builder({"builder": {"max_definition_size": "1KiB"}}) as rig:
        big = at("x" * 5000)
        assert rig.service.save_translations(FORM, big, expected_etag='"stale"', principal=None) == TooLarge(1024)
        assert rig.service.save_translations("nope", big, expected_etag='"stale"', principal=None) == NotFound("nope")
        assert rig.translations.reads == []


def test_a_stale_etag_is_outdated_before_the_catalog_is_judged_valid() -> None:
    with started_builder() as rig:
        current = put(rig, at("un"))
        outcome = rig.service.save_translations(FORM, "not a catalog", expected_etag=EMPTY, principal=None)
        assert outcome == CatalogOutdated(current)
        lone = at("bad \ud800")
        assert rig.service.save_translations(FORM, lone, expected_etag=EMPTY, principal=None) == CatalogOutdated(
            current
        )


def test_a_catalog_nested_too_deep_or_with_a_lone_surrogate_is_malformed() -> None:
    deep: Any = "text"
    for _ in range(40):
        deep = {"k": deep}
    with started_builder() as rig:
        assert isinstance(rig.service.save_translations(FORM, deep, expected_etag=EMPTY, principal=None), Malformed)
        lone = at("bad \ud800")
        assert isinstance(rig.service.save_translations(FORM, lone, expected_etag=EMPTY, principal=None), Malformed)
        assert rig.translations.writes == []


def test_an_absent_etag_replaces_whatever_is_there() -> None:
    with started_builder() as rig:
        put(rig, at("un"))
        outcome = rig.service.save_translations(FORM, at("deux"), expected_etag=None, principal=None)
        assert isinstance(outcome, CatalogSaved)
        assert outcome.catalog == at("deux")


def test_the_first_write_expects_the_etag_of_the_empty_catalog() -> None:
    with started_builder() as rig:
        stale = rig.service.save_translations(FORM, at("un"), expected_etag='"' + "1" * 64 + '"', principal=None)
        assert stale == CatalogOutdated(EMPTY)
        assert rig.translations.inner.read(FORM) is None
        fine = rig.service.save_translations(FORM, at("un"), expected_etag=EMPTY, principal=None)
        assert isinstance(fine, CatalogSaved)


def test_a_catalog_save_publishes_no_event_and_runs_no_kernel_check() -> None:
    with started_builder() as rig:
        rig.service.save_translations(FORM, at("un"), expected_etag=EMPTY, principal=None)
        assert rig.events == []
        assert rig.sandbox.checks == []


def test_a_full_translation_store_is_unavailable_with_the_stores_own_error_as_the_cause() -> None:
    store = MemoryTranslationCatalogStore(1)
    assert store.write("other", at("un"), expected_etag=EMPTY) is not None
    with started_builder(translation_store=store) as rig:
        outcome = rig.service.save_translations(FORM, at("ZZSECRETZZ"), expected_etag=EMPTY, principal=None)
    assert isinstance(outcome, Unavailable)
    assert outcome.code == "server.unavailable"
    assert isinstance(outcome.cause, StoreFullError)
    assert MARKER not in outcome.reason


# -- the validator and the normaliser ----------------------------------------------------------------------------------
def deep_form(levels: int) -> dict[str, Any]:
    """A `form` tree nested `levels` keys deep under the kind, its leaf text last."""
    tree: Any = "x"
    for n in range(levels):
        tree = {f"s{n}": tree}
    return {"fr": {"form": tree}}


BAD: list[tuple[str, Any]] = [
    ("list", []),
    ("text", "text"),
    ("locale holds text", {"fr": "x"}),
    ("locale holds a list", {"fr": []}),
    ("top-level key is no locale", {"not a locale": {"form": {"title": "x"}}}),
    ("unknown kind", {"fr": {"field": {"title": "x"}}}),
    ("form holds text", {"fr": {"form": "x"}}),
    ("kind holds text", {"fr": {"components": "x"}}),
    ("owner holds text", {"fr": {"components": {"name": "x"}}}),
    ("owner holds a list", {"fr": {"components": {"name": ["x"]}}}),
    ("empty owner id", {"fr": {"components": {"": {"label": "x"}}}}),
    ("empty segment", {"fr": {"form": {"": "x"}}}),
    ("proto owner", {"fr": {"components": {"__proto__": {"label": "x"}}}}),
    ("constructor segment", {"fr": {"form": {"constructor": "x"}}}),
    ("prototype segment", {"fr": {"components": {"name": {"prototype": "x"}}}}),
    ("segment over 190", {"fr": {"form": {"k" * 191: "x"}}}),
    ("text is a number", {"fr": {"form": {"title": 7}}}),
    ("text is null", {"fr": {"form": {"title": None}}}),
    ("text over 16 KiB", {"fr": {"form": {"title": "x" * 16385}}}),
    ("13 levels under a kind", deep_form(13)),
    ("65 locales", {f"x{chr(97 + n // 26)}{chr(97 + n % 26)}": {"form": {"title": "x"}} for n in range(65)}),
]


@pytest.mark.parametrize("bad", [case for _, case in BAD], ids=[name for name, _ in BAD])
def test_a_value_that_is_not_a_catalog_is_refused_catalog_invalid_and_nothing_is_stored(bad: Any) -> None:
    with started_builder() as rig:
        outcome = rig.service.save_translations(FORM, bad, expected_etag=EMPTY, principal=None)
        assert isinstance(outcome, Refused)
        assert outcome.code == "catalog.invalid"
        assert outcome.errors
        assert {e.code for e in outcome.errors} == {"catalog.invalid"}
        assert rig.translations.inner.read(FORM) is None


def test_twelve_levels_under_a_kind_are_not_too_many() -> None:
    with started_builder() as rig:
        outcome = rig.service.save_translations(FORM, deep_form(12), expected_etag=EMPTY, principal=None)
        assert isinstance(outcome, CatalogSaved)


def test_the_engines_own_words_are_a_kind_and_are_kept() -> None:
    texts = {"fr": {"texts": {"form": {"back": "Retour"}, "messages": {"required": "Obligatoire"}}}}
    with started_builder() as rig:
        outcome = rig.service.save_translations(FORM, texts, expected_etag=EMPTY, principal=None)
        assert isinstance(outcome, CatalogSaved)
        assert rig.translations.inner.read(FORM) is not None


def test_a_problem_names_the_offence_as_a_json_pointer() -> None:
    with started_builder() as rig:
        outcome = rig.service.save_translations(
            FORM,
            {"fr-CA": {"components": {"name": {"messages": {"a/b": 7}}}}},
            expected_etag=EMPTY,
            principal=None,
        )
        assert isinstance(outcome, Refused)
        assert [e.field for e in outcome.errors] == ["/fr-CA/components/name/messages/a~1b"]


def test_more_than_ten_thousand_texts_is_refused_catalog_invalid() -> None:
    catalog = {"fr": {"components": {f"c{n}": {"label": "x"} for n in range(10_001)}}}
    with started_builder({"builder": {"max_definition_size": "64MiB"}}) as rig:
        outcome = rig.service.save_translations(FORM, catalog, expected_etag=EMPTY, principal=None)
        assert isinstance(outcome, Refused)
        assert outcome.code == "catalog.invalid"


def test_ten_thousand_texts_are_not_too_many() -> None:
    catalog = {"fr": {"components": {f"c{n}": {"label": "x"} for n in range(10_000)}}}
    with started_builder({"builder": {"max_definition_size": "64MiB"}}) as rig:
        assert isinstance(
            rig.service.save_translations(FORM, catalog, expected_etag=EMPTY, principal=None), CatalogSaved
        )


def test_a_refusal_names_the_problem_without_quoting_a_text() -> None:
    with started_builder() as rig:
        outcome = rig.service.save_translations(
            FORM,
            {"fr": {"components": {"name": {"label": 7, "description": "ZZSECRETZZ"}}, "field": {"ZZSECRETZZ": "x"}}},
            expected_etag=EMPTY,
            principal=None,
        )
        assert isinstance(outcome, Refused)
        assert all(MARKER not in (e.message or "") for e in outcome.errors)


def test_the_stored_catalog_is_normalised_keys_sorted_blank_texts_dropped_and_emptied_branches_gone() -> None:
    with started_builder() as rig:
        outcome = rig.service.save_translations(
            FORM,
            {
                "fr": {
                    "form": {"title": "Titre", "description": "  "},
                    "components": {
                        "b": {"label": "Bé", "options": {"x": {"label": ""}}},
                        "a": {"label": "A", "messages": {"required": "   "}},
                        "empty": {"label": " "},
                        "none": {},
                    },
                    "chrome": {},
                },
                "de": {"pdf": {"copy": {"name": " "}}},
            },
            expected_etag=EMPTY,
            principal=None,
        )
        assert isinstance(outcome, CatalogSaved)
        assert outcome.catalog == {
            "fr": {"form": {"title": "Titre"}, "components": {"a": {"label": "A"}, "b": {"label": "Bé"}}}
        }
        assert list(outcome.catalog["fr"]["components"]) == ["a", "b"]
        stored = rig.translations.inner.read(FORM)
        assert stored is not None
        assert (stored.catalog, stored.etag) == (outcome.catalog, outcome.etag)


def test_a_form_message_code_with_dots_is_one_segment() -> None:
    with started_builder() as rig:
        catalog = {"fr": {"form": {"messages": {"a.b.c": "x"}}}}
        outcome = rig.service.save_translations(FORM, catalog, expected_etag=EMPTY, principal=None)
        assert isinstance(outcome, CatalogSaved)
        assert outcome.catalog == catalog


# -- the catalog moves with a save -------------------------------------------------------------------------------------
def test_a_save_with_no_language_change_leaves_the_catalog_alone_and_writes_nothing() -> None:
    with started_builder() as rig:
        both_locales = both(at("un"), at("eins", "de"))
        put(rig, both_locales)
        outcome = rig.save(definition(version="2"))
        assert isinstance(outcome, Saved)
        assert outcome.catalog == both_locales
        assert outcome.removed_locales == ()
        assert rig.translations.writes == []


def test_a_removed_locale_loses_its_top_level_key() -> None:
    with started_builder() as rig:
        put(rig, both(at("un"), at("eins", "de"), at("zwei", "de", owner="other")))
        outcome = rig.save(definition(version="2"), changes=LocaleChanges(removed=("de",)))
        assert isinstance(outcome, Saved)
        assert outcome.removed_locales == ("de",)
        assert outcome.catalog == at("un")
        stored = rig.translations.inner.read(FORM)
        assert stored is not None
        assert stored.catalog == at("un")


def test_a_renamed_locale_keeps_its_wording_under_the_new_code_and_is_not_reported_removed() -> None:
    with started_builder() as rig:
        put(rig, both(at("un"), at("one", "en")))
        outcome = rig.save(definition(version="2"), changes=LocaleChanges(renamed=(("fr", "fr-CA"),)))
        assert isinstance(outcome, Saved)
        assert outcome.catalog == both(at("un", "fr-CA"), at("one", "en"))
        assert outcome.removed_locales == ()


def test_a_move_onto_a_kept_locale_merges_and_the_moved_entry_wins() -> None:
    with started_builder() as rig:
        put(rig, both(at("nouveau"), at("stale", "fr-CA"), at("seul", "fr-CA", owner="other")))
        outcome = rig.save(definition(version="2"), changes=LocaleChanges(renamed=(("fr", "fr-CA"),)))
        assert isinstance(outcome, Saved)
        assert outcome.catalog == {"fr-CA": {"components": {"name": {"label": "nouveau"}, "other": {"label": "seul"}}}}


def test_two_codes_swap_because_every_source_is_read_before_any_is_written() -> None:
    with started_builder() as rig:
        put(rig, both(at("one", "en"), at("un")))
        outcome = rig.save(definition(version="2"), changes=LocaleChanges(renamed=(("en", "fr"), ("fr", "en"))))
        assert isinstance(outcome, Saved)
        assert outcome.catalog == both(at("one", "fr"), at("un", "en"))


def test_the_move_is_written_against_the_etag_it_read() -> None:
    with started_builder() as rig:
        before = put(rig, both(at("un"), at("eins", "de")))
        assert isinstance(rig.save(definition(version="2"), changes=LocaleChanges(removed=("de",))), Saved)
        (write,) = rig.translations.writes
        assert write == (FORM, at("un"), before)


def test_a_catalog_that_changed_under_the_move_is_read_and_moved_again() -> None:
    with started_builder() as rig:
        put(rig, both(at("un"), at("eins", "de")))

        def another_author_adds_an_owner() -> None:
            current = rig.translations.inner.read(FORM)
            assert current is not None
            changed = both(current.catalog, at("deux", owner="second"), at("zwei", "de", owner="second"))
            assert rig.translations.inner.write(FORM, changed, expected_etag=current.etag) is not None

        rig.translations.interfere = another_author_adds_an_owner
        outcome = rig.save(definition(version="2"), changes=LocaleChanges(removed=("de",)))
        assert isinstance(outcome, Saved)
        assert outcome.catalog == both(at("un"), at("deux", owner="second"))
        assert outcome.removed_locales == ("de",)
        assert not any("translations" in warning for warning in outcome.warnings)
        assert len(rig.translations.writes) == 2


def test_a_move_that_keeps_losing_the_race_gives_up_after_three_attempts_with_a_warning_and_the_save_stands() -> None:
    with started_builder() as rig:
        put(rig, both(at("un"), at("eins", "de")))
        counter = {"n": 0}

        def always_another_author() -> None:
            counter["n"] += 1
            current = rig.translations.inner.read(FORM)
            assert current is not None
            changed = both(current.catalog, at("x", owner=f"extra{counter['n']}"))
            assert rig.translations.inner.write(FORM, changed, expected_etag=current.etag) is not None

        rig.translations.interfere = always_another_author
        rig.translations.interfere_always = True
        outcome = rig.save(definition(version="2"), changes=LocaleChanges(removed=("de",)))
        assert isinstance(outcome, Saved)
        assert len(rig.translations.writes) == 3
        assert rig.stored().definition["version"] == "2"
        assert any("translations" in warning for warning in outcome.warnings)
        assert outcome.removed_locales == ()  # the client must not drop locales the server kept
        assert [type(event).__name__ for event in rig.events] == ["FormDefinitionSavedEvent"]


def test_a_catalog_store_that_fails_is_a_warning_and_never_a_failed_save() -> None:
    with started_builder() as rig:
        put(rig, both(at("un"), at("eins", "de")))
        rig.translations.fail_write = RuntimeError("the catalog table is locked")
        outcome = rig.save(definition(version="2"), changes=LocaleChanges(removed=("de",)))
        assert isinstance(outcome, Saved)
        assert rig.stored().definition["version"] == "2"
        assert any("translations" in warning for warning in outcome.warnings)
        assert outcome.removed_locales == ()
        assert [type(event).__name__ for event in rig.events] == ["FormDefinitionSavedEvent"]


def test_a_create_moves_no_catalog_and_the_saved_catalog_is_empty() -> None:
    with started_builder() as rig:
        outcome = rig.create(definition("fresh"), changes=LocaleChanges(removed=("de",)))
        assert isinstance(outcome, Saved)
        assert outcome.catalog == {}
        assert rig.translations.writes == []


def test_the_saved_catalog_is_a_copy_nobody_shares_with_the_store() -> None:
    with started_builder() as rig:
        put(rig, at("un"))
        outcome = rig.save(definition(version="2"))
        assert isinstance(outcome, Saved)
        handed_out = outcome.catalog["fr"]["components"]["name"]
        assert isinstance(handed_out, dict)
        handed_out["label"] = "tampered"
        stored = rig.translations.inner.read(FORM)
        assert stored is not None
        assert stored.catalog == at("un")

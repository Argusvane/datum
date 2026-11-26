"""The builder's secrecy rules: the author's copy is never customized and never public; one hash names it everywhere;
no server-secret text reaches a log, an event or an outcome.

`author copy ETag == save ETag == sha256 of the canonical bytes` is the equality the browser's `If-Match` depends on.
The builder never runs the public-copy operation for a stored copy and never runs a definition customizer.
"""

import hashlib
import logging
from typing import Any, cast

import pytest
from builder_support import (
    FORM,
    MARKER,
    customizer,
    definition,
    finding,
    started_builder,
    validator,
    verdict,
)

from datum_core.builder import Declined, LocaleChanges, Refused, Saved, Unavailable
from datum_core.canonical import canonical_bytes, canonical_digest
from datum_core.forms import DefinitionDraft, Served, SnapshotNotRecordedError
from datum_core.hooks import HookFindings, HookProblem
from datum_core.stores import catalog_etag
from datum_sandbox.protocol import ProgramUnavailableError

PRINCIPAL_TEXT = "alice-the-principal-3f9c"


class NamedPrincipal:
    def __repr__(self) -> str:
        return PRINCIPAL_TEXT

    __str__ = __repr__


def served(rig: Any, *, public: bool, sha256: str | None = None) -> Served:
    outcome = rig.datum.definition_service.read(FORM, public=public, sha256=sha256)
    assert isinstance(outcome, Served)
    return outcome


# -- one hash everywhere -----------------------------------------------------------------------------------------------
def test_the_author_copys_etag_equals_the_save_etag_equals_the_sha256_of_the_canonical_bytes() -> None:
    sent = definition(version="2", secret=True, label="Full name")
    with started_builder(seed=[definition(secret=True)]) as rig:
        outcome = rig.save(sent)
        assert isinstance(outcome, Saved)
        author = served(rig, public=False)
    canonical = canonical_bytes(sent)
    digest = hashlib.sha256(canonical).hexdigest()
    assert author.body == canonical
    assert author.etag == '"' + digest + '"'
    assert outcome.sha256 == digest == canonical_digest(sent)
    assert author.etag == '"' + outcome.sha256 + '"'


def test_the_etag_of_a_create_is_the_hash_of_what_was_stored_and_the_next_author_read_agrees() -> None:
    sent = definition("fresh", secret=True)
    with started_builder() as rig:
        outcome = rig.create(sent)
        assert isinstance(outcome, Saved)
        read = rig.datum.definition_service.read("fresh", public=False)
        assert isinstance(read, Served)
    assert read.etag == '"' + outcome.sha256 + '"' == '"' + hashlib.sha256(canonical_bytes(sent)).hexdigest() + '"'


def test_the_previous_versions_author_copy_is_asked_for_by_its_hash_after_a_save() -> None:
    with started_builder(seed=[definition(secret=True)]) as rig:
        first = served(rig, public=False)
        first_hash = first.etag.strip('"')
        assert isinstance(rig.save(definition(version="2", secret=True)), Saved)
        older = served(rig, public=False, sha256=first_hash)
    assert older.body == first.body
    assert older.etag == first.etag


# -- the author's copy is not the public copy --------------------------------------------------------------------------
def test_the_author_copy_keeps_the_server_secret_rule_and_the_public_copy_after_a_save_does_not() -> None:
    with started_builder(seed=[definition(secret=True)]) as rig:
        assert isinstance(rig.save(definition(version="2", secret=True)), Saved)
        assert MARKER in served(rig, public=False).body.decode()
        assert MARKER not in served(rig, public=True).body.decode()
        stored = cast("dict[str, Any]", rig.stored().definition)
        assert stored["root"]["children"]["content"][0]["rules"]["requiredWhen"]["run"] == "server-secret"


def test_the_author_copy_is_never_customized_and_never_asks_the_kernel_for_a_public_copy() -> None:
    seen: list[DefinitionDraft] = []

    class Public:
        def __call__(self, draft: DefinitionDraft) -> None:
            seen.append(draft)
            draft.definition["title"] = "customized for the public"

        def cache_key(self, request: object) -> str | None:
            return None

    trail: list[str] = []
    hooks: dict[str, Any] = {
        "definition_customizers": [Public()],
        "builder_save_customizers": [customizer("a", trail)],
    }
    with started_builder(trail=trail, seed=[definition(secret=True)], **hooks) as rig:
        author = served(rig, public=False)
        assert seen == []
        assert "title" not in author.definition
        assert "sandbox.public_copy" not in trail
        assert "customizer:a" not in trail  # a save customizer is never a read customizer


def test_a_save_never_runs_a_definition_customizer_or_the_public_copy_operation() -> None:
    seen: list[DefinitionDraft] = []

    class Public:
        def __call__(self, draft: DefinitionDraft) -> None:
            seen.append(draft)

        def cache_key(self, request: object) -> str | None:
            return None

    with started_builder(seed=[definition(secret=True)], definition_customizers=[Public()]) as rig:
        assert isinstance(rig.save(definition(version="2", secret=True)), Saved)
        assert isinstance(rig.create(definition("fresh", secret=True)), Saved)
    assert seen == []
    assert rig.sandbox.public_copies == 0


def test_the_builder_serves_the_author_copy_by_the_definition_service_and_the_service_holds_no_reader_of_its_own() -> (
    None
):
    with started_builder() as rig:
        assert not hasattr(rig.service, "read")
        assert not hasattr(rig.service, "public_copy")


# -- nothing secret in a log, an event or an outcome -------------------------------------------------------------------
def everything(rig: Any, caplog: pytest.LogCaptureFixture, outcomes: list[object]) -> str:
    """All the text the operations left behind: log records (message, arguments, traceback), events and outcomes."""
    parts: list[str] = []
    for record in caplog.records:
        parts.append(record.getMessage())
        parts.append(repr(record.args))
        parts.append(record.exc_text or "")
        parts.extend(f"{key}={value!r}" for key, value in vars(record).items() if key.startswith("datum_"))
    parts.extend(repr(event) for event in rig.events)
    parts.extend(repr(outcome) for outcome in outcomes)
    return "\n".join(parts)


def test_no_server_secret_text_reaches_a_log_an_event_or_an_outcome(caplog: pytest.LogCaptureFixture) -> None:
    secret = definition(version="2", secret=True)
    outcomes: list[object] = []
    caplog.set_level(logging.DEBUG)
    errors = HookFindings(errors=(HookProblem("title", "title.reserved", "Reserved."),))
    with started_builder(
        seed=[definition(secret=True)], builder_save_validators=[validator("a", [], findings=errors)]
    ) as rig:
        # a refusal by a validator, a stale hash, a lone surrogate, an id mismatch, a catalog with the marker in it
        outcomes.append(rig.save(secret))
        outcomes.append(rig.save(secret, expected="0" * 64))
        outcomes.append(rig.save(definition(version="3", secret=True, label="\ud800")))
        outcomes.append(rig.save(definition("other", secret=True)))
        outcomes.append(
            rig.service.save_translations(
                FORM,
                {"fr": {"form": {"title": f"{MARKER} text", "description": 7}}},
                expected_etag=catalog_etag({}),
                principal=None,
            )
        )
        rig.sandbox.answer = verdict(
            problems=[
                {
                    "code": "pattern.risky",
                    "where": "rules:name:requiredWhen",
                    "message": "A risky pattern.",
                    "text": f'name = "{MARKER}"',
                    "params": {"pattern": MARKER},
                }
            ]
        )
        outcomes.append(rig.save(secret))
        rig.sandbox.error = ProgramUnavailableError("down")
        outcomes.append(rig.save(secret))
        rig.sandbox.error = None
        rig.sandbox.answer = verdict()
        text = everything(rig, caplog, outcomes)
    assert MARKER not in text


def test_a_successful_save_and_create_of_a_secret_form_log_and_publish_no_definition_text(
    caplog: pytest.LogCaptureFixture,
) -> None:
    outcomes: list[object] = []
    caplog.set_level(logging.DEBUG)
    with started_builder(seed=[definition(secret=True)]) as rig:
        outcomes.append(rig.save(definition(version="2", secret=True, label="A private label")))
        outcomes.append(rig.create(definition("fresh", secret=True, label="A private label")))
        text = everything(rig, caplog, outcomes)
    assert MARKER not in text
    assert "A private label" not in text


def test_the_kernels_text_member_and_params_are_not_carried_into_the_refusal() -> None:
    with started_builder() as rig:
        rig.sandbox.answer = verdict(
            problems=[
                {
                    "code": "pattern.risky",
                    "where": "rules:name:visibleWhen",
                    "message": "A risky pattern.",
                    "text": f"matches(name, {MARKER})",
                    "params": {"pattern": MARKER},
                }
            ]
        )
        outcome = rig.save(definition(version="2"))
    assert isinstance(outcome, Refused)
    for error in outcome.errors:
        assert MARKER not in repr(error)


def test_a_refused_bodys_hash_is_in_no_outcome_log_or_event(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    refused = definition("other", version="9", label="never stored")
    digest = canonical_digest(refused)
    with started_builder() as rig:
        outcomes = [
            rig.save(refused),
            rig.save(definition(version="9", label="never stored"), expected="0" * 64),
        ]
        rig.sandbox.answer = verdict(problems=[finding("pattern.risky")])
        refused_by_kernel = definition(version="9", label="never stored")
        outcomes.append(rig.save(refused_by_kernel))
        text = everything(rig, caplog, list(outcomes))
    assert digest not in text
    assert canonical_digest(refused_by_kernel) not in text


def test_the_principal_is_handed_to_the_hooks_only_and_appears_in_no_outcome_log_or_event(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    who = NamedPrincipal()
    drafts: list[Any] = []
    outcomes: list[object] = []
    with started_builder(builder_save_customizers=[customizer("a", [], seen=drafts)]) as rig:
        outcomes.append(rig.save(definition(version="2"), principal=who))
        outcomes.append(rig.create(definition("fresh"), principal=who))
        outcomes.append(rig.save(definition(version="3"), principal=who, expected="0" * 64))
        outcomes.append(rig.service.save_translations(FORM, {}, expected_etag=catalog_etag({}), principal=who))
        text = everything(rig, caplog, outcomes)
    assert [d.principal for d in drafts] == [who, who]
    assert PRINCIPAL_TEXT not in text


def test_a_declined_save_holds_the_hooks_refusal_and_nothing_of_the_definition() -> None:
    with started_builder(
        seed=[definition(secret=True)],
        builder_save_validators=[
            validator("a", [], findings=HookFindings(errors=(HookProblem("title", "title.reserved", "Reserved."),)))
        ],
    ) as rig:
        outcome = rig.save(definition(version="2", secret=True))
    assert isinstance(outcome, Declined)
    assert MARKER not in repr(outcome)


def test_an_unavailable_outcome_words_the_failure_without_the_definition_or_the_causes_text() -> None:
    with started_builder(seed=[definition(secret=True)]) as rig:
        rig.sandbox.error = ProgramUnavailableError(f"the program choked on {MARKER}")
        outcome = rig.save(definition(version="2", secret=True))
    assert isinstance(outcome, Unavailable)
    assert MARKER not in outcome.reason
    assert MARKER not in outcome.code


def test_a_hook_raise_is_logged_by_the_caller_not_by_the_service_with_the_definition(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    secret = definition(version="2", secret=True)
    with started_builder(
        seed=[definition(secret=True)], builder_save_customizers=[customizer("a", [], fail=RuntimeError("boom"))]
    ) as rig:
        with pytest.raises(RuntimeError):
            rig.save(secret)
        text = everything(rig, caplog, [])
    assert MARKER not in text


def test_a_kernel_findings_message_is_the_hosts_own_words_never_the_kernels_quote_of_a_rule() -> None:
    """The kernel's message may quote a pattern or a formula: every outcome and hook carries the host's words."""
    quoted = f'The pattern "{MARKER}" repeats a repeat; rewrite it'
    candidates: list[Any] = []
    with started_builder(builder_save_validators=[validator("a", [], seen=candidates)]) as rig:
        rig.sandbox.answer = verdict(
            problems=[finding("pattern.risky", "rules:name:visibleWhen", quoted)],
            structure=[finding("component.id.duplicate", "root > content > name", quoted)],
        )
        refused = rig.save(definition(version="2"))
        rig.sandbox.answer = verdict(
            warnings=[finding("formula.odd", "rules:name:visibleWhen", quoted)],
            structure_warnings=[finding("component.type.unknown", "root > content > name", quoted)],
        )
        saved = rig.save(definition(version="2"))
    assert isinstance(refused, Refused)
    assert [(e.code, e.field) for e in refused.errors] == [
        ("pattern.risky", "rules:name:visibleWhen"),
        ("component.id.duplicate", "root > content > name"),
    ]
    assert isinstance(saved, Saved)
    (candidate,) = candidates
    for problem in (*refused.errors, *saved.kernel_warnings, *candidate.warnings, *candidate.structure_warnings):
        assert problem.message
        assert MARKER not in problem.message
        assert "pattern" not in problem.message.casefold()


def test_a_store_failure_after_the_save_is_logged_by_its_type_never_its_text(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    with started_builder(seed=[definition(secret=True)]) as rig:
        seeded = rig.service.save_translations(
            FORM,
            {"fr": {"form": {"title": "un"}}, "en": {"form": {"title": "one"}}},
            expected_etag=catalog_etag({}),
            principal=None,
        )
        rig.translations.fail_write = RuntimeError(MARKER)
        moved = rig.save(definition(version="2", secret=True), changes=LocaleChanges(removed=("fr",)))
        rig.translations.fail_write = None
        rig.snapshots.fail = SnapshotNotRecordedError(f"INSERT parameters {MARKER}")
        recorded = rig.save(definition(version="3", secret=True))
        for outcome in (moved, recorded):
            assert isinstance(outcome, Saved)
            assert outcome.warnings
        warned = [r for r in caplog.records if r.name == "datum.builder" and r.levelno == logging.WARNING]
        assert len(warned) >= 2
        assert MARKER not in everything(rig, caplog, [seeded, moved, recorded])


def test_any_snapshot_store_raise_is_a_warning_logged_by_type_and_the_event_still_publishes(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    with started_builder(seed=[definition(secret=True)]) as rig:
        rig.snapshots.fail = RuntimeError(MARKER)
        outcome = rig.save(definition(version="2", secret=True))
        assert isinstance(outcome, Saved)
        assert outcome.warnings
        assert [type(event).__name__ for event in rig.events] == ["FormDefinitionSavedEvent"]
        assert any("RuntimeError" in r.getMessage() for r in caplog.records if r.name == "datum.builder")
        assert MARKER not in everything(rig, caplog, [outcome])

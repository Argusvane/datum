"""`timestamp_request_customizers`, the stage between the request's own policy and the time source.

A customizer sees a frozen `TimestampRequestDraft` and answers a changed copy or `None`. It runs in list order (each
sees what the one before left; the first refusal stops the rest). The endpoint's tokens carry channel `http`; the
host's own seals and receipts reach only a customizer whose `applies_to(channel)` is true or one wrapped in
`every_channel` (a bare callable is endpoint-only). It chooses the policy only among the accepted ones and only when the
request names none, and an accuracy of 0 to 60 seconds. A `TimestampRefusedError` refuses with its failure bit; a
`HookRefusedError` of any kind is `badRequest` with its message; any other raise (a draft out of bounds included) is
`systemFailure` with the cause in the log only. A refusal costs no key use and no serial.
"""

import logging
from collections.abc import Callable, Sequence
from typing import Any

import pytest
from submissions_support import ThreadLoopAwaiter, assign
from tsa_der import parse_reply, query_der, token_parts
from tsa_support import (
    FOREIGN_POLICY,
    OTHER_POLICY,
    POLICY,
    Clock,
    CountingSerials,
    IdentityKey,
    make_authority,
    refused,
    sha256,
)

from datum_core.events import DatumEvent, EventDispatcher, TimestampRefusedEvent
from datum_core.hooks import HookRefusedError
from datum_core.loggers import TSA
from datum_core.testing.tsa_pki import TsaPki
from datum_core.timestamp import (
    TimestampAuthority,
    TimestampChannel,
    TimestampQuery,
    TimestampRefusedError,
    TimestampRequestDraft,
    every_channel,
)

DIGEST = sha256(b"hello")


class Rig:
    def __init__(self, tsa_pki: TsaPki, *customizers: Any, **seams: Any) -> None:
        self.key = IdentityKey(tsa_pki.ec)
        self.serials = CountingSerials()
        self.clock = Clock()
        self.events: list[DatumEvent] = []
        self.authority: TimestampAuthority = make_authority(
            tsa_pki.ec,
            key=self.key,
            serials=self.serials,
            time_source=self.clock,
            customizers=customizers,
            events=EventDispatcher([(DatumEvent, self.events.append)]),
            **seams,
        )

    def ask(self, *, channel: TimestampChannel = "http", **fields: Any) -> Any:
        client = fields.pop("client", None)
        principal = fields.pop("principal", None)
        query = TimestampQuery.parse(query_der(DIGEST, **fields))
        return self.authority.issue(query, channel=channel, client=client, principal=principal)

    def untouched(self) -> bool:
        return self.key.signs == 0 and self.serials.allocations == 0 and self.clock.reads == 0

    def refusal(self, **fields: Any) -> TimestampRefusedError:
        with pytest.raises(TimestampRefusedError) as raised:
            self.ask(**fields)
        return raised.value


def recorder(seen: list[TimestampRequestDraft]) -> Callable[[TimestampRequestDraft], None]:
    def customize(draft: TimestampRequestDraft) -> None:
        seen.append(draft)

    return customize


# -- what a customizer is told -----------------------------------------------------------------------------------------
def test_the_draft_names_the_request_the_issuing_defaults_the_client_and_the_principal(tsa_pki: TsaPki) -> None:
    seen: list[TimestampRequestDraft] = []
    person = object()
    rig = Rig(tsa_pki, recorder(seen), accuracy=2.0)
    rig.ask(policy=OTHER_POLICY, cert_req=True, client="client-1", principal=person)
    (draft,) = seen
    assert draft.channel == "http"
    assert draft.imprint_algorithm == "sha256"
    assert draft.requested_policy == OTHER_POLICY
    assert draft.policy == OTHER_POLICY
    assert set(draft.accepted_policies) == {POLICY, OTHER_POLICY}
    assert draft.accuracy == 2.0
    assert draft.cert_req is True
    assert draft.client == "client-1"
    assert draft.principal is person


def test_a_request_naming_no_policy_shows_the_issuing_one_and_requested_none(tsa_pki: TsaPki) -> None:
    seen: list[TimestampRequestDraft] = []
    Rig(tsa_pki, recorder(seen)).ask()
    assert seen[0].requested_policy is None
    assert seen[0].policy == POLICY


def test_the_draft_is_frozen(tsa_pki: TsaPki) -> None:
    def mutate(draft: TimestampRequestDraft) -> None:
        assign(draft, "policy", OTHER_POLICY)

    rig = Rig(tsa_pki, mutate)
    assert rig.refusal().failure == "systemFailure"


# -- the channel rule --------------------------------------------------------------------------------------------------
@pytest.mark.parametrize(("channel", "runs"), [("http", True), ("seal", False), ("receipt", False)])
def test_a_bare_callable_runs_for_the_endpoint_only(tsa_pki: TsaPki, channel: TimestampChannel, runs: bool) -> None:
    seen: list[TimestampRequestDraft] = []
    Rig(tsa_pki, recorder(seen)).ask(channel=channel)
    assert bool(seen) is runs


@pytest.mark.parametrize("channel", ["http", "seal", "receipt"])
def test_a_customizer_wrapped_in_every_channel_runs_for_all_three(tsa_pki: TsaPki, channel: TimestampChannel) -> None:
    seen: list[TimestampRequestDraft] = []
    Rig(tsa_pki, every_channel(recorder(seen))).ask(channel=channel)
    assert [draft.channel for draft in seen] == [channel]


def test_applies_to_decides_per_channel(tsa_pki: TsaPki) -> None:
    seen: list[str] = []

    class SealsOnly:
        def __call__(self, draft: TimestampRequestDraft) -> None:
            seen.append(draft.channel)

        def applies_to(self, channel: str) -> bool:
            return channel == "seal"

    rig = Rig(tsa_pki, SealsOnly())
    for channel in ("http", "seal", "receipt"):
        rig.ask(channel=channel)
    assert seen == ["seal"]


def test_a_refusing_customizer_for_the_endpoint_does_not_stop_the_hosts_own_seal(tsa_pki: TsaPki) -> None:
    def refuse(draft: TimestampRequestDraft) -> None:
        raise HookRefusedError.forbidden("tsa.no", "No timestamps for you.")

    rig = Rig(tsa_pki, refuse)
    assert rig.ask(channel="seal").serial == 1
    assert rig.refusal().failure == "badRequest"


# -- order -------------------------------------------------------------------------------------------------------------
def test_customizers_run_in_list_order_and_each_sees_what_the_one_before_left(tsa_pki: TsaPki) -> None:
    seen: list[float] = []

    def first(draft: TimestampRequestDraft) -> TimestampRequestDraft:
        return draft.with_accuracy(5.0)

    def second(draft: TimestampRequestDraft) -> None:
        seen.append(draft.accuracy)

    def third(draft: TimestampRequestDraft) -> TimestampRequestDraft:
        return draft.with_accuracy(draft.accuracy + 1)

    grant = Rig(tsa_pki, first, second, third).ask()
    assert seen == [5.0]
    assert token_parts(grant.token).tst.accuracy == (6, None, None)


def test_the_first_refusal_stops_the_rest(tsa_pki: TsaPki) -> None:
    later: list[TimestampRequestDraft] = []

    def refuse(draft: TimestampRequestDraft) -> None:
        raise TimestampRefusedError("badRequest", "No.")

    rig = Rig(tsa_pki, recorder([]), refuse, recorder(later))
    assert rig.refusal().failure == "badRequest"
    assert later == []


def test_none_leaves_the_draft_as_it_is(tsa_pki: TsaPki) -> None:
    grant = Rig(tsa_pki, lambda draft: None).ask()
    assert token_parts(grant.token).tst.policy == POLICY


def test_an_async_customizer_is_resolved_through_the_awaiter(tsa_pki: TsaPki) -> None:
    async def choose(draft: TimestampRequestDraft) -> TimestampRequestDraft:
        return draft.with_policy(OTHER_POLICY)

    awaiter = ThreadLoopAwaiter()
    try:
        grant = Rig(tsa_pki, choose, awaiter=awaiter).ask()
    finally:
        awaiter.close()
    assert token_parts(grant.token).tst.policy == OTHER_POLICY


# -- policy: only among the accepted, only when the request names none -------------------------------------------------
def test_a_customizer_picks_the_policy_among_the_accepted_when_the_request_names_none(tsa_pki: TsaPki) -> None:
    grant = Rig(tsa_pki, lambda draft: draft.with_policy(OTHER_POLICY)).ask()
    assert token_parts(grant.token).tst.policy == OTHER_POLICY


def test_a_customizer_cannot_pick_a_policy_the_server_does_not_accept(tsa_pki: TsaPki) -> None:
    rig = Rig(tsa_pki, lambda draft: draft.with_policy(FOREIGN_POLICY))
    assert rig.refusal().failure == "systemFailure"
    assert rig.key.signs == 0


def test_a_customizer_cannot_change_a_policy_the_request_named(tsa_pki: TsaPki) -> None:
    rig = Rig(tsa_pki, lambda draft: draft.with_policy(POLICY))
    assert rig.refusal(policy=OTHER_POLICY).failure == "systemFailure"
    assert rig.key.signs == 0


def test_a_customizer_leaving_the_named_policy_alone_is_fine(tsa_pki: TsaPki) -> None:
    grant = Rig(tsa_pki, lambda draft: draft.with_accuracy(3.0)).ask(policy=OTHER_POLICY)
    assert token_parts(grant.token).tst.policy == OTHER_POLICY


# -- accuracy: 0 to 60 seconds -----------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("asked", "stated"), [(0, None), (2.0, (2, None, None)), (60.0, (60, None, None)), (0.5, (None, 500, None))]
)
def test_a_customizer_sets_the_accuracy_within_0_to_60_seconds(
    tsa_pki: TsaPki, asked: float, stated: tuple[int | None, int | None, int | None] | None
) -> None:
    grant = Rig(tsa_pki, lambda draft: draft.with_accuracy(asked)).ask()
    assert token_parts(grant.token).tst.accuracy == stated


@pytest.mark.parametrize("asked", [-0.001, 60.001, 61, 1e9, float("inf"), float("nan")])
def test_an_accuracy_out_of_bounds_is_a_system_failure_and_costs_nothing(tsa_pki: TsaPki, asked: float) -> None:
    rig = Rig(tsa_pki, lambda draft: draft.with_accuracy(asked))
    assert rig.refusal().failure == "systemFailure"
    assert rig.untouched()


# -- refusals ----------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("failure", "bit", "status"),
    [
        ("badRequest", 2, 400),
        ("badAlg", 0, 400),
        ("unacceptedPolicy", 15, 400),
        ("timeNotAvailable", 14, 503),
        ("systemFailure", 25, 503),
    ],
)
def test_a_timestamp_refused_error_answers_with_its_own_failure_bit(
    tsa_pki: TsaPki, failure: str, bit: int, status: int
) -> None:
    def refuse(draft: TimestampRequestDraft) -> None:
        raise refused(failure, "Declined by the application.")

    rig = Rig(tsa_pki, refuse)
    answer = rig.authority.answer(query_der(DIGEST))
    assert answer.refusal is not None
    assert answer.refusal.http_status == status
    read = parse_reply(answer.response)
    assert read.fail_bits == {bit}
    assert any("Declined by the application." in text for text in read.texts)
    assert rig.untouched()


@pytest.mark.parametrize(
    "refusal",
    [
        HookRefusedError.forbidden("tsa.no", "Not this client."),
        HookRefusedError.conflict("tsa.busy", "Not this client."),
        HookRefusedError.invalid("tsa.bad", "Not this client."),
    ],
    ids=["forbidden", "conflict", "invalid"],
)
def test_a_hook_refusal_of_any_kind_is_bad_request_with_its_message(tsa_pki: TsaPki, refusal: HookRefusedError) -> None:
    def refuse(draft: TimestampRequestDraft) -> None:
        raise refusal

    rig = Rig(tsa_pki, refuse)
    answer = rig.authority.answer(query_der(DIGEST))
    read = parse_reply(answer.response)
    assert read.fail_bits == {2}
    assert any("Not this client." in text for text in read.texts)
    assert rig.untouched()


def test_any_other_raise_is_a_system_failure_with_the_cause_in_the_log_only(
    tsa_pki: TsaPki, caplog: pytest.LogCaptureFixture
) -> None:
    def explode(draft: TimestampRequestDraft) -> None:
        raise RuntimeError("customizer bug: db.internal.example refused the connection")

    rig = Rig(tsa_pki, explode)
    with caplog.at_level(logging.DEBUG, logger=TSA):
        answer = rig.authority.answer(query_der(DIGEST))
    assert parse_reply(answer.response).fail_bits == {25}
    assert answer.refusal is not None
    assert "db.internal.example" not in answer.refusal.text
    assert "db.internal.example" not in answer.response.decode("latin-1")
    assert "db.internal.example" in caplog.text or any("db.internal.example" in str(r.exc_info) for r in caplog.records)
    assert rig.untouched()


def test_a_refusal_publishes_the_refused_event_only(tsa_pki: TsaPki) -> None:
    def refuse(draft: TimestampRequestDraft) -> None:
        raise TimestampRefusedError("badRequest", "No.")

    rig = Rig(tsa_pki, refuse)
    rig.authority.answer(query_der(DIGEST))
    assert [type(event) for event in rig.events] == [TimestampRefusedEvent]
    event = rig.events[0]
    assert isinstance(event, TimestampRefusedEvent)
    assert event.fail_info == "badRequest"


def test_the_requests_own_policy_is_judged_before_any_customizer_runs(tsa_pki: TsaPki) -> None:
    seen: list[TimestampRequestDraft] = []
    rig = Rig(tsa_pki, recorder(seen))
    assert rig.refusal(policy=FOREIGN_POLICY).failure == "unacceptedPolicy"
    assert seen == []


def test_customizers_are_asked_before_the_time_source(tsa_pki: TsaPki) -> None:
    def refuse(draft: TimestampRequestDraft) -> None:
        raise TimestampRefusedError("badRequest", "No.")

    rig = Rig(tsa_pki, refuse)
    rig.clock.reason = "down"
    assert rig.refusal().failure == "badRequest"
    assert rig.clock.reads == 0


def test_several_customizers_see_a_request_a_sequence_may_be_given_as_a_tuple_or_a_list(tsa_pki: TsaPki) -> None:
    for container in (list, tuple):
        calls: Sequence[Any] = container([lambda draft: None])
        authority = make_authority(tsa_pki.ec, customizers=calls)
        assert authority.issue(TimestampQuery.parse(query_der(DIGEST))).serial >= 1

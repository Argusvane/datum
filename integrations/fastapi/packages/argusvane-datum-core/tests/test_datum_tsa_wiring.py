"""`Datum` and the timestamp seams: the keywords, what is built and when, health and info.

`timestamp_request_customizers`, `tsa_time_source`, `tsa_key_material`, `tsa_serial_allocator`, `tsa_log`,
`tsa_client_store` and `tsa_transport` are keyword-only seams. `Datum.timestamp_authority` and `Datum.timestamp_gate`
exist while Datum is started AND `datum.tsa.enabled`; the key is loaded at `start()` (the settings it names are read
once, a failed load stops the start with nothing half-built); health `tsa` is registered once, only when enabled, and
never fails `readyz`.
"""

import inspect
import json
import logging
import subprocess
import sys
import threading
import time
import warnings
from datetime import datetime
from pathlib import Path
from typing import Any, cast, get_type_hints

import anyio
import anyio.to_thread
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from submissions_support import capabilities_of
from tsa_der import token_parts
from tsa_support import (
    KEY_PASSWORD,
    OTHER_POLICY,
    P12_PASSWORD,
    POLICY,
    Clock,
    CountingSerials,
    IdentityKey,
    ListLog,
    fixed_now,
    leaks,
    pem_signer,
    pkcs12_signer,
    plain_tsa_datum,
    query_of,
    secrets_of,
    started_tsa,
    tsa_config,
)

from datum_core import Datum, DatumNotStartedError
from datum_core.aio import anyio_awaiter
from datum_core.datum import DatumOptions
from datum_core.loggers import CHECKS, TSA
from datum_core.stores.memory import MemoryTsaLog
from datum_core.stores.tsa import SettingsTsaClientStore
from datum_core.testing.tsa_pki import INSTANT, TsaPki
from datum_core.timestamp import Reading, TimestampAuthority, TimestampRefusedError, every_channel
from datum_core.timestamp.protocols import TimestampRequestDraft
from datum_sandbox.checks import DatumConfigurationError

KEYWORDS = [
    "timestamp_request_customizers",
    "tsa_time_source",
    "tsa_key_material",
    "tsa_serial_allocator",
    "tsa_log",
    "tsa_client_store",
    "tsa_transport",
]


# -- the keywords ------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("keyword", KEYWORDS)
def test_each_seam_is_a_keyword_only_parameter_a_binding_can_pass_on(keyword: str) -> None:
    parameter = inspect.signature(Datum).parameters[keyword]
    assert parameter.kind is inspect.Parameter.KEYWORD_ONLY
    assert keyword in get_type_hints(DatumOptions)


def test_the_customizers_default_to_nothing_and_keep_the_list_order() -> None:
    first, second = (lambda draft: None), (lambda draft: None)
    datum = plain_tsa_datum(timestamp_request_customizers=[first, second])
    assert datum.timestamp_request_customizers == (first, second)
    assert plain_tsa_datum().timestamp_request_customizers == ()


def test_the_customizers_may_be_given_as_a_tuple() -> None:
    one = every_channel(lambda draft: None)
    assert plain_tsa_datum(timestamp_request_customizers=(one,)).timestamp_request_customizers == (one,)


def test_a_customizer_that_is_not_callable_is_a_type_error_at_construction() -> None:
    with pytest.raises(TypeError, match="timestamp_request_customizers"):
        plain_tsa_datum(timestamp_request_customizers=[cast("Any", 7)])
    with pytest.raises(TypeError):
        plain_tsa_datum(timestamp_request_customizers=cast("Any", lambda draft: None))  # a callable, not a sequence


def test_a_misspelt_keyword_is_a_type_error() -> None:
    with pytest.raises(TypeError, match="timestamp_request_customizer"):
        plain_tsa_datum(timestamp_request_customizer=[lambda draft: None])


def test_the_seams_are_kept_as_given() -> None:
    key, clock, serials, log, transport = (
        IdentityKey.__new__(IdentityKey),
        Clock(),
        CountingSerials(),
        ListLog(),
        object(),
    )
    store = SettingsTsaClientStore([])
    datum = plain_tsa_datum(
        tsa_key_material=key,
        tsa_time_source=clock,
        tsa_serial_allocator=serials,
        tsa_log=log,
        tsa_client_store=store,
        tsa_transport=transport,
    )
    assert datum.tsa_key_material is key
    assert datum.tsa_time_source is clock
    assert datum.tsa_serial_allocator is serials
    assert datum.tsa_log is log
    assert datum.tsa_client_store is store
    assert datum.tsa_transport is transport


# -- when the authority exists -----------------------------------------------------------------------------------------
def test_the_authority_and_the_gate_exist_only_while_started(tsa_pki: TsaPki) -> None:
    datum = plain_tsa_datum(
        tsa_key_material=IdentityKey(tsa_pki.ec), tsa_serial_allocator=CountingSerials(), tsa_log=ListLog()
    )
    for name in ("timestamp_authority", "timestamp_gate"):
        with pytest.raises(DatumNotStartedError):
            getattr(datum, name)
    datum.start()
    try:
        assert isinstance(datum.timestamp_authority, TimestampAuthority)
        assert datum.timestamp_authority is datum.timestamp_authority
        assert datum.timestamp_gate is not None
    finally:
        datum.stop()
    with pytest.raises(DatumNotStartedError):
        datum.timestamp_authority  # noqa: B018


def test_each_start_builds_its_own_authority(tsa_pki: TsaPki) -> None:
    datum = plain_tsa_datum(
        tsa_key_material=IdentityKey(tsa_pki.ec), tsa_serial_allocator=CountingSerials(), tsa_log=ListLog()
    )
    datum.start()
    first = datum.timestamp_authority
    datum.stop()
    datum.start()
    try:
        assert datum.timestamp_authority is not first
    finally:
        datum.stop()


def test_after_stop_the_authority_allocates_no_serial_signs_nothing_and_publishes_nothing(tsa_pki: TsaPki) -> None:
    """The stop gate: the authority's events dispatcher is the start's scoped one, closed by `Datum.stop()`."""
    with started_tsa(tsa_pki.ec) as rig:
        authority = rig.authority
        assert authority.issue(query_of()).serial == 1  # it works while the Datum runs
        rig.events.clear()
    with pytest.raises(TimestampRefusedError) as raised:
        authority.issue(query_of())
    assert raised.value.failure == "systemFailure"
    assert rig.serials.allocations == 1
    assert rig.key.signs == 1
    assert len(rig.log.entries) == 1
    assert rig.events == []


def test_with_the_tsa_off_nothing_is_built_and_the_seams_are_never_touched(tsa_pki: TsaPki) -> None:
    touched: list[str] = []

    class Spy(IdentityKey):
        @property
        def chain_der(self) -> tuple[bytes, ...]:
            touched.append("chain")
            return super().chain_der

    datum = plain_tsa_datum(tsa_config(enabled=False), tsa_key_material=Spy(tsa_pki.ec))
    datum.start()
    try:
        assert datum.timestamp_authority is None
        assert datum.timestamp_gate is None
        assert "tsa" not in datum.health().components
        assert touched == []
    finally:
        datum.stop()


def test_the_authority_issues_through_the_seams_the_datum_was_given(tsa_pki: TsaPki) -> None:
    with started_tsa(tsa_pki.ec) as rig:
        grant = rig.issue()
    assert grant.serial == 1
    assert rig.key.signs == 1
    assert rig.serials.allocations == 1
    assert rig.clock.reads == 1
    assert len(rig.log.entries) == 1
    assert token_parts(grant.token).tst.imprint == query_of().imprint


def test_a_customizer_given_to_datum_runs_for_the_endpoints_tokens(tsa_pki: TsaPki) -> None:
    seen: list[str] = []

    def spy(draft: TimestampRequestDraft) -> None:
        seen.append(draft.channel)

    with started_tsa(tsa_pki.ec, timestamp_request_customizers=[spy]) as rig:
        rig.authority.issue(query_of(), channel="http")
        rig.authority.issue(query_of(), channel="seal")
    assert seen == ["http"]


def test_the_clients_store_the_datum_was_given_is_the_one_the_gate_asks(tsa_pki: TsaPki) -> None:
    asked: list[str] = []

    class Mine(SettingsTsaClientStore):
        def find(self, key_hash: str) -> Any:
            asked.append(key_hash)
            return super().find(key_hash)

    with started_tsa(tsa_pki.ec, tsa_config(access="clients"), tsa_client_store=Mine([])) as rig:
        gate = rig.datum.timestamp_gate
        assert gate is not None
        gate.admit(
            {"Content-Type": "application/timestamp-query", "Authorization": "Bearer dtsa_x"},
            remote_address="192.0.2.1",
        )
    assert len(asked) == 1


# -- the key is loaded at start ----------------------------------------------------------------------------------------
def test_a_pkcs12_key_named_in_the_settings_is_read_at_start_and_signs_after_the_file_is_gone(
    tmp_path: Path, tsa_pki: TsaPki
) -> None:
    signer = pkcs12_signer(tmp_path, tsa_pki.ec)
    datum = plain_tsa_datum(
        tsa_config(allow_memory_stores=True, signer=signer.model_dump(mode="python")),
    )
    datum.start()
    try:
        Path(signer.pkcs12_file or "").unlink()
        authority = datum.timestamp_authority
        assert authority is not None
        grant = authority.issue(query_of())
        assert token_parts(grant.token).certificates
    finally:
        datum.stop()


def test_a_failed_key_load_stops_the_start_and_leaves_nothing_half_built(tmp_path: Path, tsa_pki: TsaPki) -> None:
    signer = pkcs12_signer(tmp_path, tsa_pki.ec)
    bad = {**signer.model_dump(mode="python"), "pkcs12_password": "not-the-password"}
    datum = plain_tsa_datum(tsa_config(allow_memory_stores=True, signer=bad))
    with pytest.raises(DatumConfigurationError) as raised:
        datum.start()
    assert not datum.started
    assert "not-the-password" not in str(raised.value)
    assert P12_PASSWORD not in str(raised.value)
    with pytest.raises(DatumNotStartedError):
        datum.timestamp_authority  # noqa: B018


def test_a_failed_load_names_the_signer_setting_and_no_secret(tmp_path: Path, tsa_pki: TsaPki) -> None:
    signer = pem_signer(tmp_path, tsa_pki.ec, key_password=KEY_PASSWORD)
    wrong = {**signer.model_dump(mode="python"), "key_password": None}
    datum = plain_tsa_datum(tsa_config(allow_memory_stores=True, signer=wrong))
    with pytest.raises(DatumConfigurationError) as raised:
        datum.start()
    text = str(raised.value) + raised.value.hint
    assert not leaks(text, secrets_of(tsa_pki.ec, KEY_PASSWORD))
    assert "datum.tsa.signer" in text


def test_with_neither_a_signer_nor_self_signed_nor_a_key_seam_the_start_is_refused() -> None:
    datum = plain_tsa_datum(tsa_config(allow_memory_stores=True))
    with pytest.raises(DatumConfigurationError, match=r"datum\.tsa\.signer"):
        datum.start()
    assert not datum.started


def test_self_signed_makes_a_throwaway_key_and_warns_that_it_is_for_development(
    caplog: pytest.LogCaptureFixture,
) -> None:
    datum = plain_tsa_datum(tsa_config(allow_memory_stores=True, signer={"self_signed": True}))
    with caplog.at_level(logging.WARNING):
        datum.start()
    try:
        warned = [r.getMessage() for r in caplog.records if r.name in {CHECKS, TSA} and r.levelno >= logging.WARNING]
        assert any("development" in line.lower() and "self_signed" in line for line in warned), warned
        authority = datum.timestamp_authority
        assert authority is not None
        assert len(authority.certificate_chain_der) == 1
        assert authority.issue(query_of()).token
    finally:
        datum.stop()


@pytest.mark.parametrize(
    ("changes", "setting"),
    [
        ({"policy": None}, "datum.tsa.policy"),
        ({"policy": "1.3." + ".".join(["9" * 5] * 11)}, "datum.tsa.policy"),
        ({"policy": "1.3." + ".".join(["6"] * 16)}, "datum.tsa.policy"),
        ({"accepted_policies": ["1.3." + ".".join(["6"] * 16)]}, "datum.tsa.accepted_policies"),
    ],
    ids=["unset", "too-many-characters", "too-many-arcs", "accepted-too-many-arcs"],
)
def test_an_issuing_policy_that_is_unset_or_past_the_oid_caps_stops_the_start(
    tsa_pki: TsaPki, changes: dict[str, Any], setting: str
) -> None:
    tsa: dict[str, Any] = {"accepted_policies": [], **changes}
    datum = plain_tsa_datum(
        tsa_config(**tsa),
        tsa_key_material=IdentityKey(tsa_pki.ec),
        tsa_serial_allocator=CountingSerials(),
        tsa_log=ListLog(),
    )
    with pytest.raises(DatumConfigurationError, match=setting.replace(".", r"\.")):
        datum.start()


# -- health ------------------------------------------------------------------------------------------------------------
def refuse_for_time(rig: Any) -> None:
    """Make a token read the (broken) time source once: health reports that last reading and never makes its own."""
    with pytest.raises(TimestampRefusedError) as raised:
        rig.issue()
    assert raised.value.failure == "timeNotAvailable"


def test_the_tsa_component_is_up_with_serials_time_and_flood_details(tsa_pki: TsaPki) -> None:
    with started_tsa(tsa_pki.ec) as rig:
        rig.issue()
        component = rig.datum.health().components["tsa"]
    assert component.status == "up"
    assert component.details["serials"] == "custom"
    assert component.details["time"] == "available"
    assert component.details["flood"] == "memory (per process)"


def test_the_tsa_component_names_each_store_when_the_allocator_and_the_log_differ(tsa_pki: TsaPki) -> None:
    with started_tsa(tsa_pki.ec, tsa_log=MemoryTsaLog()) as rig:
        component = rig.datum.health().components["tsa"]
    assert component.details["serials"] == "allocator: custom, log: memory (acknowledged)"


def test_the_tsa_component_goes_down_naming_why_when_the_time_source_is_unavailable(tsa_pki: TsaPki) -> None:
    with started_tsa(tsa_pki.ec) as rig:
        rig.clock.reason = "The clock is not synchronised."
        refuse_for_time(rig)
        report = rig.datum.health()
    component = report.components["tsa"]
    assert component.status == "down"
    assert component.details["time"] == "unavailable (The clock is not synchronised.)"
    assert "reason" in component.details


def test_a_down_tsa_never_fails_readiness(tsa_pki: TsaPki) -> None:
    with started_tsa(tsa_pki.ec) as rig:
        rig.clock.reason = "down"
        refuse_for_time(rig)
        report = rig.datum.health()
        assert report.components["tsa"].status == "down"
        assert report.components["runtime"].status == "up"
        assert report.is_ready


def test_a_raising_time_source_makes_the_component_down_without_its_message(tsa_pki: TsaPki) -> None:
    with started_tsa(tsa_pki.ec) as rig:
        rig.clock.error = ConnectionError("cannot reach ntp.internal.example")
        refuse_for_time(rig)
        text = json.dumps(rig.datum.health().to_json())
    assert "ntp.internal.example" not in text
    assert '"tsa"' in text


def test_the_health_body_names_no_path_subject_password_or_key_id(tmp_path: Path, tsa_pki: TsaPki) -> None:
    signer = pkcs12_signer(tmp_path, tsa_pki.ec)
    datum = plain_tsa_datum(
        tsa_config(allow_memory_stores=True, signer=signer.model_dump(mode="python")),
    )
    datum.start()
    try:
        text = json.dumps(datum.health().to_json()) + json.dumps(datum.info())
    finally:
        datum.stop()
    key_id = tsa_pki.ec.leaf.extensions.get_extension_for_class(x509.SubjectKeyIdentifier).value.digest.hex()
    forbidden = [str(tmp_path), "tsa.p12", P12_PASSWORD, "Test EC TSA", "datum-tsa", key_id, *secrets_of(tsa_pki.ec)]
    assert not leaks(text, forbidden)


def test_the_component_is_registered_once_per_datum(tsa_pki: TsaPki) -> None:
    with started_tsa(tsa_pki.ec) as rig:
        assert list(rig.datum.health().components).count("tsa") == 1
        rig.datum.recheck()
        assert list(rig.datum.health().components).count("tsa") == 1


# -- info --------------------------------------------------------------------------------------------------------------
def test_info_names_the_tsa_capability_with_its_access_and_counts(tsa_pki: TsaPki) -> None:
    seen = [lambda draft: None]
    with started_tsa(tsa_pki.ec, timestamp_request_customizers=seen) as rig:
        tsa = capabilities_of(rig.datum)["tsa"]
    assert tsa["enabled"] is True
    assert tsa["access"] == "open"
    assert tsa["customizers"] == 1
    assert tsa["serials"] == "custom"


def test_info_says_the_tsa_is_off_when_it_is() -> None:
    datum = plain_tsa_datum(tsa_config(enabled=False))
    datum.start()
    try:
        assert capabilities_of(datum)["tsa"]["enabled"] is False
    finally:
        datum.stop()


# -- health never calls the time source --------------------------------------------------------------------------------
def test_before_the_first_token_the_time_reads_not_read_yet_and_health_makes_no_read(tsa_pki: TsaPki) -> None:
    with started_tsa(tsa_pki.ec) as rig:
        component = rig.datum.health().components["tsa"]
        assert (component.status, component.details["time"]) == ("up", "not read yet")
        assert rig.clock.reads == 0
        rig.issue()
        reads = rig.clock.reads
        assert rig.datum.health().components["tsa"].details["time"] == "available"
        assert rig.clock.reads == reads


def test_health_never_calls_the_time_source_on_the_calling_thread(tsa_pki: TsaPki) -> None:
    threads: list[int] = []

    class Spy(Clock):
        def read(self) -> Reading:
            threads.append(threading.get_ident())
            return super().read()

    with started_tsa(tsa_pki.ec, tsa_time_source=Spy()) as rig:
        rig.issue()
        threads.clear()
        rig.datum.health()
        rig.datum.recheck()
        assert threads == []


class AsyncClock:
    def __init__(self) -> None:
        self.reads = 0

    async def read(self) -> Reading:
        self.reads += 1
        return Reading.available(INSTANT)


@pytest.mark.anyio
async def test_an_async_time_source_reads_up_from_health_called_on_the_loop(
    tsa_pki: TsaPki, caplog: pytest.LogCaptureFixture
) -> None:
    clock = AsyncClock()
    with warnings.catch_warnings():
        warnings.simplefilter("error", RuntimeWarning)
        with started_tsa(tsa_pki.ec, tsa_time_source=clock, awaiter=anyio_awaiter) as rig:
            with caplog.at_level(logging.WARNING):
                assert rig.datum.health().components["tsa"].status == "up"  # on the loop, before any token
                await anyio.to_thread.run_sync(rig.issue)
                component = rig.datum.health().components["tsa"]
            assert (component.status, component.details["time"]) == ("up", "available")
            assert clock.reads == 1  # the token's read only
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


def test_a_slow_time_source_cannot_slow_health(tsa_pki: TsaPki) -> None:
    class Slow(Clock):
        def read(self) -> Reading:
            time.sleep(5)
            return super().read()

    with started_tsa(tsa_pki.ec, tsa_time_source=Slow()) as rig:
        began = time.monotonic()
        rig.datum.health()
        assert time.monotonic() - began < 0.5


@pytest.mark.parametrize(
    ("source", "reason"),
    [
        (lambda: "noon", "the time source answered something that is not a reading"),
        (lambda: Reading(datetime(2026, 1, 1)), "the time source answered an instant without a zone"),
        (lambda: Reading.unavailable("The clock is not synchronised."), "The clock is not synchronised."),
    ],
    ids=["not-a-reading", "naive-instant", "reason"],
)
def test_the_last_reading_decides_the_texts_health_reports(tsa_pki: TsaPki, source: Any, reason: str) -> None:
    class Odd:
        def read(self) -> Any:
            return source()

    with started_tsa(tsa_pki.ec, tsa_time_source=Odd()) as rig:
        refuse_for_time(rig)
        component = rig.datum.health().components["tsa"]
        assert component.status == "down"
        assert component.details["time"] == f"unavailable ({reason})"
        assert rig.authority.last_time_problem == reason


def test_a_raising_source_reads_the_time_source_failed_and_the_next_good_read_clears_it(tsa_pki: TsaPki) -> None:
    with started_tsa(tsa_pki.ec) as rig:
        rig.clock.error = ConnectionError("cannot reach ntp.internal.example")
        refuse_for_time(rig)
        assert rig.datum.health().components["tsa"].details["time"] == "unavailable (the time source failed)"
        rig.clock.error = None
        rig.issue()
        assert rig.datum.health().components["tsa"].details["time"] == "available"


# -- the order and the settings that reach the authority ---------------------------------------------------------------
def test_customizers_given_to_datum_run_in_the_order_given(tsa_pki: TsaPki) -> None:
    order: list[str] = []

    def first(draft: TimestampRequestDraft) -> TimestampRequestDraft:
        order.append("first")
        return draft.with_accuracy(5)

    def second(draft: TimestampRequestDraft) -> TimestampRequestDraft:
        order.append("second")
        return draft.with_accuracy(draft.accuracy + 1)

    with started_tsa(tsa_pki.ec, timestamp_request_customizers=[every_channel(first), every_channel(second)]) as rig:
        grant = rig.issue()
    assert order == ["first", "second"]
    accuracy = token_parts(grant.token).tst.accuracy
    assert accuracy is not None
    assert accuracy[0] == 6


def test_the_tsa_settings_and_the_datums_clock_reach_the_authority(tmp_path: Path, tsa_pki: TsaPki) -> None:
    retired = tmp_path / "retired.pem"
    retired.write_bytes(tsa_pki.rsa.leaf.public_bytes(serialization.Encoding.PEM))
    datum = plain_tsa_datum(
        tsa_config(
            accuracy="PT3S",
            accepted_policies=[OTHER_POLICY],
            retired_certificates=[str(retired)],
        ),
        tsa_key_material=IdentityKey(tsa_pki.ec),
        tsa_serial_allocator=CountingSerials(),
        tsa_log=ListLog(),
    )
    datum.start()
    try:
        authority = datum.timestamp_authority
        assert authority is not None
        assert authority.accepted_policies == (POLICY, OTHER_POLICY)
        grant = authority.issue(query_of(policy=OTHER_POLICY))
        parts = token_parts(grant.token).tst
        assert parts.accuracy == (3, None, None)
        assert authority.retired_certificates_der == (tsa_pki.rsa.leaf.public_bytes(serialization.Encoding.DER),)
        assert grant.gen_time == fixed_now()
    finally:
        datum.stop()


# -- start refusals ----------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("named", ["pkcs12_file", "key_file", "cert_file"])
def test_self_signed_with_a_key_file_named_is_refused(named: str) -> None:
    datum = plain_tsa_datum(
        tsa_config(allow_memory_stores=True, signer={"self_signed": True, named: "/etc/never-read.pem"})
    )
    with pytest.raises(DatumConfigurationError, match=r"self_signed") as raised:
        datum.start()
    assert "datum.tsa.signer" in str(raised.value)
    assert not datum.started


def test_the_sql_client_store_with_client_access_needs_a_client_store_seam(tsa_pki: TsaPki) -> None:
    datum = plain_tsa_datum(
        tsa_config(access="clients", client_store="sql"),
        tsa_key_material=IdentityKey(tsa_pki.ec),
        tsa_serial_allocator=CountingSerials(),
        tsa_log=ListLog(),
    )
    with pytest.raises(DatumConfigurationError, match=r"datum\.tsa\.client_store"):
        datum.start()
    assert not datum.started


def test_the_sql_client_store_with_open_access_goes_on(tsa_pki: TsaPki) -> None:
    datum = plain_tsa_datum(
        tsa_config(access="open", client_store="sql"),
        tsa_key_material=IdentityKey(tsa_pki.ec),
        tsa_serial_allocator=CountingSerials(),
        tsa_log=ListLog(),
    )
    datum.start()
    try:
        assert datum.started
    finally:
        datum.stop()


def test_an_authority_that_cannot_be_built_is_a_configuration_error_not_a_value_error(tsa_pki: TsaPki) -> None:
    class Negative(IdentityKey):
        @property
        def chain_der(self) -> tuple[bytes, ...]:
            return (b"\x30\x03\x02\x01\x01",)  # not a certificate the authority can build its fixed parts from

    datum = plain_tsa_datum(
        tsa_config(),
        tsa_key_material=Negative(tsa_pki.ec),
        tsa_serial_allocator=CountingSerials(),
        tsa_log=ListLog(),
    )
    with pytest.raises(DatumConfigurationError, match=r"datum\.tsa cannot be set up"):
        datum.start()
    assert not datum.started


def test_a_disabled_datum_builds_no_tsa_even_when_the_tsa_section_is_on() -> None:
    datum = plain_tsa_datum(tsa_config({"enabled": False}, allow_memory_stores=False))
    datum.start()  # no E001: the defaults are memory stores and the flag is off
    try:
        assert datum.timestamp_authority is None
        assert "tsa" not in datum.health().components
        assert capabilities_of(datum)["tsa"] == {"enabled": False}
    finally:
        datum.stop()


# -- the timestamp extra -----------------------------------------------------------------------------------------------
_NO_EXTRA = """
import sys
sys.modules[{blocked!r}] = None
from datum_sandbox.checks import DatumConfigurationError
from datum_core import Datum, DatumConfig
config = lambda on: DatumConfig.model_validate(
    {{"tsa": {{"enabled": on, "policy": "1.3.6.1.4.1.99999.1", "allow_memory_stores": True,
              "signer": {{"self_signed": True}}}}}}
)
off = Datum(config=config(False))
off.start()
assert off.timestamp_authority is None
off.stop()
try:
    Datum(config=config(True)).start()
except DatumConfigurationError as error:
    print(type(error).__name__, "|", error, "|", error.hint)
else:
    print("started")
"""


@pytest.mark.parametrize("blocked", ["asn1crypto", "cryptography"])
def test_a_missing_timestamp_extra_is_a_configuration_error_naming_the_extra(blocked: str) -> None:
    done = subprocess.run(  # noqa: S603
        [sys.executable, "-I", "-c", _NO_EXTRA.format(blocked=blocked)],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert done.returncode == 0, done.stderr
    kind, message, hint = (part.strip() for part in done.stdout.strip().split("|", 2))
    assert kind == "DatumConfigurationError"
    assert f"({blocked} is missing)" in message
    assert "argusvane-datum-core[timestamp]" in hint


# -- the stop gate for a call already in flight ------------------------------------------------------------------------
class BlockingClock(Clock):
    def __init__(self) -> None:
        super().__init__()
        self.entered = threading.Event()
        self.release = threading.Event()

    def read(self) -> Reading:
        self.entered.set()
        assert self.release.wait(30)
        return super().read()


def _stop_while_held(rig: Any, entered: threading.Event, release: threading.Event) -> TimestampRefusedError:
    caught: list[TimestampRefusedError] = []

    def run() -> None:
        try:
            rig.authority.issue(query_of())
        except TimestampRefusedError as error:
            caught.append(error)

    worker = threading.Thread(target=run)
    worker.start()
    assert entered.wait(30)
    rig.datum.stop()  # the call is held; the serial rule says nothing is allocated after this
    release.set()
    worker.join(30)
    assert len(caught) == 1
    return caught[0]


@pytest.mark.parametrize("held", ["customizer", "time-source"])
def test_a_call_in_flight_when_datum_stops_takes_no_serial_signs_nothing_and_logs_nothing(
    tsa_pki: TsaPki, held: str
) -> None:
    entered, release = threading.Event(), threading.Event()

    def hold(draft: TimestampRequestDraft) -> None:
        entered.set()
        assert release.wait(30)

    clock = BlockingClock()
    if held == "customizer":
        seams: dict[str, Any] = {"timestamp_request_customizers": [every_channel(hold)]}
    else:
        seams = {"tsa_time_source": clock}
        entered, release = clock.entered, clock.release
    with started_tsa(tsa_pki.ec, **seams) as rig:
        error = _stop_while_held(rig, entered, release)
    assert error.failure == "systemFailure"
    assert rig.serials.allocations == 0
    assert rig.key.signs == 0
    assert rig.log.entries == []
    assert rig.events == []


def test_info_says_memory_before_a_start_the_flag_has_not_acknowledged() -> None:
    datum = plain_tsa_datum(tsa_config(allow_memory_stores=False))
    assert capabilities_of(datum)["tsa"]["serials"] == "memory"


@pytest.mark.parametrize(
    ("flag", "seams", "word"),
    [
        pytest.param(False, {}, "memory", id="both-memory-unacknowledged"),
        pytest.param(True, {}, "memory (acknowledged)", id="both-memory-acknowledged"),
        pytest.param(
            True,
            {"tsa_serial_allocator": CountingSerials()},
            "allocator: custom, log: memory (acknowledged)",
            id="custom-allocator",
        ),
        pytest.param(
            False,
            {"tsa_serial_allocator": CountingSerials()},
            "allocator: custom, log: memory",
            id="custom-allocator-unacknowledged",
        ),
        pytest.param(
            True,
            {"tsa_log": ListLog()},
            "allocator: memory (acknowledged), log: custom",
            id="custom-log",
        ),
        pytest.param(
            False,
            {"tsa_serial_allocator": CountingSerials(), "tsa_log": ListLog()},
            "custom",
            id="both-custom",
        ),
    ],
)
def test_the_serials_word_names_each_store_of_a_mixed_pair_and_the_acknowledgement(
    flag: bool, seams: dict[str, Any], word: str
) -> None:
    """Red against a fixed word (`custom`, or `memory (acknowledged)` whatever the flag): the mutant."""
    datum = plain_tsa_datum(tsa_config(allow_memory_stores=flag), **seams)
    assert capabilities_of(datum)["tsa"]["serials"] == word

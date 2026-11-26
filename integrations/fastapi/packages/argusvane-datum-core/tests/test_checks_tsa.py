"""`datum.E001` for the timestamp server's trust-state stores and `datum.W009` once the flag acknowledges them.

The serial allocator and the issue log decide whether a serial can be reused (RFC 3161 section 2.4.2), so an in-memory
one stops the start unless `datum.tsa.allow_memory_stores=true`. The refusal text has three parts: the store, the
consequence and the three ways out. With the flag the start logs one `datum.W009` and the health detail reads
`memory (acknowledged)`. The client store over settings is not a memory store; a store the application supplies is
`custom`. Nothing is checked while the TSA is off.
"""

import logging
from pathlib import Path
from typing import Any

import pytest
from tsa_support import (
    Clock,
    CountingSerials,
    IdentityKey,
    ListLog,
    plain_tsa_datum,
    tsa_config,
)

from datum_core.checks import E001, W009
from datum_core.loggers import CHECKS
from datum_core.stores.memory import MemoryTsaLog, MemoryTsaSerialAllocator
from datum_core.testing.tsa_pki import TsaPki
from datum_sandbox.checks import CheckLevel, DatumConfigurationError


def datum_with(tsa_pki: TsaPki, *, flag: bool = False, **seams: Any) -> Any:
    seams.setdefault("tsa_key_material", IdentityKey(tsa_pki.ec))
    seams.setdefault("tsa_time_source", Clock())
    return plain_tsa_datum(tsa_config(allow_memory_stores=flag), **seams)


def refusal_of(datum: Any) -> DatumConfigurationError:
    with pytest.raises(DatumConfigurationError) as raised:
        datum.start()
    assert not datum.started
    return raised.value


# -- E001: one refusal per memory store --------------------------------------------------------------------------------
def test_the_default_stores_are_memory_stores_and_the_start_is_refused_with_one_e001_each(tsa_pki: TsaPki) -> None:
    error = refusal_of(datum_with(tsa_pki))
    assert [problem.id for problem in error.problems] == [E001, E001]
    assert all(problem.level is CheckLevel.ERROR for problem in error.problems)
    assert any("serial allocator" in problem.msg for problem in error.problems)
    assert any("its issue log" in problem.msg for problem in error.problems)


def test_a_memory_serial_allocator_alone_is_refused_with_the_sql_store_text(tsa_pki: TsaPki) -> None:
    error = refusal_of(datum_with(tsa_pki, tsa_log=ListLog(), tsa_serial_allocator=MemoryTsaSerialAllocator()))
    (problem,) = error.problems
    assert problem.id == E001
    text = f"{problem.msg} {problem.hint}"
    # the store
    assert "datum.tsa has no SQL store for its serial allocator (datum_tsa_log)" in text
    # the consequence
    assert "seeded from the clock" in text
    assert "unique only within this process" in text
    assert "RFC 3161 section 2.4.2" in text
    # the three ways out
    assert "create the datum_tsa_log table" in text
    assert "with your migration" in text
    assert "provide your own TsaSerialAllocator" in text
    assert "datum.tsa.allow_memory_stores=true" in text
    assert "a single instance" in text


def test_a_memory_log_alone_is_refused_naming_the_log(tsa_pki: TsaPki) -> None:
    error = refusal_of(datum_with(tsa_pki, tsa_serial_allocator=CountingSerials(), tsa_log=MemoryTsaLog()))
    (problem,) = error.problems
    assert problem.id == E001
    text = f"{problem.msg} {problem.hint}"
    assert "log" in problem.msg
    assert "serial allocator" not in problem.msg
    assert "provide your own TsaLog" in text
    assert "datum.tsa.allow_memory_stores=true" in text


def test_stores_the_application_supplies_pass_the_check(tsa_pki: TsaPki) -> None:
    datum = datum_with(tsa_pki, tsa_serial_allocator=CountingSerials(), tsa_log=ListLog())
    datum.start()
    try:
        assert datum.started
    finally:
        datum.stop()


def test_the_refusal_comes_before_the_key_is_asked_for_anything(tsa_pki: TsaPki) -> None:
    key = IdentityKey(tsa_pki.ec)
    refusal_of(datum_with(tsa_pki, tsa_key_material=key))
    assert key.signs == 0


def test_the_refusal_comes_before_a_missing_key_file_is_read(tmp_path: Path) -> None:
    signer = {"type": "PKCS12", "pkcs12_file": str(tmp_path / "missing.p12"), "pkcs12_password": "never-shown"}
    error = refusal_of(plain_tsa_datum(tsa_config(allow_memory_stores=False, signer=signer)))
    assert [problem.id for problem in error.problems] == [E001, E001]
    assert "missing.p12" not in error.message
    assert "never-shown" not in error.message


def test_with_the_flag_the_missing_key_file_is_what_stops_the_start(tmp_path: Path) -> None:
    signer = {"type": "PKCS12", "pkcs12_file": str(tmp_path / "missing.p12")}
    error = refusal_of(plain_tsa_datum(tsa_config(allow_memory_stores=True, signer=signer)))
    assert error.problems == ()
    assert "datum.tsa.signer.pkcs12_file" in error.message


def test_the_refusal_cannot_be_silenced() -> None:
    with pytest.raises(ValueError, match="only INFO and WARNING"):
        plain_tsa_datum(tsa_config({"silenced_checks": [E001]}))


# -- W009 --------------------------------------------------------------------------------------------------------------
def test_with_the_flag_the_start_goes_on_with_one_w009_naming_each_memory_store(
    tsa_pki: TsaPki, caplog: pytest.LogCaptureFixture
) -> None:
    datum = datum_with(tsa_pki, flag=True)
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        datum.start()
    try:
        warnings = [r for r in caplog.records if getattr(r, "datum_check_id", None) == W009 and r.msg != "HINT: %s"]
        assert len(warnings) == 2
        messages = [record.getMessage() for record in warnings]
        assert sum("its serial allocator" in message for message in messages) == 1
        assert sum("its issue log" in message for message in messages) == 1
        assert all("datum.tsa.allow_memory_stores=true" in message for message in messages)
        assert E001 not in {getattr(r, "datum_check_id", None) for r in caplog.records}
    finally:
        datum.stop()


def test_with_the_flag_and_a_custom_allocator_there_is_one_w009_naming_the_log(
    tsa_pki: TsaPki, caplog: pytest.LogCaptureFixture
) -> None:
    datum = datum_with(tsa_pki, flag=True, tsa_serial_allocator=CountingSerials())
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        datum.start()
    try:
        warnings = [r for r in caplog.records if getattr(r, "datum_check_id", None) == W009 and r.msg != "HINT: %s"]
        assert len(warnings) == 1
        assert "its issue log" in warnings[0].getMessage()
        assert "serial allocator" not in warnings[0].getMessage()
    finally:
        datum.stop()


def test_w009_can_be_silenced_by_id(tsa_pki: TsaPki, caplog: pytest.LogCaptureFixture) -> None:
    datum = plain_tsa_datum(
        tsa_config({"silenced_checks": [W009]}, allow_memory_stores=True),
        tsa_key_material=IdentityKey(tsa_pki.ec),
    )
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        datum.start()
    try:
        assert W009 not in {getattr(r, "datum_check_id", None) for r in caplog.records}
    finally:
        datum.stop()


def test_a_supplied_store_with_the_flag_set_says_no_w009(tsa_pki: TsaPki, caplog: pytest.LogCaptureFixture) -> None:
    datum = datum_with(tsa_pki, flag=True, tsa_serial_allocator=CountingSerials(), tsa_log=ListLog())
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        datum.start()
    try:
        assert W009 not in {getattr(r, "datum_check_id", None) for r in caplog.records}
    finally:
        datum.stop()


def test_the_health_detail_says_memory_acknowledged_with_the_flag_and_custom_for_a_supplied_store(
    tsa_pki: TsaPki,
) -> None:
    acknowledged = datum_with(tsa_pki, flag=True)
    acknowledged.start()
    try:
        assert acknowledged.health().components["tsa"].details["serials"] == "memory (acknowledged)"
    finally:
        acknowledged.stop()
    supplied = datum_with(tsa_pki, tsa_serial_allocator=CountingSerials(), tsa_log=ListLog())
    supplied.start()
    try:
        assert supplied.health().components["tsa"].details["serials"] == "custom"
    finally:
        supplied.stop()


# -- what is not checked -----------------------------------------------------------------------------------------------
def test_nothing_is_checked_while_the_tsa_is_off() -> None:
    datum = plain_tsa_datum(tsa_config(enabled=False))
    datum.start()
    try:
        assert datum.started
    finally:
        datum.stop()


def test_the_settings_client_store_is_not_a_memory_store(tsa_pki: TsaPki, caplog: pytest.LogCaptureFixture) -> None:
    datum = datum_with(tsa_pki, tsa_serial_allocator=CountingSerials(), tsa_log=ListLog())
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        datum.start()
    try:
        assert not [r for r in caplog.records if getattr(r, "datum_check_id", None) in {E001, W009}]
    finally:
        datum.stop()

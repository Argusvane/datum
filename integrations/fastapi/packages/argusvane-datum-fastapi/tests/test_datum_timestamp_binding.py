"""The binding's `Datum.async_timestamps`: off is a configuration error, the lifespan gates it, on it answers."""

import logging

import pytest
from tsa_fakes import config, make_datum, parse_reply, query_der

from datum_core import DatumNotStartedError
from datum_core.testing.tsa_pki import TsaPki
from datum_sandbox.checks import DatumConfigurationError

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


async def test_async_timestamps_with_the_tsa_off_is_a_configuration_error(tsa_pki: TsaPki) -> None:
    datum, _ = make_datum(tsa_pki.ec, config(tsa={"enabled": False}))
    with pytest.raises(DatumNotStartedError):
        _ = datum.async_timestamps
    async with datum:
        with pytest.raises(DatumConfigurationError, match="timestamp server is off"):
            _ = datum.async_timestamps


async def test_async_timestamps_exists_only_inside_the_lifespan(tsa_pki: TsaPki) -> None:
    datum, _ = make_datum(tsa_pki.ec)
    with pytest.raises(DatumNotStartedError):
        _ = datum.async_timestamps
    async with datum:
        assert datum.async_timestamps.service is datum.timestamp_authority
    with pytest.raises(DatumNotStartedError):
        _ = datum.async_timestamps


async def test_inside_the_lifespan_with_self_signed_it_answers_a_query(
    tsa_pki: TsaPki, caplog: pytest.LogCaptureFixture
) -> None:
    datum, parts = make_datum(tsa_pki.ec, config(tsa={"signer": {"self_signed": True}}), tsa_key_material=None)
    with caplog.at_level(logging.WARNING):
        async with datum:
            answer = await datum.async_timestamps.answer(query_der())
    assert answer.refusal is None
    assert answer.grant is not None
    assert parse_reply(answer.response).status == 0
    assert [type(event).__name__ for event in parts.events] == ["TimestampIssuedEvent"]

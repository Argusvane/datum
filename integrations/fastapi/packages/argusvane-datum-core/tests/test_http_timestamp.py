"""`datum_core.http.timestamp`: the admission order, the plain-text twins and the answers.

The order is contract and each step has a test: a session cookie (403) > the media type (415) > the client key (429 for
a lockout, else 401 with `WWW-Authenticate`) > the flood rule (429 with `Retry-After`) > the size (413) > the service.
The refusals before the service are plain text (the JSON `bad_document` twins in `admission` are not used); a rejection
that comes from the service is a DER `TimeStampResp` (400, or 503 with `Retry-After`). A reply is
`application/timestamp-reply`, `Cache-Control: no-store`, with no `ETag`. The certificates answer in PEM, or DER for the
leaf alone.
"""

import re
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

import pytest
from tsa_support import CLIENT_KEY, key_hash
from tsa_support import refused as hook_refusal

from datum_core.config.models import Tsa
from datum_core.http.admission import Refused
from datum_core.http.answer import HttpAnswer
from datum_core.http.timestamp import (
    REPLY_MEDIA_TYPE,
    Admitted,
    TimestampGate,
    certificate_answer,
    certificates_answer,
    granted_answer,
    refusal_answer,
)
from datum_core.stores.memory import InMemoryTsaFlood
from datum_core.stores.tsa import SettingsTsaClientStore, TsaClientRecord
from datum_core.timestamp import TimestampGrant, TimestampRefusal

QUERY = "application/timestamp-query"
REQUEST = "application/timestamp-request"
BASIC_CHALLENGE = 'Bearer realm="timestamp server", Basic realm="timestamp server"'
ADDRESS = "203.0.113.7"
NOW = datetime(2026, 10, 20, 12, 0, tzinfo=UTC)


class Seconds:
    """The flood clock, driven by the test."""

    def __init__(self) -> None:
        self.at = 1000.0

    def __call__(self) -> float:
        return self.at


class RecordingClients(SettingsTsaClientStore):
    """The settings store, noting what it was asked and told."""

    def __init__(self, hashes: list[str], revoked: list[str] | None = None) -> None:
        super().__init__(hashes, revoked=revoked or [])
        self.asked: list[str] = []
        self.uses: list[str] = []

    def find(self, key_hash: str) -> TsaClientRecord | None:
        self.asked.append(key_hash)
        return super().find(key_hash)

    def record_use(self, client_id: str, at: datetime) -> None:
        self.uses.append(client_id)
        super().record_use(client_id, at)


class Rig:
    def __init__(self, *, revoked: bool = False, **tsa: Any) -> None:
        settings: dict[str, Any] = {"enabled": True, "access": "open", "clients": [key_hash(CLIENT_KEY)]}
        settings.update(tsa)
        self.tsa = Tsa.model_validate(settings)
        self.clients = RecordingClients(list(self.tsa.clients), list(self.tsa.clients) if revoked else None)
        self.flood = InMemoryTsaFlood()
        self.seconds = Seconds()
        self.gate = TimestampGate(self.tsa, clients=self.clients, flood=self.flood, clock=self.seconds, now=lambda: NOW)

    def admit(
        self, headers: Mapping[str, str] | None = None, *, address: str | None = ADDRESS, **more: str
    ) -> Admitted | Refused:
        sent = {"Content-Type": QUERY, "Content-Length": "60", **(headers or {}), **more}
        return self.gate.admit(sent, remote_address=address)


def refused(result: Admitted | Refused) -> HttpAnswer:
    assert isinstance(result, Refused), result
    return result.answer


def bearer(key: str = CLIENT_KEY) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}"}


def text_of(answer: HttpAnswer) -> str:
    return answer.body.decode("ascii")


def header(answer: HttpAnswer, name: str) -> str | None:
    found = {key.lower(): value for key, value in answer.headers.items()}
    return found.get(name.lower())


def is_plain_text(answer: HttpAnswer) -> bool:
    media = (header(answer, "content-type") or "").partition(";")[0].strip().lower()
    return media == "text/plain" and bool(answer.body) and answer.body.isascii()


# -- step 1: a session cookie, 403 -------------------------------------------------------------------------------------
def test_a_session_cookie_is_403_by_default_before_anything_else() -> None:
    rig = Rig(access="clients")
    answer = refused(rig.admit({"Cookie": "theme=dark; session=1", "Content-Type": "application/octet-stream"}))
    assert answer.status == 403
    assert is_plain_text(answer)
    assert rig.clients.asked == [], "the key was never looked at"
    assert rig.flood.size == 0


def test_the_default_refuses_any_cookie() -> None:
    for cookie in ("theme=dark", "a=b", "JSESSIONID=1", "x=1; y=2"):
        assert refused(Rig().admit({"Cookie": cookie})).status == 403


def test_a_named_list_matches_names_whatever_the_case() -> None:
    rig = Rig(session_cookies=["JSESSIONID", "SESSION"])
    for cookie in ("jsessionid=1", "SESSION=1", "Session=1"):
        assert refused(rig.admit({"Cookie": cookie})).status == 403
    assert isinstance(rig.admit({"Cookie": "theme=dark"}), Admitted)


def test_a_star_refuses_any_cookie() -> None:
    assert refused(Rig(session_cookies=["*"]).admit({"Cookie": "theme=dark"})).status == 403


def test_the_kit_s_session_cookie_name_is_refused_with_the_default_and_with_a_named_list() -> None:
    for names in (None, ["JSESSIONID"]):
        extra: dict[str, Any] = {} if names is None else {"session_cookies": names}
        rig = Rig(**extra)
        assert refused(rig.admit({"Cookie": "JSESSIONID=datum-tck"})).status == 403


class TwoLines:
    """A Starlette-like header mapping that keeps every field line (HTTP/2 splits the Cookie header)."""

    def __init__(self, *pairs: tuple[str, str]) -> None:
        self.pairs = pairs

    def getlist(self, name: str) -> list[str]:
        return [value for key, value in self.pairs if key.lower() == name.lower()]

    def items(self) -> list[tuple[str, str]]:
        return list(self.pairs)

    def get(self, name: str, default: str | None = None) -> str | None:
        lines = self.getlist(name)
        return lines[0] if lines else default

    def __getitem__(self, name: str) -> str:
        lines = self.getlist(name)
        if not lines:
            raise KeyError(name)
        return lines[0]


@pytest.mark.parametrize("names", [["sid"], ["*"]])
def test_a_cookie_on_a_second_field_line_is_read_as_well(names: Any) -> None:
    rig = Rig(session_cookies=names)
    lines = TwoLines(("cookie", "a=1"), ("cookie", "sid=x"), ("content-type", QUERY), ("content-length", "60"))
    assert refused(rig.gate.admit(lines, remote_address=ADDRESS)).status == 403  # type: ignore[arg-type]


def test_a_named_list_refuses_only_those_cookies() -> None:
    rig = Rig(session_cookies=["session", "sid"])
    assert refused(rig.admit({"Cookie": "a=1; sid=x"})).status == 403
    assert refused(rig.admit({"Cookie": "session=1"})).status == 403
    assert isinstance(rig.admit({"Cookie": "theme=dark; lang=en"}), Admitted)


def test_a_request_with_no_cookie_header_passes_the_cookie_step() -> None:
    assert isinstance(Rig().admit(), Admitted)


def test_the_cookie_refusal_echoes_no_cookie_value() -> None:
    answer = refused(Rig().admit({"Cookie": "JSESSIONID=ZZ-SECRET-VALUE-ZZ"}))
    assert "ZZ-SECRET-VALUE-ZZ" not in text_of(answer)
    assert "JSESSIONID" not in text_of(answer)


# -- step 2: the media type, 415 ---------------------------------------------------------------------------------------
@pytest.mark.parametrize("media", [QUERY, REQUEST, "Application/Timestamp-Query", f"{QUERY}; charset=binary"])
def test_both_names_of_the_query_type_are_taken_with_any_case_and_parameters(media: str) -> None:
    assert isinstance(Rig().admit({"Content-Type": media}), Admitted)


@pytest.mark.parametrize(
    "media", ["application/octet-stream", "application/json", "text/plain", "application/timestamp-reply", ""]
)
def test_any_other_media_type_is_415_in_plain_text(media: str) -> None:
    answer = refused(Rig().admit({"Content-Type": media}))
    assert answer.status == 415
    assert is_plain_text(answer)


def test_a_missing_content_type_is_415() -> None:
    answer = refused(Rig().gate.admit({"Content-Length": "5"}, remote_address=ADDRESS))
    assert answer.status == 415


def test_the_media_type_is_judged_before_the_client_key() -> None:
    rig = Rig(access="clients")
    assert refused(rig.admit({"Content-Type": "application/octet-stream"})).status == 415
    assert rig.clients.asked == []


# -- step 3: the client key --------------------------------------------------------------------------------------------
def test_under_open_access_no_key_is_needed_and_no_client_is_named() -> None:
    result = Rig(access="open").admit()
    assert isinstance(result, Admitted)
    assert result.client is None


def test_under_clients_access_no_key_is_401_with_the_challenge() -> None:
    answer = refused(Rig(access="clients").admit())
    assert answer.status == 401
    assert header(answer, "WWW-Authenticate") == BASIC_CHALLENGE
    assert is_plain_text(answer)


def test_a_bearer_key_the_store_knows_admits_the_client_by_the_stores_id() -> None:
    rig = Rig(access="clients")
    result = rig.admit(bearer())
    assert isinstance(result, Admitted)
    assert result.client
    assert CLIENT_KEY not in result.client
    assert key_hash(CLIENT_KEY) not in result.client
    assert rig.clients.uses == [result.client]


@pytest.mark.parametrize("scheme", ["bearer", "BEARER", "BeArEr"])
def test_the_bearer_scheme_is_case_insensitive(scheme: str) -> None:
    result = Rig(access="clients").admit({"Authorization": f"{scheme} {CLIENT_KEY}"})
    assert isinstance(result, Admitted)
    assert result.client


@pytest.mark.parametrize("scheme", ["basic", "BASIC"])
def test_the_basic_scheme_is_case_insensitive(scheme: str) -> None:
    import base64  # noqa: PLC0415

    token = base64.b64encode(f"anyone:{CLIENT_KEY}".encode()).decode()
    assert isinstance(Rig(access="clients").admit({"Authorization": f"{scheme} {token}"}), Admitted)


def test_a_request_presenting_no_key_does_not_count_toward_failed_keys_only_a_wrong_key_does() -> None:
    rig = Rig(access="clients", flood={"failed_keys": 2})
    for _ in range(5):
        assert refused(rig.admit({})).status == 401
        assert refused(rig.admit({"Authorization": "Token abc"})).status == 401
        assert refused(rig.admit({"Authorization": "Bearer"})).status == 401
    assert [refused(rig.admit(bearer(f"dtsa_w{n}"))).status for n in range(3)] == [401, 401, 429]


def test_a_basic_password_is_the_key_whatever_the_user() -> None:
    import base64  # noqa: PLC0415

    rig = Rig(access="clients")
    token = base64.b64encode(f"anyone:{CLIENT_KEY}".encode()).decode()
    result = rig.admit({"Authorization": f"Basic {token}"})
    assert isinstance(result, Admitted)
    assert result.client


def test_the_store_is_asked_for_the_sha256_of_the_whole_key_text_and_never_the_key() -> None:
    rig = Rig(access="clients")
    rig.admit(bearer())
    rig.admit(bearer("dtsa_wrong"))
    assert rig.clients.asked == [key_hash(CLIENT_KEY), key_hash("dtsa_wrong")]


@pytest.mark.parametrize(
    "authorization",
    [
        {"Authorization": "Bearer dtsa_wrong"},
        {"Authorization": f"Token {CLIENT_KEY}"},
        {"Authorization": "Bearer"},
        {"Authorization": "Basic !!!not-base64"},
        {"Authorization": f"bearer {CLIENT_KEY.lower()}"},
        {},
    ],
    ids=["wrong-key", "wrong-scheme", "no-token", "bad-basic", "lowercased-key", "none"],
)
def test_a_key_the_store_does_not_know_is_401_and_the_text_never_says_why(authorization: dict[str, str]) -> None:
    answers = [refused(Rig(access="clients").admit(authorization))]
    answers.append(refused(Rig(access="clients").admit({})))
    assert {a.status for a in answers} == {401}
    assert len({a.body for a in answers}) == 1, "one constant text: a wrong key never reveals whether a key exists"
    assert {header(a, "WWW-Authenticate") for a in answers} == {BASIC_CHALLENGE}


def test_a_revoked_client_is_refused_with_the_same_401_as_an_unknown_key() -> None:
    revoked = refused(Rig(access="clients", revoked=True).admit(bearer()))
    unknown = refused(Rig(access="clients").admit(bearer("dtsa_wrong")))
    assert revoked.status == unknown.status == 401
    assert revoked.body == unknown.body


def test_the_refusal_text_echoes_neither_the_key_nor_the_header() -> None:
    answer = refused(Rig(access="clients").admit(bearer("dtsa_ZZ-WRONG-KEY-ZZ")))
    assert "ZZ-WRONG-KEY-ZZ" not in text_of(answer)
    assert "Bearer" not in text_of(answer)


def test_ten_wrong_keys_from_one_address_are_401_and_the_eleventh_is_429_for_an_hour() -> None:
    rig = Rig(access="clients")
    statuses = [refused(rig.admit(bearer(f"dtsa_wrong{n}"))).status for n in range(10)]
    assert statuses == [401] * 10
    locked = refused(rig.admit(bearer("dtsa_wrong10")))
    assert locked.status == 429
    assert header(locked, "Retry-After") == "3600"
    assert is_plain_text(locked)


def test_the_lockout_does_not_lock_a_legitimate_key_out_and_is_per_address() -> None:
    rig = Rig(access="clients")
    for n in range(12):
        rig.admit(bearer(f"dtsa_wrong{n}"))
    assert isinstance(rig.admit(bearer()), Admitted)
    other = rig.admit(bearer("dtsa_wrong"), address="198.51.100.9")
    assert refused(other).status == 401


def test_the_failed_key_limit_is_the_setting() -> None:
    rig = Rig(access="clients", flood={"failed_keys": 2})
    assert [refused(rig.admit(bearer(f"dtsa_w{n}"))).status for n in range(3)] == [401, 401, 429]


def test_the_lockout_ends_with_its_window_and_retry_after_is_what_remains() -> None:
    rig = Rig(access="clients", flood={"failed_keys": 1, "window": 600})
    rig.admit(bearer("dtsa_w0"))
    locked = refused(rig.admit(bearer("dtsa_w1")))
    assert locked.status == 429
    assert header(locked, "Retry-After") == "600"
    rig.seconds.at += 100.5
    assert header(refused(rig.admit(bearer("dtsa_w2"))), "Retry-After") == "500"
    rig.seconds.at += 600
    assert refused(rig.admit(bearer("dtsa_w3"))).status == 401


# -- step 4: the flood rule --------------------------------------------------------------------------------------------
def test_the_flood_limit_counts_per_client_and_the_next_request_is_429_with_retry_after() -> None:
    rig = Rig(access="clients", flood={"limit": 3})
    assert all(isinstance(rig.admit(bearer()), Admitted) for _ in range(3))
    answer = refused(rig.admit(bearer()))
    assert answer.status == 429
    assert is_plain_text(answer)
    assert int(header(answer, "Retry-After") or "0") == 3600


def test_the_flood_limit_counts_per_address_under_open_access() -> None:
    rig = Rig(flood={"limit": 2})
    assert isinstance(rig.admit(), Admitted)
    assert isinstance(rig.admit(), Admitted)
    assert refused(rig.admit()).status == 429
    assert isinstance(rig.admit(address="198.51.100.9"), Admitted)


def test_a_limit_of_zero_turns_the_rule_off() -> None:
    rig = Rig(flood={"limit": 0})
    assert all(isinstance(rig.admit(), Admitted) for _ in range(50))


def test_retry_after_is_the_windows_remaining_whole_seconds_and_the_count_restarts_after_it() -> None:
    rig = Rig(flood={"limit": 1, "window": 100})
    rig.admit()
    rig.seconds.at += 40.2
    assert header(refused(rig.admit()), "Retry-After") == "60"
    rig.seconds.at += 60
    assert isinstance(rig.admit(), Admitted)


def test_flood_counts_only_admitted_requests() -> None:
    rig = Rig(access="clients", flood={"limit": 2})
    for _ in range(3):
        rig.admit({"Content-Type": "text/plain", **bearer()})  # 415
        rig.admit({"Cookie": "JSESSIONID=b", **bearer()})  # 403
        rig.admit({})  # 401
    assert isinstance(rig.admit(bearer()), Admitted)
    assert isinstance(rig.admit(bearer()), Admitted)
    assert refused(rig.admit(bearer())).status == 429


def test_the_flood_step_is_after_the_key_step() -> None:
    rig = Rig(access="clients", flood={"limit": 1})
    rig.admit(bearer())
    assert refused(rig.admit(bearer())).status == 429
    assert refused(rig.admit(bearer("dtsa_wrong"))).status == 401, "a wrong key is judged before the flood count"


# -- step 5: the size, 413 ---------------------------------------------------------------------------------------------
def test_a_declared_length_over_max_request_size_is_413_in_plain_text() -> None:
    rig = Rig(max_request_size=1024)
    answer = refused(rig.admit({"Content-Length": "1025"}))
    assert answer.status == 413
    assert is_plain_text(answer)
    assert isinstance(rig.admit({"Content-Length": "1024"}), Admitted)


def test_the_size_step_is_after_the_flood_step_so_an_oversized_request_is_counted() -> None:
    rig = Rig(max_request_size=10, flood={"limit": 1})
    assert refused(rig.admit({"Content-Length": "11"})).status == 413
    assert refused(rig.admit({"Content-Length": "11"})).status == 429


def test_the_retry_after_is_clamped_to_an_hour_whatever_the_window() -> None:
    rig = Rig(access="clients", flood={"window": 7200, "limit": 1, "failed_keys": 1})
    assert refused(rig.admit(bearer("dtsa_w0"))).status == 401
    locked = refused(rig.admit(bearer("dtsa_w1")))
    assert locked.status == 429
    assert header(locked, "Retry-After") == "3600"
    rig = Rig(flood={"window": 7200, "limit": 1})
    assert isinstance(rig.admit(), Admitted)
    assert header(refused(rig.admit()), "Retry-After") == "3600"


def test_a_chunked_body_over_the_cap_is_refused_by_the_gate_as_413() -> None:
    answer = Rig().gate.refuse_too_large().answer
    assert answer.status == 413
    assert is_plain_text(answer)
    assert header(answer, "Cache-Control") == "no-store"
    assert header(answer, "ETag") is None


def test_no_content_length_passes_this_step_the_body_counter_judges_it() -> None:
    assert isinstance(Rig().gate.admit({"Content-Type": QUERY}, remote_address=ADDRESS), Admitted)


# -- the order, all together -------------------------------------------------------------------------------------------
def test_with_every_fault_at_once_the_cookie_refusal_wins_then_each_step_in_turn() -> None:
    rig = Rig(access="clients", flood={"limit": 0}, max_request_size=10)
    everything = {"Cookie": "JSESSIONID=b", "Content-Type": "text/plain", "Content-Length": "999"}
    assert refused(rig.admit(everything)).status == 403
    del everything["Cookie"]
    assert refused(rig.admit(everything)).status == 415
    everything["Content-Type"] = QUERY
    assert refused(rig.admit(everything)).status == 401
    everything.update(bearer())
    assert refused(rig.admit(everything)).status == 413


@pytest.mark.parametrize("status", [401, 403, 413, 415, 429])
def test_every_refusal_is_plain_text_without_a_request_byte(status: int) -> None:
    secret = "ZZ-REQUEST-BYTE-ZZ"
    rig = Rig(access="clients", flood={"limit": 1}, max_request_size=10)
    cases = {
        403: {"Cookie": f"SESSION={secret}"},
        415: {"Content-Type": f"text/{secret}"},
        401: {"Authorization": f"Bearer dtsa_{secret}"},
        413: {**bearer(), "Content-Length": "11"},
    }
    if status == 429:
        rig.admit(bearer())
        answer = refused(rig.admit(bearer()))
    else:
        answer = refused(rig.admit(cases[status], address=f"192.0.2.{status % 200}"))
    assert answer.status == status
    assert is_plain_text(answer)
    assert secret not in text_of(answer)
    assert ADDRESS not in text_of(answer)
    assert header(answer, "Cache-Control") == "no-store"
    assert header(answer, "ETag") is None


# -- the answers -------------------------------------------------------------------------------------------------------
def grant(response: bytes = b"\x30\x03\x02\x01\x00") -> TimestampGrant:
    return TimestampGrant(response=response, token=b"\x30\x00", gen_time=NOW, serial=1)


def test_a_granted_reply_is_the_timestamp_reply_type_uncached_and_without_an_etag() -> None:
    answer = granted_answer(grant(b"REPLY-BYTES"))
    assert answer.status == 200
    assert answer.body == b"REPLY-BYTES"
    assert header(answer, "Content-Type") == REPLY_MEDIA_TYPE == "application/timestamp-reply"
    assert "no-store" in (header(answer, "Cache-Control") or "")
    assert header(answer, "ETag") is None
    assert header(answer, "Last-Modified") is None


@pytest.mark.parametrize(
    ("failure", "status"),
    [
        ("badAlg", 400),
        ("badRequest", 400),
        ("badDataFormat", 400),
        ("unacceptedPolicy", 400),
        ("unacceptedExtension", 400),
        ("timeNotAvailable", 503),
        ("systemFailure", 503),
    ],
)
def test_a_rejection_is_a_der_reply_with_the_status_of_its_failure(failure: str, status: int) -> None:
    refusal = TimestampRefusal.of(hook_refusal(failure))
    answer = refusal_answer(refusal, retry_after=7)
    assert answer.status == status
    assert answer.body == refusal.to_der()
    assert header(answer, "Content-Type") == REPLY_MEDIA_TYPE
    assert "no-store" in (header(answer, "Cache-Control") or "")
    assert header(answer, "ETag") is None
    if status == 503:
        assert header(answer, "Retry-After") == "7"
    else:
        assert header(answer, "Retry-After") is None


def pem_blocks(body: bytes) -> list[bytes]:
    import base64  # noqa: PLC0415

    found = re.findall(rb"-----BEGIN CERTIFICATE-----\s+(.*?)\s+-----END CERTIFICATE-----", body, re.DOTALL)
    return [base64.b64decode(block) for block in found]


CHAIN = (b"\x30\x03\x02\x01\x01", b"\x30\x03\x02\x01\x02")
RETIRED = (b"\x30\x03\x02\x01\x03",)


def test_the_certificate_route_answers_the_chain_in_pem_leaf_first() -> None:
    answer = certificate_answer(CHAIN, fmt=None)
    assert answer.status == 200
    assert (header(answer, "Content-Type") or "").partition(";")[0] in {"application/x-pem-file", "text/plain"}
    assert pem_blocks(answer.body) == list(CHAIN)
    assert answer.body.startswith(b"-----BEGIN CERTIFICATE-----")


def test_format_der_answers_the_leaf_alone_as_pkix_cert() -> None:
    answer = certificate_answer(CHAIN, fmt="der")
    assert answer.status == 200
    assert header(answer, "Content-Type") == "application/pkix-cert"
    assert answer.body == CHAIN[0]


def test_format_pem_is_the_default_spelled_out() -> None:
    assert certificate_answer(CHAIN, fmt="pem").body == certificate_answer(CHAIN, fmt=None).body


def test_the_certificates_route_lists_the_current_chain_then_the_retired_ones_in_pem() -> None:
    answer = certificates_answer(CHAIN, RETIRED)
    assert answer.status == 200
    assert pem_blocks(answer.body) == [*CHAIN, *RETIRED]


def test_with_nothing_retired_the_certificates_route_lists_the_chain() -> None:
    assert pem_blocks(certificates_answer(CHAIN, ()).body) == list(CHAIN)


def test_the_certificate_answers_carry_no_private_key() -> None:
    for answer in (certificate_answer(CHAIN, fmt=None), certificates_answer(CHAIN, RETIRED)):
        assert b"PRIVATE" not in answer.body


# -- a store that fails ------------------------------------------------------------------------------------------------
class FailingClients(RecordingClients):
    def find(self, key_hash: str) -> TsaClientRecord | None:
        raise ConnectionError("cannot reach db.internal.example:5432")


def test_a_client_store_that_raises_is_a_503_system_failure_rejection_with_retry_after_and_none_of_its_words() -> None:
    rig = Rig(access="clients")
    rig.gate = TimestampGate(
        rig.tsa, clients=FailingClients(list(rig.tsa.clients)), flood=rig.flood, clock=rig.seconds, now=lambda: NOW
    )
    answer = refused(rig.gate.admit({"Content-Type": QUERY, **bearer()}, remote_address=ADDRESS, retry_after=9))
    assert answer.status == 503
    assert header(answer, "Retry-After") == "9"
    assert header(answer, "Content-Type") == REPLY_MEDIA_TYPE
    assert b"db.internal.example" not in answer.body
    assert rig.flood.size == 0


def test_a_failed_keys_limit_of_zero_turns_the_lockout_off() -> None:
    rig = Rig(access="clients", flood={"failed_keys": 0})
    assert [refused(rig.admit(bearer(f"dtsa_w{n}"))).status for n in range(15)] == [401] * 15
    assert rig.flood.size == 0


def test_a_malformed_content_length_is_a_bad_data_format_rejection() -> None:
    answer = refused(Rig().admit({"Content-Length": "12x"}))
    assert answer.status == 400
    assert header(answer, "Content-Type") == REPLY_MEDIA_TYPE


def test_an_answer_with_neither_a_grant_nor_a_refusal_is_a_value_error() -> None:
    from datum_core.http.timestamp import answer_for  # noqa: PLC0415
    from datum_core.timestamp.authority import TimestampAnswer  # noqa: PLC0415

    with pytest.raises(ValueError, match="grant or a refusal"):
        answer_for(TimestampAnswer(response=b"x", refusal=None, grant=None), retry_after=5)

"""The address a counter keys on: an IPv6 client by its /64, an IPv4 client (mapped or not) by its address.

One host on a VPS is usually handed a whole /64 and can send every request from a new address in it; counting each
address on its own would let it walk past the submission throttle and the timestamp server's flood rule and wrong-key
lockout. A string that is not an IP address (a test client's name, a socket path) is counted as it is.

One IPv6 literal in brackets (`[2001:db8::1]`, as a URL writes it) is counted as the address inside; anything else in
brackets (an IPv4 address, a port after the bracket, two pairs) is not an IP address and is counted as it is.
"""

from typing import Any

import pytest
from pdf_support import started_pdf
from submissions_support import envelope, http_context, started
from test_http_timestamp import Rig, bearer, refused

from datum_core.http.timestamp import Admitted
from datum_core.submissions import Throttled
from datum_core.throttle import counted_address

NO_SEAL = {"pdf": {"seal": {"enabled": False}}}


@pytest.mark.parametrize(
    ("address", "counted"),
    [
        ("203.0.113.7", "203.0.113.7"),
        ("2001:db8:1:2:aaaa:bbbb:cccc:dddd", "2001:db8:1:2::/64"),
        ("2001:DB8:1:2::1", "2001:db8:1:2::/64"),
        ("2001:db8:1:3::1", "2001:db8:1:3::/64"),
        ("::ffff:203.0.113.7", "203.0.113.7"),
        ("::1", "::/64"),
        ("fe80::1%eth0", "fe80::/64"),
        ("[2001:db8:1:2::1]", "2001:db8:1:2::/64"),
        ("[::ffff:203.0.113.7]", "203.0.113.7"),
        ("[fe80::1%eth0]", "fe80::/64"),
        ("[203.0.113.7]", "[203.0.113.7]"),
        ("[[2001:db8:1:2::1]]", "[[2001:db8:1:2::1]]"),
        ("[2001:db8:1:2::1", "[2001:db8:1:2::1"),
        ("2001:db8:1:2::1]", "2001:db8:1:2::1]"),
        ("[2001:db8:1:2::1]:443", "2001:db8:1:2::/64"),
        ("[2001:db8:1:2::1]:65535", "2001:db8:1:2::/64"),
        ("[2001:db8:1:2::1]:65536", "[2001:db8:1:2::1]:65536"),
        ("[2001:db8:1:2::1]:", "[2001:db8:1:2::1]:"),
        ("[2001:db8:1:2::1]8080", "[2001:db8:1:2::1]8080"),
        ("[203.0.113.7:4711]", "203.0.113.7"),
        ("[203.0.113.7:65536]", "[203.0.113.7:65536]"),
        ("[203.0.113.07:80]", "[203.0.113.07:80]"),
        ("[203.0.113.7]:80", "[203.0.113.7]:80"),
        ("[fe80::1%a]b]", "[fe80::1%a]b]"),
        ("[]", "[]"),
        ("[testclient]", "[testclient]"),
        ("testclient", "testclient"),
        ("", ""),
        (None, None),
    ],
)
def test_the_counted_address(address: str | None, counted: str | None) -> None:
    assert counted_address(address) == counted


def test_two_addresses_of_one_ipv6_64_share_the_submission_throttle_key() -> None:
    with started() as rig:
        rig.submit(envelope(), http_context(ip="2001:db8:1:2::1"))
        rig.submit(envelope(), http_context(ip="2001:db8:1:2::ffff"))
        rig.submit(envelope(), http_context(ip="2001:db8:1:3::1"))
        rig.submit(envelope(), http_context(ip="::ffff:203.0.113.7"))
    assert [key.ip for key in rig.throttle.keys] == [
        "2001:db8:1:2::/64",
        "2001:db8:1:2::/64",
        "2001:db8:1:3::/64",
        "203.0.113.7",
    ]


def test_the_limit_holds_across_the_addresses_of_one_64() -> None:
    limited = {"web": {"throttle": {"limit": 2, "window": 60}}}
    with started(limited, throttle=None) as rig:
        answers = [
            rig.submit(envelope(values={"name": f"n{n}"}), http_context(ip=f"2001:db8:1:2::{n + 1:x}"))
            for n in range(3)
        ]
        other = rig.submit(envelope(values={"name": "x"}), http_context(ip="2001:db8:1:3::1"))
    assert [isinstance(answer, Throttled) for answer in answers] == [False, False, True]
    assert not isinstance(other, Throttled)


def test_the_pdf_throttle_counts_an_ipv6_client_by_its_64() -> None:
    with started_pdf(NO_SEAL) as rig:
        rig.throttle.deny = 9
        outcome = rig.render(context=http_context(ip="2001:db8:1:2::abcd"))
    assert isinstance(outcome, Throttled)
    assert outcome.key.ip == "2001:db8:1:2::/64"


def _wrong_keys(rig: Any, addresses: list[str]) -> list[int]:
    return [refused(rig.admit(bearer(f"dtsa_wrong{n}"), address=address)).status for n, address in enumerate(addresses)]


def test_the_wrong_key_lockout_holds_across_the_addresses_of_one_64() -> None:
    rig = Rig(access="clients", flood={"failed_keys": 2})
    statuses = _wrong_keys(rig, ["2001:db8:1:2::1", "2001:db8:1:2::2", "2001:db8:1:2::3"])
    assert statuses == [401, 401, 429]
    assert _wrong_keys(rig, ["2001:db8:1:3::1"]) == [401]


def test_the_tsa_flood_rule_holds_across_the_addresses_of_one_64_and_a_mapped_address_is_its_ipv4() -> None:
    rig = Rig(flood={"limit": 2})
    assert isinstance(rig.admit(address="2001:db8:1:2::1"), Admitted)
    assert isinstance(rig.admit(address="2001:db8:1:2::2"), Admitted)
    assert refused(rig.admit(address="2001:db8:1:2::3")).status == 429
    assert isinstance(rig.admit(address="2001:db8:1:3::1"), Admitted)
    assert isinstance(rig.admit(address="198.51.100.9"), Admitted)
    assert isinstance(rig.admit(address="::ffff:198.51.100.9"), Admitted)
    assert refused(rig.admit(address="198.51.100.9")).status == 429

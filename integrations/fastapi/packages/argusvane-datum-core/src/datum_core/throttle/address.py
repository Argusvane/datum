"""The part of a client address a counter keys on.

One host is commonly handed a whole IPv6 /64 and can send each request from a new address in it, so an IPv6 client
is counted by its /64; an IPv4 client, and an IPv4 address written as IPv4-mapped IPv6, by its address. A string that
is not an IP address (a test client's name, a socket path) is counted as it is.

A proxy's forwarded-header handling can report the client in brackets: one IPv6 literal (`[2001:db8::1]`), optionally
followed by a port (`[2001:db8::1]:8443`), is counted as the address inside; one IPv4 address with a port inside the
brackets (`[203.0.113.7:4711]`) is counted as that IPv4 address, so each connection is not a key of its own. Anything
else in brackets (a bare IPv4 address, a second pair, a port that is not one to five digits up to 65535) is counted as
it is. The JVM host reads the same shapes the same way.

Built on: `ipaddress` parses the address, unmaps it and gives the network; this module only takes the brackets and the
port off.
"""

import ipaddress
from typing import Final

__all__ = ["IPV6_PREFIX", "counted_address"]

IPV6_PREFIX: Final = 64
"""The prefix length an IPv6 client is counted under."""

_MAX_PORT: Final = 65_535
_MAX_PORT_DIGITS: Final = 5


def _is_port(digits: str) -> bool:
    """Return whether `digits` is a port: one to five ASCII digits, at most 65535."""
    return 0 < len(digits) <= _MAX_PORT_DIGITS and digits.isascii() and digits.isdigit() and int(digits) <= _MAX_PORT


def _unbracketed(address: str) -> str | None:
    """Return what is inside one bracket pair, optionally followed by `:port`, or None when `address` is not that."""
    if not address.startswith("[") or address.count("[") != 1 or address.count("]") != 1:
        return None
    close = address.index("]")
    rest = address[close + 1 :]
    if rest and not (rest.startswith(":") and _is_port(rest[1:])):
        return None
    return address[1:close]


def _ipv4_before_port(text: str) -> str | None:
    """Return the IPv4 address of `a.b.c.d:port`, or None when `text` is not that."""
    host, colon, port = text.partition(":")
    if not colon or not _is_port(port):
        return None
    try:
        return str(ipaddress.IPv4Address(host))
    except ValueError:
        return None


def counted_address(address: str | None) -> str | None:
    """Return what a counter keys `address` on: the IPv6 /64 (`2001:db8:1:2::/64`), else the address as given.

    `[2001:db8:1:2::1]` and `[2001:db8:1:2::1]:443` are counted as `2001:db8:1:2::1` is; `[203.0.113.7:4711]` as
    `203.0.113.7`.
    """
    if not address:
        return address
    literal = _unbracketed(address)
    if literal is not None:
        ipv4 = _ipv4_before_port(literal)
        if ipv4 is not None:
            return ipv4
    try:
        parsed = ipaddress.ip_address(address if literal is None else literal)
    except ValueError:
        return address
    if isinstance(parsed, ipaddress.IPv4Address):
        return address  # a bare IPv4 address in brackets is no literal: counted as given, as any other string
    mapped = parsed.ipv4_mapped
    if mapped is not None:
        return str(mapped)
    # the integer drops a zone index (`%eth0`): the network is the same whatever interface it arrived on
    return str(ipaddress.IPv6Network((int(parsed), IPV6_PREFIX), strict=False))

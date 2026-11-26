"""ECMAScript Number::toString (RFC 8785 section 3.2.2.3) over the shortest round-trip digits of `repr(float)`."""

import math

from datum_sandbox.json._errors import BadDocumentError, RefusalReason

_TWO53 = 2**53


def format_double(value: float) -> str:
    """Write a finite double as JavaScript does; `-0` is `0`."""
    if not math.isfinite(value):
        raise BadDocumentError(RefusalReason.NON_FINITE, "a non-finite number has no JSON form")
    if value == 0.0:
        return "0"
    sign = "-" if value < 0 else ""
    mantissa, _, exponent = repr(abs(value)).partition("e")
    integer, _, fraction = mantissa.partition(".")
    digits = integer + fraction
    n = len(integer) + (int(exponent) if exponent else 0)
    trimmed = digits.lstrip("0")
    n -= len(digits) - len(trimmed)
    digits = trimmed.rstrip("0")
    k = len(digits)
    if k <= n <= 21:  # noqa: PLR2004
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:  # noqa: PLR2004
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:  # noqa: PLR2004
        return sign + "0." + "0" * (-n) + digits
    e = n - 1
    tail = "e" + ("+" if e >= 0 else "-") + str(abs(e))
    return sign + (digits if k == 1 else digits[0] + "." + digits[1:]) + tail


def format_int(value: int) -> str:
    """Write an integer exactly up to 2^53, else as the double the engine reads."""
    if -_TWO53 <= value <= _TWO53:
        return str(value)
    try:
        return format_double(float(value))
    except OverflowError as error:
        raise BadDocumentError(RefusalReason.NON_FINITE, "integer too large for a double") from error

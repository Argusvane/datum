"""Doubles, builders and rigs for the timestamp tests.

The API under test is named in the import lines here and in the test modules: the facade
`datum_core.timestamp` (`TimestampQuery`, `TimestampAuthority`, `TimestampToken`, `TimestampRefusal`, ...), the
protocols in `datum_core.timestamp.protocols`, the memory stores in `datum_core.stores.memory`, and the `Datum`
keywords (`timestamp_request_customizers`, `tsa_time_source`, `tsa_key_material`, `tsa_serial_allocator`,
`tsa_log`, `tsa_client_store`, `tsa_transport`) with `Datum.timestamp_authority`.

Everything that signs uses the test PKI of `datum_core.testing.tsa_pki` (built per session by the `tsa_pki` fixture).
"""

import contextlib
import cProfile
import hashlib
import itertools
import pstats
import subprocess
import threading
from collections.abc import Callable, Generator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

from submissions_support import RecordingSandbox, StubRuntime

from datum_core import Datum, DatumConfig
from datum_core.config.models import TsaSigner
from datum_core.events import DatumEvent
from datum_core.hooks import Awaiter
from datum_core.testing.openssl import openssl_binary
from datum_core.testing.tsa_pki import INSTANT, TsaIdentity
from datum_core.timestamp import (
    TimestampAuthority,
    TimestampQuery,
    TimestampRefusedError,
    TimestampRequestDraft,
)
from datum_core.timestamp.protocols import Reading, TimestampFailure

if TYPE_CHECKING:
    from datum_sandbox.protocol import Sandbox
    from datum_sandbox.wasi import GuestRuntime

POLICY = "1.3.6.1.4.1.99999.1"
OTHER_POLICY = "1.3.6.1.4.1.99999.2"
FOREIGN_POLICY = "1.2.3.4.5"
CLIENT_KEY = "dtsa_" + "Qk1uZ0pLd0d4cWFyTVpKbVhzbmFwdG9nZ1l3aHBqaXE"
"""A client key as a person is handed it: the prefix and 43 URL-safe characters."""

_ = (TimestampRefusedError, TimestampRequestDraft)  # re-exported for the test modules' convenience


def refused(failure: str, message: str = "") -> TimestampRefusedError:
    """Build a `TimestampRefusedError` for a failure name held in a string (a test table's key)."""
    return TimestampRefusedError(cast("TimestampFailure", failure), message)


def sha256(data: bytes) -> bytes:
    """Return the SHA-256 digest of `data`."""
    return hashlib.sha256(data).digest()


def key_hash(text: str) -> str:
    """Return the lower-case hex SHA-256 of a client key's whole text."""
    return hashlib.sha256(text.encode()).hexdigest()


def query_of(data: bytes = b"hello", *, algorithm: str = "sha256", **fields: Any) -> TimestampQuery:
    """Return a query over the `algorithm` digest of `data`; `fields` are `policy`, `nonce` and `cert_req`."""
    digest = hashlib.new(algorithm, data).digest()
    return TimestampQuery.of(digest, algorithm, **fields)


# -- doubles -----------------------------------------------------------------------------------------------------------


class IdentityKey:
    """A `TsaKeyMaterial` over a test identity; it counts its uses so a test can say a refusal never touched the key."""

    def __init__(self, identity: TsaIdentity, *, chain: Sequence[bytes] | None = None) -> None:
        self.identity = identity
        self._chain = tuple(chain) if chain is not None else identity.chain_der
        self.signs = 0
        self._lock = threading.Lock()

    @property
    def signature_algorithm(self) -> Any:
        return self.identity.algorithm

    @property
    def chain_der(self) -> tuple[bytes, ...]:
        return self._chain

    def sign(self, data: bytes) -> bytes:
        with self._lock:
            self.signs += 1
        return self.identity.sign(data)


class CountingSerials:
    """A serial allocator that counts and numbers from 1 (unique, increasing)."""

    def __init__(self, start: int = 1) -> None:
        self._counter = itertools.count(start)
        self.allocations = 0
        self._lock = threading.Lock()

    def allocate(self) -> int:
        with self._lock:
            self.allocations += 1
            return next(self._counter)


class FailingSerials:
    """A serial allocator whose store is down."""

    def allocate(self) -> int:
        raise ConnectionError("the serial store is down: db.internal.example:5432")


class ListLog:
    """A `TsaLog` over a list."""

    def __init__(self) -> None:
        self.entries: list[Any] = []

    def append(self, entry: Any) -> None:
        self.entries.append(entry)

    def recent(self, limit: int) -> tuple[Any, ...]:
        return tuple(reversed(self.entries))[:limit]


class Clock:
    """A `TsaTimeSource` the test drives: available at `instant`, unavailable with a reason, or raising."""

    def __init__(self, instant: datetime = INSTANT) -> None:
        self.instant = instant
        self.reason: str | None = None
        self.error: Exception | None = None
        self.reads = 0

    def read(self) -> Reading:
        self.reads += 1
        if self.error is not None:
            raise self.error
        if self.reason is not None:
            return Reading.unavailable(self.reason)
        return Reading.available(self.instant)

    def advance(self, seconds: float) -> None:
        self.instant += timedelta(seconds=seconds)


def fixed_now() -> datetime:
    """The tests' clock: `INSTANT`."""
    return INSTANT


def make_authority(
    identity: TsaIdentity,
    *,
    key: Any = None,
    serials: Any = None,
    policy: str = POLICY,
    accepted_policies: Sequence[str] = (OTHER_POLICY,),
    accuracy: float = 1.0,
    **seams: Any,
) -> TimestampAuthority:
    """Build an authority over `identity` with a counting serial allocator and the fixed clock."""
    seams.setdefault("now", fixed_now)
    return TimestampAuthority(
        key=key if key is not None else IdentityKey(identity),
        serials=serials if serials is not None else CountingSerials(),
        policy=policy,
        accepted_policies=tuple(accepted_policies),
        accuracy=accuracy,
        **seams,
    )


def count_calls(fn: Callable[[], object]) -> int:
    """Run `fn` under the profiler and return how many function calls it made (Python and built-in)."""
    profile = cProfile.Profile()
    profile.enable()
    try:
        fn()
    finally:
        profile.disable()
    return int(pstats.Stats(profile).total_calls)  # type: ignore[attr-defined]  # typeshed omits total_calls


# -- signer settings over files the test writes ------------------------------------------------------------------------

P12_PASSWORD = "p12-correct-horse-battery"
KEY_PASSWORD = "pem-key-staple-horse-9"


def pkcs12_signer(
    directory: Path,
    identity: TsaIdentity,
    *,
    password: str | None = P12_PASSWORD,
    key_name: str | None = "datum-tsa",
    ca_names: Sequence[str | None] = (None,),
    friendly_name: str | None = None,
    key_password: str | None = None,
    file_name: str = "tsa.p12",
) -> TsaSigner:
    """Write `identity` as PKCS#12 under `directory` and return the `datum.tsa.signer` settings that name it."""
    path = directory / file_name
    path.write_bytes(identity.pkcs12(password=password, key_name=key_name, ca_names=ca_names))
    return TsaSigner.model_validate(
        {
            "type": "PKCS12",
            "pkcs12_file": str(path),
            "pkcs12_password": password,
            "friendly_name": friendly_name,
            "key_password": key_password,
        }
    )


def pem_signer(
    directory: Path, identity: TsaIdentity, *, key_password: str | None = None, with_root: bool = True
) -> TsaSigner:
    """Write `identity` as a PEM key and chain under `directory` and return the settings that name them."""
    key_file, cert_file = identity.write_pem_pair(directory, key_password=key_password, with_root=with_root)
    return TsaSigner.model_validate(
        {"type": "PEM", "key_file": str(key_file), "cert_file": str(cert_file), "key_password": key_password}
    )


def with_fields(signer: TsaSigner, **changes: Any) -> TsaSigner:
    """Return a new `TsaSigner` with `changes` applied (a settings section has no copy method: values are validated)."""
    fields = {name: getattr(signer, name) for name in TsaSigner.model_fields}
    return TsaSigner.model_validate({**fields, **changes})


def secrets_of(identity: TsaIdentity, *passwords: str) -> list[str | bytes]:
    """Every text and byte string that must never appear in a log, repr, event, health body or error.

    The passwords, the PEM label of a private key and secret numbers of the key itself: the private scalar of an EC key,
    the leading octets of the private exponent and the two primes of an RSA key (the public parts are in the
    certificates, which are not secret, so they are not in this list).
    """
    from cryptography.hazmat.primitives.asymmetric import ec  # noqa: PLC0415 - tests only

    found: list[str | bytes] = [*passwords, "PRIVATE KEY"]
    if isinstance(identity.key, ec.EllipticCurvePrivateKey):
        scalar = identity.key.private_numbers().private_value.to_bytes(32, "big")
        found += [scalar, scalar.hex()]
    else:
        numbers = identity.key.private_numbers()
        for number in (numbers.d, numbers.p, numbers.q):
            fragment = number.to_bytes((number.bit_length() + 7) // 8, "big")[:24]
            found += [fragment, fragment.hex()]
    return found


def leaks(text: str, forbidden: Sequence[str | bytes]) -> list[str]:
    """Return which of `forbidden` occur in `text` (a bytes secret is looked for as its repr and, if UTF-8, as text)."""
    hit: list[str] = []
    for item in forbidden:
        if isinstance(item, bytes):
            if repr(item)[2:-1] in text or item.hex() in text:
                hit.append(f"bytes:{item[:6].hex()}")
        elif item in text:
            hit.append(item[:12])
    return hit


# -- the Datum rig -----------------------------------------------------------------------------------------------------


def tsa_sections(**more: Any) -> dict[str, Any]:
    """The `tsa` settings of a rig: on, open, one issuing policy, memory stores acknowledged, a self-signed key."""
    base: dict[str, Any] = {
        "enabled": True,
        "access": "open",
        "policy": POLICY,
        "accepted_policies": [OTHER_POLICY],
        "allow_memory_stores": True,
    }
    base.update(more)
    return {"tsa": base}


def tsa_config(config: Mapping[str, Any] | None = None, **tsa: Any) -> DatumConfig:
    """A configuration with the TSA on (see `tsa_sections`) and any other sections in `config`."""
    sections = {**tsa_sections(**tsa), **dict(config or {})}
    return DatumConfig.model_validate(sections)


def plain_tsa_datum(config: DatumConfig | Mapping[str, Any] | None = None, **seams: Any) -> Datum:
    """A not-started `Datum` over the stub runtime and a recording sandbox, with the TSA on unless `config` says."""
    seams.setdefault("runtime", cast("GuestRuntime", StubRuntime()))
    seams.setdefault("sandbox", cast("Sandbox", RecordingSandbox([])))
    seams.setdefault("now", fixed_now)
    if config is None:
        config = tsa_config()
    elif not isinstance(config, DatumConfig):
        config = DatumConfig.model_validate(dict(config))
    return Datum(config=config, **seams)


@dataclass
class TsaRig:
    """A started `Datum` with the TSA on, and what its seams recorded."""

    datum: Datum
    key: IdentityKey
    serials: CountingSerials
    clock: Clock
    log: ListLog
    events: list[DatumEvent] = field(default_factory=lambda: cast("list[DatumEvent]", []))

    @property
    def authority(self) -> TimestampAuthority:
        authority = self.datum.timestamp_authority
        assert authority is not None
        return authority

    def issue(self, data: bytes = b"hello", **fields: Any) -> Any:
        return self.authority.issue(query_of(data, **fields))

    def kinds(self) -> list[str]:
        return [type(event).__name__ for event in self.events]


@contextlib.contextmanager
def started_tsa(
    identity: TsaIdentity,
    config: DatumConfig | Mapping[str, Any] | None = None,
    *,
    awaiter: Awaiter | None = None,
    **seams: Any,
) -> Generator[TsaRig]:
    """Start a `Datum` with the TSA on over recording seams (a `seams` keyword replaces the recording one)."""
    events: list[DatumEvent] = []
    key = seams.pop("tsa_key_material", None) or IdentityKey(identity)
    serials = seams.pop("tsa_serial_allocator", None) or CountingSerials()
    clock = seams.pop("tsa_time_source", None) or Clock()
    log = seams.pop("tsa_log", None) or ListLog()
    listeners = [*seams.pop("listeners", ()), (DatumEvent, events.append)]
    datum = plain_tsa_datum(
        config,
        tsa_key_material=key,
        tsa_serial_allocator=serials,
        tsa_time_source=clock,
        tsa_log=log,
        listeners=listeners,
        **seams,
    )
    datum.start(awaiter=awaiter)
    events.clear()  # the start published its own ready event
    try:
        yield TsaRig(datum, key, serials, clock, log, events)
    finally:
        datum.stop()


# -- openssl -----------------------------------------------------------------------------------------------------------


def run_openssl(*args: str, data: bytes | None = None, cwd: Path | None = None) -> subprocess.CompletedProcess[bytes]:
    """Run the openssl binary (`DATUM_OPENSSL` or the PATH's) and return the completed process."""
    binary = openssl_binary()
    assert binary is not None, "a test that calls openssl is marked requires_openssl"
    return subprocess.run(  # noqa: S603
        [binary, *args], input=data, capture_output=True, check=False, timeout=60, cwd=cwd
    )


def openssl_verify(
    directory: Path,
    response: bytes,
    *,
    root_pem: bytes,
    data: bytes | None = None,
    query: bytes | None = None,
    token_in: bool = False,
    untrusted_pem: bytes | None = None,
) -> subprocess.CompletedProcess[bytes]:
    """Run `openssl ts -verify` on `response` (a TimeStampResp, or a bare token with `token_in`)."""
    reply = directory / "reply.tsr"
    ca = directory / "root.pem"
    reply.write_bytes(response)
    ca.write_bytes(root_pem)
    args = ["ts", "-verify", "-CAfile", str(ca), "-in", str(reply)]
    if token_in:
        args.append("-token_in")
    if untrusted_pem is not None:
        extra = directory / "untrusted.pem"
        extra.write_bytes(untrusted_pem)
        args += ["-untrusted", str(extra)]
    if query is not None:
        queryfile = directory / "request.tsq"
        queryfile.write_bytes(query)
        args += ["-queryfile", str(queryfile)]
    if data is not None:
        datafile = directory / "data.bin"
        datafile.write_bytes(data)
        args += ["-data", str(datafile)]
    return run_openssl(*args)


def openssl_reply_text(directory: Path, response: bytes) -> str:
    """Return `openssl ts -reply -text` for `response` (the failure text of a rejection, the TST info of a grant)."""
    reply = directory / "reply.tsr"
    reply.write_bytes(response)
    done = run_openssl("ts", "-reply", "-in", str(reply), "-text")
    return (done.stdout + done.stderr).decode("utf-8", "replace")

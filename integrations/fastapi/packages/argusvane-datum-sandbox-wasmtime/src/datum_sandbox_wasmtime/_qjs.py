"""The guest module's bytes, re-hashed at load.

They are the pinned `qjs-wasi.wasm` from `argusvane-datum-qjs-wasm`, or an own copy.

The bytes are read once, hashed, compared with the pin or with the digest the application gives for its own copy, and
only then compiled. The pin is `PINNED_SHA256`, built into this distribution, so a substituted
`argusvane-datum-qjs-wasm` (a private mirror, an air-gapped index) cannot bring its own: the `runtime.json` that ships
beside the module must say the same digest, and the module must hash to it. A mismatch refuses the start naming both
digests.
"""

import hashlib
import json
from dataclasses import dataclass
from importlib import resources
from importlib.resources.abc import Traversable
from pathlib import Path
from typing import Final

import datum_qjs_wasm
from datum_sandbox.wasi import EngineConfigurationError

ASSET: Final = "qjs-wasi.wasm"
PIN: Final = "runtime.json"
PINNED_SHA256: Final = "d2939e98c808e8b9f4164cd0d7b0398cbc0121ddf52862bcd92157d923e461cc"
"""The SHA-256 of the pinned `qjs-wasi.wasm`, held here and in `runtime.json` of `argusvane-datum-qjs-wasm`."""
PINNED_VERSION: Final = "0.16.2"
"""The QuickJS-ng release of the pin: `qjsVersion` of the same `runtime.json`."""


@dataclass(frozen=True, slots=True)
class QjsBinary:
    """Verified guest bytes: the bytes, their SHA-256, the QuickJS-ng version pinned and where they came from."""

    data: bytes
    sha256: str
    version: str
    source: str


def pinned() -> tuple[str, str]:
    """Return the pin: the SHA-256 and the QuickJS-ng version of `qjs-wasi.wasm` (`PINNED_SHA256`, `PINNED_VERSION`)."""
    return PINNED_SHA256, PINNED_VERSION


def shipped_pin() -> tuple[str, str]:
    """Return the pin `argusvane-datum-qjs-wasm` ships in its `runtime.json`: the SHA-256 and the QuickJS-ng version."""
    record = json.loads((_resources() / PIN).read_text(encoding="utf-8"))
    return str(record["sha256"]).lower(), str(record.get("qjsVersion", "unknown"))


def load_qjs(path: Path | None = None, sha256: str | None = None) -> QjsBinary:
    """Read and verify the guest module: the packaged one, or `path` checked against `sha256` (default: the pin).

    Raises `EngineConfigurationError` when a file cannot be read, when its digest differs (naming both digests), or,
    for the packaged module, when the `runtime.json` beside it names another pin than the one built in here.
    """
    want, version = pinned()
    if path is None:
        source = f"argusvane-datum-qjs-wasm {ASSET}"
        _hold_shipped_pin(want)
        try:
            data = (_resources() / ASSET).read_bytes()
        except OSError as error:
            raise EngineConfigurationError(
                f"the packaged {ASSET} cannot be read: {error}",
                hint="reinstall argusvane-datum-qjs-wasm; its build ships the pinned module",
            ) from error
    else:
        source = str(path)
        if sha256 is not None:
            want = sha256.lower()
        try:
            data = path.read_bytes()
        except OSError as error:
            raise EngineConfigurationError(
                f"datum.runtime.qjs_path {path} cannot be read: {error}",
                hint="point datum.runtime.qjs_path at a readable qjs-wasi.wasm, or unset it to use the packaged one",
            ) from error
    got = hashlib.sha256(data).hexdigest()
    if got != want:
        setting = "datum.runtime.qjs_sha256" if sha256 is not None else "the pin of argusvane-datum-sandbox-wasmtime"
        raise EngineConfigurationError(
            f"{source} has SHA-256 {got}, but {setting} says {want}",
            hint="reinstall argusvane-datum-qjs-wasm, or give the digest of the own copy in datum.runtime.qjs_sha256",
        )
    return QjsBinary(data=data, sha256=got, version=version, source=source)


def _hold_shipped_pin(want: str) -> None:
    """Refuse an `argusvane-datum-qjs-wasm` whose `runtime.json` is not the pin built into this distribution."""
    try:
        shipped, _ = shipped_pin()
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise EngineConfigurationError(
            f"argusvane-datum-qjs-wasm {PIN} cannot be read: {error}",
            hint="reinstall argusvane-datum-qjs-wasm at the release argusvane-datum-sandbox-wasmtime requires",
        ) from error
    if shipped != want:
        raise EngineConfigurationError(
            f"argusvane-datum-qjs-wasm {PIN} pins SHA-256 {shipped}, but argusvane-datum-sandbox-wasmtime is built for "
            f"{want}",
            hint="install the argusvane-datum-qjs-wasm release argusvane-datum-sandbox-wasmtime requires, from the "
            "index you trust",
        )


def _resources() -> Traversable:
    return resources.files(datum_qjs_wasm)

"""The guest module's bytes, re-hashed at load.

They are the pinned `qjs-wasi.wasm` from `argusvane-datum-qjs-wasm`, or an own copy.

The bytes are read once, hashed, compared with the pin (`runtime.json` of `argusvane-datum-qjs-wasm`) or with the digest
the application gives for its own copy, and only then compiled. A mismatch refuses the start naming both digests.
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


@dataclass(frozen=True, slots=True)
class QjsBinary:
    """Verified guest bytes: the bytes, their SHA-256, the QuickJS-ng version pinned and where they came from."""

    data: bytes
    sha256: str
    version: str
    source: str


def pinned() -> tuple[str, str]:
    """Return the pin of `argusvane-datum-qjs-wasm`: the SHA-256 and the QuickJS-ng version of its `qjs-wasi.wasm`."""
    record = json.loads((_resources() / PIN).read_text(encoding="utf-8"))
    return str(record["sha256"]).lower(), str(record.get("qjsVersion", "unknown"))


def load_qjs(path: Path | None = None, sha256: str | None = None) -> QjsBinary:
    """Read and verify the guest module: the packaged one, or `path` checked against `sha256` (default: the pin).

    Raises `EngineConfigurationError` when a file cannot be read or its digest differs, naming both digests.
    """
    want, version = pinned()
    if path is None:
        source = f"argusvane-datum-qjs-wasm {ASSET}"
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
        setting = "datum.runtime.qjs_sha256" if path is not None else f"the pin in argusvane-datum-qjs-wasm {PIN}"
        raise EngineConfigurationError(
            f"{source} has SHA-256 {got}, but {setting} says {want}",
            hint="reinstall argusvane-datum-qjs-wasm, or give the digest of the own copy in datum.runtime.qjs_sha256",
        )
    return QjsBinary(data=data, sha256=got, version=version, source=source)


def _resources() -> Traversable:
    return resources.files(datum_qjs_wasm)

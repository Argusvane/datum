"""Tests for the dev-only slab script: sha refusal, backup, second install, restore."""

from __future__ import annotations

import hashlib
import importlib.util
import io
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from types import ModuleType

SCRIPT = Path(__file__).resolve().parents[1] / "dev-slab-344.py"


@pytest.fixture
def script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("dev_slab_344", SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Response(io.BytesIO):
    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def _serve(monkeypatch: pytest.MonkeyPatch, script: ModuleType, data: bytes, *, match: bool) -> None:
    if match:
        monkeypatch.setattr(script, "SHA256", hashlib.sha256(data).hexdigest())
    monkeypatch.setattr(script.urllib.request, "urlopen", lambda *a, **k: _Response(data))


def test_wrong_sha_refuses_and_leaves_target(
    script: ModuleType, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target, backup = tmp_path / "_slab.py", tmp_path / "_slab.py.orig"
    target.write_bytes(b"ORIGINAL")
    _serve(monkeypatch, script, b"something else", match=False)
    with pytest.raises(SystemExit):
        script.install(target, backup)
    assert target.read_bytes() == b"ORIGINAL"
    assert not backup.exists()


def test_install_keeps_backup_and_restore_returns_original(
    script: ModuleType, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target, backup = tmp_path / "_slab.py", tmp_path / "_slab.py.orig"
    target.write_bytes(b"ORIGINAL")
    _serve(monkeypatch, script, b"FIXED", match=True)
    script.install(target, backup)
    assert target.read_bytes() == b"FIXED"
    assert backup.read_bytes() == b"ORIGINAL"
    script.install(target, backup)  # second install must not overwrite the backup
    assert backup.read_bytes() == b"ORIGINAL"
    script.restore(target, backup)
    assert target.read_bytes() == b"ORIGINAL"
    assert not backup.exists()


def test_reinstalled_original_replaces_stale_backup(
    script: ModuleType, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target, backup = tmp_path / "_slab.py", tmp_path / "_slab.py.orig"
    target.write_bytes(b"OLD-VERSION")
    backup.write_bytes(b"STALE")
    _serve(monkeypatch, script, b"FIXED", match=True)
    script.install(target, backup)
    assert backup.read_bytes() == b"OLD-VERSION"
    script.restore(target, backup)
    assert target.read_bytes() == b"OLD-VERSION"


def test_restore_without_backup_exits(script: ModuleType, tmp_path: Path) -> None:
    target = tmp_path / "_slab.py"
    target.write_bytes(b"ORIGINAL")
    with pytest.raises(SystemExit):
        script.restore(target, tmp_path / "_slab.py.orig")
    assert target.read_bytes() == b"ORIGINAL"

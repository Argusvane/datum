"""The contract kit is strictly typed; the throttle exports its health name."""

import subprocess
import sys
from pathlib import Path

from datum_core import throttle
from datum_core.testing import idempotency_contract

FASTAPI_ROOT = Path(__file__).resolve().parents[3]


def test_the_idempotency_contract_kit_passes_mypy_strict() -> None:
    result = subprocess.run(  # noqa: S603
        [
            sys.executable,
            "-m",
            "mypy",
            "--config-file",
            str(FASTAPI_ROOT / "pyproject.toml"),
            "--no-incremental",
            str(Path(idempotency_contract.__file__)),
        ],
        capture_output=True,
        text=True,
        check=False,
        cwd=FASTAPI_ROOT,
        timeout=600,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_the_throttle_package_exports_its_health_name() -> None:
    assert throttle.HEALTH_NAME == "stores.throttle"
    assert "HEALTH_NAME" in throttle.__all__

"""Development only: put wasmtime-py PR #344's handle slab into the dev venv.

Never shipped and never imported by product code. It exists so the runtime tasks can run against the fixed slab before
wasmtime 50.0.0 (the first release that ships #344) is on PyPI. Once 50.x is installed this script is not needed; remove
it then.

Usage (from integrations/fastapi, with the dev environment synced):

    uv run --package argusvane-datum-sandbox-wasmtime python scripts/dev-slab-344.py          # install the fixed slab
    uv run --package argusvane-datum-sandbox-wasmtime python scripts/dev-slab-344.py --restore  # put the original back

The file is fetched from the official bytecodealliance/wasmtime-py repository at commit 280ce73b0e and must match the
sha256 below before it is written. The original is kept beside it as _slab.py.orig and is restored by --restore.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import shutil
import sys
import urllib.request
from pathlib import Path

COMMIT = "280ce73b0e"
SOURCE_URL = f"https://raw.githubusercontent.com/bytecodealliance/wasmtime-py/{COMMIT}/wasmtime/_slab.py"
SHA256 = "915414e9d3035ea5f8673540218baa7e7682cec7f50e8c5a5d27e3d22ef97f06"
TIMEOUT_SECONDS = 30


def wasmtime_dir() -> Path:
    """Locate the installed wasmtime package of the current interpreter."""
    spec = importlib.util.find_spec("wasmtime")
    if spec is None or spec.origin is None:
        sys.exit("wasmtime is not importable here; sync the dev environment first (uv sync --all-packages --frozen)")
    return Path(spec.origin).parent


def install(target: Path, backup: Path) -> None:
    """Download the PR #344 slab, verify its sha256, back up the installed file and replace it."""
    with urllib.request.urlopen(SOURCE_URL, timeout=TIMEOUT_SECONDS) as response:
        data = response.read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != SHA256:
        sys.exit(f"refusing to install: sha256 {digest} does not match {SHA256}")
    if hashlib.sha256(target.read_bytes()).hexdigest() == SHA256:
        print(f"{target} already holds the PR #344 slab; backup left as it is")
    else:
        shutil.copy2(target, backup)
        print(f"backed up {target} to {backup}")
    temporary = target.with_suffix(".py.new")
    temporary.write_bytes(data)
    temporary.replace(target)
    print(f"installed PR #344 slab ({COMMIT}) at {target}")


def restore(target: Path, backup: Path) -> None:
    """Put the backed-up original slab back."""
    if not backup.exists():
        sys.exit(f"no backup at {backup}; nothing to restore")
    backup.replace(target)
    print(f"restored {target} from the backup")


def main() -> None:
    """Parse the command line and install or restore."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--restore", action="store_true", help="put the original _slab.py back")
    arguments = parser.parse_args()
    package = wasmtime_dir()
    target = package / "_slab.py"
    backup = package / "_slab.py.orig"
    if not target.exists():
        sys.exit(f"{target} does not exist; this wasmtime build has no _slab.py to replace")
    if arguments.restore:
        restore(target, backup)
    else:
        install(target, backup)


if __name__ == "__main__":
    main()

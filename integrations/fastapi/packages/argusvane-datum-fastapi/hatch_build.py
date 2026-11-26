"""Build guard for a Datum distribution: it refuses a build whose generated files are absent or stale.

This is a guard only. It never generates anything, because a consumer installing from an sdist cannot assume Node.
The files are written by `npm run fastapi:assets` and listed as hatch artifacts in pyproject.toml.
"""

from __future__ import annotations

import json
import tomllib
from pathlib import Path
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

_HINT = "run `npm run fastapi:assets` from the repository root"


class GuardHook(BuildHookInterface):  # type: ignore[type-arg]
    PLUGIN_NAME = "custom"

    def initialize(self, version: str, build_data: dict[str, Any]) -> None:  # noqa: ARG002
        root = Path(self.root)
        project = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
        name = str(project["project"]["name"])
        package = root / "src" / name.removeprefix("argusvane-").replace("-", "_")

        build_json = package / "datum-build.json"
        if not build_json.is_file():
            raise RuntimeError(f"{name}: generated file missing: {build_json.relative_to(root)}; {_HINT}")
        try:
            recorded = json.loads(build_json.read_text(encoding="utf-8")).get("version")
        except (OSError, ValueError) as error:
            raise RuntimeError(f"{name}: {build_json.relative_to(root)} is unreadable ({error}); {_HINT}") from error
        declared = self.metadata.version
        if recorded != declared:
            raise RuntimeError(f"{name}: version {declared} disagrees with datum-build.json ({recorded!r}); {_HINT}")

        candidates = project.get("tool", {}).get("datum-build", {}).get("manifest", [])
        if candidates and not any((package / c).is_file() for c in candidates):
            raise RuntimeError(
                f"{name}: generated file missing: manifest.json under {package.relative_to(root)} "
                f"(looked in {', '.join(candidates)}); {_HINT}"
            )

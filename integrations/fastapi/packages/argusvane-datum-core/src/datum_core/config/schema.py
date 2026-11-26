"""Publish the settings JSON Schema: ``python -m datum_core.config.schema --out PATH``."""

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from datum_core.config.models import DatumConfig

SCHEMA_FILE = "datum-settings.schema.json"
DRAFT = "https://json-schema.org/draft/2020-12/schema"


def settings_schema() -> dict[str, Any]:
    """Return the schema in validation mode, the shape a file or environment supplies."""
    schema = DatumConfig.model_json_schema(mode="validation")
    schema["$schema"] = DRAFT
    schema["title"] = "Datum settings"
    return schema


def render() -> str:
    """Return the schema as stable text: sorted keys, two-space indent, one trailing newline."""
    return json.dumps(settings_schema(), indent=2, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    """Write the schema to ``--out`` (a file path, or a directory that gets datum-settings.schema.json)."""
    parser = argparse.ArgumentParser(prog="python -m datum_core.config.schema", description=__doc__)
    parser.add_argument("--out", required=True, type=Path, help="file to write, or a directory")
    args = parser.parse_args(argv)
    target: Path = args.out
    if target.is_dir():
        target = target / SCHEMA_FILE
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(render(), encoding="utf-8")
    sys.stdout.write(f"{target}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Post-checks over the built distributions, standard library only.

    python -I postcheck.py <dist-dir> <version>

Prints one line per problem and exits 1 when there is any. It reads the wheels and sdists the build wrote
and nothing else.
"""

import json
import sys
import tarfile
import zipfile
from pathlib import Path

DISTRIBUTIONS = {
    "argusvane-datum-qjs-wasm": "datum_qjs_wasm",
    "argusvane-datum-programs": "datum_programs",
    "argusvane-datum-assets-ui": "datum_assets_ui",
    "argusvane-datum-assets-pdf": "datum_assets_pdf",
    "argusvane-datum-sandbox": "datum_sandbox",
    "argusvane-datum-core": "datum_core",
    "argusvane-datum-sandbox-wasmtime": "datum_sandbox_wasmtime",
    "argusvane-datum-fastapi": "datum_fastapi",
}
RESOURCE = {
    "argusvane-datum-qjs-wasm",
    "argusvane-datum-programs",
    "argusvane-datum-assets-ui",
    "argusvane-datum-assets-pdf",
}
ABI_FLOORS = {"sandboxAbi": (3, 0, 0), "pdfAbi": (4, 0, 0)}
LICENCE_FILES = ("LICENSE", "NOTICE")
ARGUMENTS = 3


def _triple(text: str) -> tuple[int, ...]:
    """Parse a dotted version into a tuple of integers."""
    return tuple(int(part) for part in text.split("."))


def _build_record_problems(name: str, record: dict[str, object], version: str) -> list[str]:
    """Problems in one wheel's datum-build.json: the version, the build id and the ABI floors."""
    problems: list[str] = []
    if record.get("version") != version:
        problems.append(f"{name}: datum-build.json version {record.get('version')!r}, release is {version}")
    if not record.get("buildId"):
        problems.append(f"{name}: datum-build.json has no buildId")
    for key, floor in ABI_FLOORS.items():
        found = record.get(key)
        if not isinstance(found, str) or _triple(found) < floor:
            floor_text = ".".join(map(str, floor))
            problems.append(f"{name}: datum-build.json {key} {found!r} is below {floor_text}")
    return problems


def _stem(name: str, version: str) -> str:
    """Return the file stem `uv build` writes for a distribution: its name with `-` as `_`, then the version."""
    return f"{name.replace('-', '_')}-{version}"


def _wheel_problems(name: str, package: str, version: str, wheel: Path, build_ids: set[str]) -> list[str]:
    """Problems in one wheel: licence files, stray files, the build record and the manifest."""
    stem = _stem(name, version)
    with zipfile.ZipFile(wheel) as archive:
        names = archive.namelist()
        problems = [
            f"{name}: wheel has no dist-info/licenses/{licence}"
            for licence in LICENCE_FILES
            if f"{stem}.dist-info/licenses/{licence}" not in names
        ]
        problems.extend(f"{name}: wheel carries {stray}" for stray in names if stray.endswith(".map"))
        build_path = f"{package}/datum-build.json"
        if build_path not in names:
            problems.append(f"{name}: wheel has no {build_path}")
        else:
            record = json.loads(archive.read(build_path))
            problems.extend(_build_record_problems(name, record, version))
            build_ids.add(str(record.get("buildId")))
    if name in RESOURCE and f"{package}/manifest.json" not in names:
        problems.append(f"{name}: wheel has no {package}/manifest.json")
    return problems


def _sdist_problems(name: str, stem: str, sdist: Path) -> list[str]:
    """Problems in one sdist: the licence files at its root."""
    with tarfile.open(sdist) as archive:
        members = set(archive.getnames())
    return [f"{name}: sdist has no {licence}" for licence in LICENCE_FILES if f"{stem}/{licence}" not in members]


def check(dist: Path, version: str) -> list[str]:
    """Every problem over the built distributions in dist for version; empty when the release may go on."""
    problems: list[str] = []
    build_ids: set[str] = set()
    for name, package in DISTRIBUTIONS.items():
        stem = _stem(name, version)
        wheel, sdist = dist / f"{stem}-py3-none-any.whl", dist / f"{stem}.tar.gz"
        problems.extend(f"{name}: {path.name} is missing" for path in (wheel, sdist) if not path.is_file())
        if wheel.is_file():
            problems.extend(_wheel_problems(name, package, version, wheel, build_ids))
        if sdist.is_file():
            problems.extend(_sdist_problems(name, stem, sdist))
    if len(build_ids) > 1:
        problems.append(f"the distributions disagree on buildId: {sorted(build_ids)}")
    found = sorted(path.name for path in dist.iterdir() if path.suffix == ".whl" or path.name.endswith(".tar.gz"))
    expected = 2 * len(DISTRIBUTIONS)
    if len(found) != expected:
        problems.append(f"expected {expected} files (eight wheels and eight sdists), found {len(found)}")
    return problems


def main(argv: list[str]) -> int:
    """Print one line per problem and answer the exit code."""
    if len(argv) != ARGUMENTS:
        sys.exit("usage: postcheck.py <dist-dir> <version>")
    found = check(Path(argv[1]), argv[2])
    for line in found:
        print(f"postcheck: {line}")
    if found:
        return 1
    print(f"postcheck: {argv[1]}: eight distributions, wheels and sdists, all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

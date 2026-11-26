"""The asset catalog. A request path is only a dictionary key, never a joined path."""

import dataclasses
import hashlib
import importlib
import json
import sys
import zipfile
from collections.abc import Callable, Mapping, Sequence
from importlib import resources
from pathlib import Path
from types import ModuleType

import pytest

from datum_core.http.assets import (
    MEDIA_TYPES,
    RESOURCE_PACKAGES,
    AssetCatalog,
    AssetSource,
    agree_build_ids,
    media_type_for,
    resolve_assets_root,
)
from datum_sandbox.checks import DatumConfigurationError

BUILD = "2c5b10e623d3"
SECRET = b"the secret outside the asset tree"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def make_source(
    base: Path,
    *,
    name: str = "argusvane-datum-assets-ui",
    build_id: str = BUILD,
    files: Mapping[str, bytes] | None = None,
    unlisted: Mapping[str, bytes] | None = None,
    builder: frozenset[str] = frozenset(),
    features: Mapping[str, frozenset[str]] | None = None,
) -> AssetSource:
    """Write a tree under `base/<name>/assets` and describe it, with a secret file next to the tree."""
    root = base / name / "assets"
    listed = files if files is not None else {"datum-form.js": b"export {};\n"}
    for relative, data in {**listed, **(unlisted or {})}.items():
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    (base / name / "secret.txt").write_bytes(SECRET)
    return AssetSource(
        name=name,
        root=root,
        build_id=build_id,
        files={relative: sha(data) for relative, data in listed.items()},
        builder_files=builder,
        features=features or {},
    )


@pytest.fixture
def source(tmp_path: Path) -> AssetSource:
    return make_source(
        tmp_path,
        files={
            "datum-form.js": b"export {};\n",
            "sub/a.js": b"a",
            "MixedCase.js": b"m",
            "datum-builder.js": b"b",
            "builder-fonts/geist.woff2": b"f",
            "datum-pdf.js": b"p",
            "a/long/directory/name/so/the/length/guard/does/not/mask/a/rewrite.js": b"l",
        },
        unlisted={"datum-builder-not-in-the-list.js": b"x"},
        builder=frozenset({"datum-builder.js", "builder-fonts/geist.woff2"}),
        features={"pdf": frozenset({"datum-pdf.js"})},
    )


def catalog_of(
    source: AssetSource,
    *,
    builder_enabled: bool = False,
    omit_features: Sequence[str] = (),
    withheld: Sequence[Callable[[str], bool]] = (),
) -> AssetCatalog:
    return AssetCatalog([source], builder_enabled=builder_enabled, omit_features=omit_features, withheld=withheld)


def test_a_listed_file_is_found_under_the_build_id_with_a_strong_etag_from_the_manifest_hash(
    tmp_path: Path,
) -> None:
    data = b"export {};\n"
    source = make_source(tmp_path, files={"datum-form.js": data})
    source = dataclasses.replace(source, files={"datum-form.js": "ab" * 32})
    found = AssetCatalog([source]).find(BUILD, "datum-form.js")
    assert found is not None
    assert found.path == (source.root / "datum-form.js").resolve()
    assert found.media_type == "text/javascript"
    assert found.etag == '"' + "ab" * 32 + '"'  # the manifest's digest, quoted, never an mtime or a fresh hash
    assert found.size == len(data)
    assert AssetCatalog([source]).build_id == BUILD


def test_the_cache_headers_are_immutable_under_the_build_id_for_the_cache_period(source: AssetSource) -> None:
    found = catalog_of(source).find(BUILD, "datum-form.js")
    assert found is not None
    headers = found.cache_headers(31536000)
    assert headers["ETag"] == found.etag
    assert headers["Cache-Control"] == "public, max-age=31536000, immutable"


def test_a_file_on_disk_that_the_list_does_not_name_is_not_served(source: AssetSource) -> None:
    assert (source.root / "datum-builder-not-in-the-list.js").is_file()
    assert catalog_of(source, builder_enabled=True).find(BUILD, "datum-builder-not-in-the-list.js") is None


def test_a_file_on_disk_beside_the_tree_is_not_served_by_any_spelling(source: AssetSource) -> None:
    beside = source.root.parent / "beside.js"
    beside.write_bytes(b"beside the tree")
    assert beside.is_file()
    catalog = catalog_of(source, builder_enabled=True)
    for spelling in ("beside.js", "../beside.js", "./../beside.js", "sub/../../beside.js", "..%2fbeside.js"):
        assert catalog.find(BUILD, spelling) is None, spelling


def test_a_dot_dot_slash_path_is_only_a_missing_key(source: AssetSource) -> None:
    assert (source.root.parent / "secret.txt").read_bytes() == SECRET  # a join would find it
    assert catalog_of(source).find(BUILD, "../secret.txt") is None
    assert catalog_of(source).find(BUILD, "sub/../datum-form.js") is None
    assert catalog_of(source).find(BUILD, "./datum-form.js") is None


def test_a_percent_encoded_slash_after_dot_dot_is_not_decoded_into_a_traversal(source: AssetSource) -> None:
    assert catalog_of(source).find(BUILD, "..%2fsecret.txt") is None
    assert catalog_of(source).find(BUILD, "..%2Fsecret.txt") is None


def test_percent_encoded_dots_are_not_decoded_into_a_traversal(source: AssetSource) -> None:
    assert catalog_of(source).find(BUILD, "%2e%2e/secret.txt") is None
    assert catalog_of(source).find(BUILD, "%2e%2e%2fsecret.txt") is None
    assert catalog_of(source).find(BUILD, "datum-form.js%2e") is None


def test_a_percent_encoded_character_is_not_decoded_a_second_time(source: AssetSource) -> None:
    # The route hands over the path once decoded; an encoded byte that survives is part of the name and names nothing.
    catalog = catalog_of(source, builder_enabled=True)
    assert catalog.find(BUILD, "sub%2fa.js") is None
    assert catalog.find(BUILD, "sub%2Fa.js") is None
    assert catalog.find(BUILD, "%64atum-form.js") is None
    assert catalog.find(BUILD, "datum-form%2ejs") is None
    assert catalog.find(BUILD, "%2564atum-form.js") is None
    assert catalog.find(BUILD, "builder-fonts%2fgeist.woff2") is None
    assert catalog.find(BUILD, "sub/a.js") is not None  # the spelling that is a key still answers


def test_a_trailing_dot_space_or_slash_is_a_different_name_that_names_nothing(source: AssetSource) -> None:
    catalog = catalog_of(source)
    for spelling in ("datum-form.js.", "datum-form.js ", "datum-form.js/", "sub/a.js/", "sub", "sub/", "", "."):
        assert catalog.find(BUILD, spelling) is None, spelling
    assert catalog.find(BUILD, "datum-form.js") is not None


def test_a_double_slash_absolute_looking_path_is_a_missing_key(source: AssetSource) -> None:
    assert catalog_of(source).find(BUILD, "//etc/passwd") is None
    assert catalog_of(source).find(BUILD, "/etc/passwd") is None
    assert catalog_of(source).find(BUILD, "sub//a.js") is None
    assert catalog_of(source).find(BUILD, "/datum-form.js") is None


def test_a_backslash_is_not_a_separator(source: AssetSource) -> None:
    assert catalog_of(source).find(BUILD, "..\\secret.txt") is None
    assert catalog_of(source).find(BUILD, "sub\\a.js") is None
    assert catalog_of(source).find(BUILD, "builder-fonts\\geist.woff2") is None


def test_a_nul_byte_is_a_missing_key_and_raises_nothing(source: AssetSource) -> None:
    assert catalog_of(source).find(BUILD, "datum-form.js\x00.png") is None
    assert catalog_of(source).find(BUILD, "\x00") is None
    assert catalog_of(source).find(BUILD, "sub/a.js\x00") is None


def test_a_build_id_of_another_release_finds_nothing(source: AssetSource) -> None:
    catalog = catalog_of(source)
    assert catalog.find("000000000000", "datum-form.js") is None
    assert catalog.find("", "datum-form.js") is None
    assert catalog.find(BUILD.upper(), "datum-form.js") is None
    assert catalog.find("nope", "datum-form.js") is None


def test_a_builder_file_is_withheld_while_the_builder_is_off_and_served_when_it_is_on(source: AssetSource) -> None:
    off = catalog_of(source, builder_enabled=False)
    assert off.find(BUILD, "datum-builder.js") is None
    assert off.find(BUILD, "builder-fonts/geist.woff2") is None
    assert off.find(BUILD, "datum-form.js") is not None
    on = catalog_of(source, builder_enabled=True)
    assert on.find(BUILD, "datum-builder.js") is not None
    assert on.find(BUILD, "builder-fonts/geist.woff2") is not None


def test_paths_are_case_sensitive_keys_so_case_folding_finds_nothing(source: AssetSource) -> None:
    assert catalog_of(source).find(BUILD, "DATUM-FORM.JS") is None
    assert catalog_of(source, builder_enabled=False).find(BUILD, "DATUM-BUILDER.JS") is None
    assert catalog_of(source, builder_enabled=True).find(BUILD, "DATUM-BUILDER.JS") is None
    assert catalog_of(source).find(BUILD, "mixedcase.js") is None


def test_an_uppercase_builder_path_is_a_missing_key_with_the_builder_on(source: AssetSource) -> None:
    on = catalog_of(source, builder_enabled=True)
    assert on.find(BUILD, "builder-fonts/GEIST.WOFF2") is None
    assert on.find(BUILD, "Builder-Fonts/geist.woff2") is None
    assert on.find(BUILD, "datum-builder.JS") is None
    assert on.find(BUILD, "builder-fonts/geist.woff2") is not None


def test_a_withheld_callable_is_asked_with_the_case_folded_path_and_wins(source: AssetSource) -> None:
    asked: list[str] = []

    def withhold(path: str) -> bool:
        asked.append(path)
        return path == "mixedcase.js"

    catalog = catalog_of(source, withheld=[withhold])
    assert catalog.find(BUILD, "MixedCase.js") is None
    assert asked == ["mixedcase.js"]
    assert catalog.find(BUILD, "datum-form.js") is not None


def test_a_withheld_callable_that_raises_withholds_the_file(source: AssetSource) -> None:
    def broken(path: str) -> bool:
        raise RuntimeError(path)

    assert catalog_of(source, withheld=[broken]).find(BUILD, "datum-form.js") is None


def test_an_omitted_feature_withholds_its_files(source: AssetSource) -> None:
    assert catalog_of(source).find(BUILD, "datum-pdf.js") is not None
    assert catalog_of(source, omit_features=["pdf"]).find(BUILD, "datum-pdf.js") is None
    assert catalog_of(source, omit_features=["pdf"]).find(BUILD, "datum-form.js") is not None


@pytest.mark.parametrize("length", [4096, 100_000, 1_000_000])
def test_an_overlong_path_is_a_missing_key(source: AssetSource, length: int) -> None:
    assert catalog_of(source).find(BUILD, "a" * length + ".js") is None
    assert catalog_of(source).find(BUILD, "sub/" * (length // 4)) is None


def test_two_distributions_that_disagree_on_the_build_id_stop_the_start_naming_both(tmp_path: Path) -> None:
    ui = make_source(tmp_path, name="argusvane-datum-assets-ui", build_id="aaaaaaaaaaaa")
    pdf = make_source(
        tmp_path, name="argusvane-datum-assets-pdf", build_id="bbbbbbbbbbbb", files={"datum-pdf.js": b"p"}
    )
    with pytest.raises(DatumConfigurationError) as raised:
        AssetCatalog([ui, pdf])
    text = str(raised.value)
    assert "aaaaaaaaaaaa" in text
    assert "bbbbbbbbbbbb" in text
    assert "argusvane-datum-assets-ui" in text
    assert "argusvane-datum-assets-pdf" in text


def test_two_distributions_with_one_build_id_are_one_directory_of_assets(tmp_path: Path) -> None:
    ui = make_source(tmp_path, name="argusvane-datum-assets-ui")
    pdf = make_source(tmp_path, name="argusvane-datum-assets-pdf", files={"datum-pdf.js": b"p"})
    catalog = AssetCatalog([ui, pdf])
    assert catalog.find(BUILD, "datum-form.js") is not None
    found = catalog.find(BUILD, "datum-pdf.js")
    assert found is not None
    assert found.path == (pdf.root / "datum-pdf.js").resolve()


def test_a_builder_file_named_by_one_distribution_is_withheld_wherever_it_lives(tmp_path: Path) -> None:
    ui = make_source(tmp_path, name="argusvane-datum-assets-ui", builder=frozenset({"datum-builder-pdf.js"}))
    pdf = make_source(
        tmp_path, name="argusvane-datum-assets-pdf", files={"datum-builder-pdf.js": b"p", "datum-pdf.js": b"q"}
    )
    assert AssetCatalog([ui, pdf], builder_enabled=False).find(BUILD, "datum-builder-pdf.js") is None
    assert AssetCatalog([ui, pdf], builder_enabled=False).find(BUILD, "datum-pdf.js") is not None
    assert AssetCatalog([ui, pdf], builder_enabled=True).find(BUILD, "datum-builder-pdf.js") is not None


def test_a_zip_import_is_refused_because_the_files_are_not_real_paths(tmp_path: Path) -> None:
    archive = tmp_path / "assets.zip"
    with zipfile.ZipFile(archive, "w") as handle:
        handle.writestr("assets/datum-form.js", "export {};")
    with pytest.raises(DatumConfigurationError, match="zip"):
        resolve_assets_root(zipfile.Path(archive, "assets/"))


def test_a_real_directory_resolves_to_itself(tmp_path: Path) -> None:
    assert resolve_assets_root(tmp_path) == tmp_path


# ---- the installed resource distributions --------------------------------------------------------------------------
INSTALLED = ("datum_assets_ui", "datum_assets_pdf")


def shipped_files() -> dict[str, dict[str, str]]:
    """`files.json` of each installed asset distribution: path to sha256."""
    found: dict[str, dict[str, str]] = {}
    for package in INSTALLED:
        text = resources.files(package).joinpath("assets", "files.json").read_text(encoding="utf-8")
        found[package] = json.loads(text)["files"]
    return found


def test_the_installed_catalog_serves_every_listed_file_and_withholds_the_builders_until_it_is_on() -> None:
    off = AssetCatalog.installed(builder_enabled=False)
    on = AssetCatalog.installed(builder_enabled=True)
    ui_build = json.loads(resources.files("datum_assets_ui").joinpath("datum-build.json").read_text("utf-8"))["buildId"]
    assert on.build_id == off.build_id == ui_build
    builder = set(
        json.loads(resources.files("datum_assets_ui").joinpath("assets", "builder-files.json").read_text("utf-8"))[
            "files"
        ]
    )
    assert builder
    for files in shipped_files().values():
        for relative, digest in files.items():
            served = on.find(on.build_id, relative)
            assert served is not None, relative
            assert served.etag == f'"{digest}"'
            assert served.path.is_file()
            assert (off.find(off.build_id, relative) is None) == (relative in builder), relative


def test_the_media_type_table_covers_every_extension_the_shipped_trees_contain() -> None:
    uncovered: list[str] = []
    for files in shipped_files().values():
        for relative in files:
            try:
                media_type_for(relative)
            except LookupError:
                uncovered.append(relative)
    assert uncovered == []


def test_the_media_types_are_the_ones_the_table_states() -> None:
    expected = {
        "a.js": "text/javascript",
        "a.mjs": "text/javascript",
        "a.css": "text/css",
        "a.json": "application/json",
        "a.js.map": "application/json",
        "a.wasm": "application/wasm",
        "a.svg": "image/svg+xml",
        "a.woff2": "font/woff2",
        "a.ttf": "font/ttf",
        "a.bcmap": "application/octet-stream",
        "a.icc": "application/octet-stream",
        "a.pfb": "application/octet-stream",
        "a.txt": "text/plain; charset=utf-8",
        "pdfjs/cmaps/LICENSE": "text/plain; charset=utf-8",
        "pdfjs/wasm/LICENSE_PDFJS_QCMS": "text/plain; charset=utf-8",
    }
    assert {path: media_type_for(path) for path in expected} == expected
    assert media_type_for("deep/dir/pdf.worker.min.mjs") == "text/javascript"


def test_an_extension_the_table_lacks_is_a_lookup_error_not_a_guess() -> None:
    for path in ("a.exe", "a.unknown", "noextension", "dir.js/README"):
        with pytest.raises(LookupError):
            media_type_for(path)


def test_the_table_is_explicit_and_does_not_depend_on_the_platform_registry() -> None:
    assert MEDIA_TYPES[".js"] == "text/javascript"
    assert MEDIA_TYPES[".mjs"] == "text/javascript"
    assert ".map" in MEDIA_TYPES


# ---- what the catalog does at start, and what it asks of a callable ------------------------------
def test_a_withheld_callable_is_not_asked_about_a_path_that_names_nothing(source: AssetSource) -> None:
    asked: list[str] = []

    def withhold(path: str) -> bool:
        asked.append(path)
        return False

    catalog = catalog_of(source, withheld=[withhold])
    assert catalog.find(BUILD, "../secret.txt") is None
    assert catalog.find("other-build", "datum-form.js") is None
    assert asked == []  # a miss never reaches application code


def test_a_withheld_callable_that_raises_is_logged_without_the_exception_text(
    source: AssetSource, caplog: pytest.LogCaptureFixture
) -> None:
    def broken(path: str) -> bool:
        raise RuntimeError("secret detail " + path)

    with caplog.at_level("WARNING", logger="datum"):
        assert catalog_of(source, withheld=[broken]).find(BUILD, "datum-form.js") is None
    assert [record.name for record in caplog.records] == ["datum.assets"]
    assert "secret detail" not in caplog.text
    assert "datum-form.js" in caplog.text


def test_the_first_callable_to_withhold_wins_and_the_rest_are_not_asked(source: AssetSource) -> None:
    asked: list[str] = []

    def first(path: str) -> bool:
        asked.append("first")
        return True

    def second(path: str) -> bool:
        asked.append("second")
        return False

    assert catalog_of(source, withheld=[first, second]).find(BUILD, "datum-form.js") is None
    assert asked == ["first"]


def test_a_cache_period_below_zero_is_refused(source: AssetSource) -> None:
    found = catalog_of(source).find(BUILD, "datum-form.js")
    assert found is not None
    assert found.cache_headers(0)["Cache-Control"] == "public, max-age=0, immutable"
    with pytest.raises(ValueError, match="cache_period"):
        found.cache_headers(-1)


def test_an_empty_list_of_sources_is_refused() -> None:
    with pytest.raises(DatumConfigurationError, match="no asset"):
        AssetCatalog([])


@pytest.mark.parametrize(
    ("key", "on_disk"),
    [
        ("a/./b.js", "a/b.js"),
        ("a//b.js", "a/b.js"),
        ("a/../x.js", "x.js"),
        ("./x.js", "x.js"),
        ("a\\b.js", "a\\b.js"),
        ("C:x.js", "C:x.js"),
        ("dir/", "dir/x.js"),
        ("", None),
        ("/abs.js", None),
        ("../x.js", "../x.js"),
        ("nul\x00.js", None),
    ],
)
def test_a_listed_path_that_is_not_a_plain_relative_path_stops_the_start(
    tmp_path: Path, key: str, on_disk: str | None
) -> None:
    if sys.platform == "win32" and on_disk is not None and ("\\" in on_disk or ":" in on_disk):
        pytest.skip("not a legal file name on Windows")
    source = make_source(tmp_path)
    if on_disk is not None:
        target = source.root / on_disk
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"x")  # the file exists, so only the key check can refuse the entry
    bad = dataclasses.replace(source, files={**source.files, key: sha(b"x")})
    with pytest.raises(DatumConfigurationError, match="not a plain relative path") as raised:
        AssetCatalog([bad])
    assert "argusvane-datum-assets-ui" in str(raised.value)


def test_a_listed_file_that_is_missing_stops_the_start_naming_it(tmp_path: Path) -> None:
    source = make_source(tmp_path)
    missing = dataclasses.replace(source, files={**source.files, "gone.js": sha(b"x")})
    with pytest.raises(DatumConfigurationError, match=r"gone\.js"):
        AssetCatalog([missing])


def test_a_listed_directory_is_not_a_file(tmp_path: Path) -> None:
    source = make_source(tmp_path)
    (source.root / "adir.js").mkdir()
    listed = dataclasses.replace(source, files={**source.files, "adir.js": sha(b"x")})
    with pytest.raises(DatumConfigurationError, match="not a file"):
        AssetCatalog([listed])


@pytest.mark.skipif(sys.platform == "win32", reason="symbolic links need a privilege on Windows")
def test_a_listed_file_that_is_a_link_out_of_the_tree_stops_the_start(tmp_path: Path) -> None:
    source = make_source(tmp_path)
    (source.root / "escape.js").symlink_to(source.root.parent / "secret.txt")
    linked = dataclasses.replace(source, files={**source.files, "escape.js": sha(SECRET)})
    with pytest.raises(DatumConfigurationError, match=r"escape\.js"):
        AssetCatalog([linked])


@pytest.mark.skipif(sys.platform == "win32", reason="symbolic links need a privilege on Windows")
def test_a_link_that_stays_inside_the_tree_is_served(tmp_path: Path) -> None:
    source = make_source(tmp_path)
    (source.root / "alias.js").symlink_to(source.root / "datum-form.js")
    linked = dataclasses.replace(source, files={**source.files, "alias.js": sha(b"export {};\n")})
    found = AssetCatalog([linked]).find(BUILD, "alias.js")
    assert found is not None
    assert found.path == (source.root / "datum-form.js").resolve()


@pytest.mark.skipif(sys.platform == "win32", reason="symbolic links need a privilege on Windows")
def test_the_catalog_serves_the_real_path_it_checked_not_a_link_that_is_retargeted_later(tmp_path: Path) -> None:
    source = make_source(tmp_path, files={"datum-form.js": b"export {};\n", "real.js": b"r"})
    link = source.root / "link.js"
    link.symlink_to(source.root / "real.js")
    linked = dataclasses.replace(source, files={**source.files, "link.js": sha(b"r")})
    found = AssetCatalog([linked]).find(BUILD, "link.js")
    assert found is not None
    link.unlink()
    link.symlink_to(source.root.parent / "secret.txt")  # re-pointed after the start
    assert found.path.read_bytes() == b"r"
    assert found.path == (source.root / "real.js").resolve()


def test_a_listed_file_whose_extension_the_table_lacks_stops_the_start_naming_it(tmp_path: Path) -> None:
    source = make_source(tmp_path, files={"datum-form.js": b"x", "tool.exe": b"MZ"})
    with pytest.raises(DatumConfigurationError, match=r"tool\.exe"):
        AssetCatalog([source])


def test_the_same_path_in_two_distributions_stops_the_start_naming_both(tmp_path: Path) -> None:
    ui = make_source(tmp_path, name="argusvane-datum-assets-ui")
    pdf = make_source(tmp_path, name="argusvane-datum-assets-pdf")  # also lists datum-form.js
    with pytest.raises(DatumConfigurationError) as raised:
        AssetCatalog([ui, pdf])
    assert "datum-form.js" in str(raised.value)
    assert "argusvane-datum-assets-ui" in str(raised.value)
    assert "argusvane-datum-assets-pdf" in str(raised.value)


def test_two_paths_that_differ_only_by_case_stop_the_start(tmp_path: Path) -> None:
    source = make_source(tmp_path, files={"A.js": b"a", "a.js": b"b"})
    with pytest.raises(DatumConfigurationError, match="case"):
        AssetCatalog([source])


def test_the_digest_of_a_listed_file_must_look_like_a_sha256(tmp_path: Path) -> None:
    source = make_source(tmp_path)
    for digest in ("", "ABC", "z" * 64, "a" * 63, 'a"b' + "c" * 61):
        bad = dataclasses.replace(source, files={"datum-form.js": digest})
        with pytest.raises(DatumConfigurationError, match="sha256"):
            AssetCatalog([bad])


def test_a_digest_in_upper_case_is_served_as_lower_case(tmp_path: Path) -> None:
    source = make_source(tmp_path)
    upper = dataclasses.replace(source, files={"datum-form.js": "AB" * 32})
    found = AssetCatalog([upper]).find(BUILD, "datum-form.js")
    assert found is not None
    assert found.etag == '"' + "ab" * 32 + '"'


def test_a_build_id_that_is_not_a_plain_token_is_refused(tmp_path: Path) -> None:
    for build_id in ("", "a/b", "..", "a b", "x" * 65):
        with pytest.raises(DatumConfigurationError, match="build"):
            AssetCatalog([make_source(tmp_path, build_id=build_id)])


# ---- reading a distribution -----------------------------------------------------------------------------------------
def write_package(
    base: Path,
    name: str,
    *,
    build_id: str | None = BUILD,
    files: Mapping[str, bytes] | None = None,
    builder: Sequence[str] = (),
    listing: bool = True,
    builder_listing: bool = True,
) -> None:
    """A throwaway importable package with the layout the asset script writes."""
    package = base / name
    (package / "assets").mkdir(parents=True)
    (package / "__init__.py").write_text("", encoding="utf-8")
    if build_id is not None:
        (package / "datum-build.json").write_text(json.dumps({"buildId": build_id}), encoding="utf-8")
    listed = files if files is not None else {"datum-form.js": b"export {};\n"}
    for relative, data in listed.items():
        target = package / "assets" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    if listing:
        digests = {relative: sha(data) for relative, data in listed.items()}
        (package / "assets" / "files.json").write_text(json.dumps({"files": digests}), encoding="utf-8")
    if builder_listing:
        (package / "assets" / "builder-files.json").write_text(json.dumps({"files": list(builder)}), encoding="utf-8")


def import_from(base: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Make the throwaway packages under `base` importable for this test only."""
    monkeypatch.setattr(sys, "path", [str(base), *sys.path])
    importlib.invalidate_caches()


def test_a_distribution_is_read_from_its_build_file_its_file_list_and_its_builder_list(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_package(
        tmp_path,
        "fake_assets_a",
        files={"datum-form.js": b"x", "datum-builder.js": b"y"},
        builder=["datum-builder.js"],
    )
    import_from(tmp_path, monkeypatch)
    source = AssetSource.from_package("fake_assets_a", name="datum-assets-fake")
    assert source.name == "datum-assets-fake"
    assert source.build_id == BUILD
    assert source.root == tmp_path / "fake_assets_a" / "assets"
    assert source.files == {"datum-form.js": sha(b"x"), "datum-builder.js": sha(b"y")}
    assert source.builder_files == frozenset({"datum-builder.js"})
    assert AssetCatalog([source]).find(BUILD, "datum-builder.js") is None
    assert AssetCatalog([source], builder_enabled=True).find(BUILD, "datum-builder.js") is not None


def test_a_distribution_without_a_file_list_or_build_file_stops_the_start_naming_the_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_package(tmp_path, "fake_assets_nolist", listing=False)
    write_package(tmp_path, "fake_assets_nobuild", build_id=None)
    import_from(tmp_path, monkeypatch)
    with pytest.raises(DatumConfigurationError, match=r"files\.json"):
        AssetSource.from_package("fake_assets_nolist", name="datum-assets-fake")
    with pytest.raises(DatumConfigurationError, match=r"datum-build\.json"):
        AssetSource.from_package("fake_assets_nobuild", name="datum-assets-fake")


def test_a_file_list_that_is_not_the_documented_shape_stops_the_start(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_package(tmp_path, "fake_assets_shape")
    listing = tmp_path / "fake_assets_shape" / "assets" / "files.json"
    import_from(tmp_path, monkeypatch)
    for text in ("not json", "[]", '{"files": []}', '{"files": {"a.js": 3}}', '{"nofiles": {}}'):
        listing.write_text(text, encoding="utf-8")
        with pytest.raises(DatumConfigurationError, match=r"files\.json"):
            AssetSource.from_package("fake_assets_shape", name="datum-assets-fake")


def test_a_distribution_that_is_not_installed_is_a_start_error_naming_it() -> None:
    with pytest.raises(DatumConfigurationError, match="no_such_assets_package"):
        AssetSource.from_package("no_such_assets_package", name="datum-assets-fake")


def test_the_installed_catalog_knows_the_pdf_feature_as_the_whole_pdf_distribution() -> None:
    off = AssetCatalog.installed(omit_features=["pdf"])
    pdf_files = shipped_files()["datum_assets_pdf"]
    ui_files = shipped_files()["datum_assets_ui"]
    assert pdf_files
    assert all(off.find(off.build_id, relative) is None for relative in pdf_files)
    builder = set(
        json.loads(resources.files("datum_assets_ui").joinpath("assets", "builder-files.json").read_text("utf-8"))[
            "files"
        ]
    )
    assert all(off.find(off.build_id, relative) is not None for relative in ui_files if relative not in builder)
    assert AssetCatalog.installed().find(off.build_id, "datum-pdf.js") is not None


def test_the_installed_catalog_refuses_a_programs_distribution_of_another_build(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The build-id agreement covers the program distribution too, though it serves no file.
    write_package(tmp_path, "fake_programs", build_id="ffffffffffff", files={})
    import_from(tmp_path, monkeypatch)
    with pytest.raises(DatumConfigurationError) as raised:
        AssetCatalog.installed(agreeing=["fake_programs"])
    text = str(raised.value)
    assert "ffffffffffff" in text
    assert installed_build_id() in text
    assert "fake_programs" in text


def installed_build_id() -> str:
    text = resources.files("datum_assets_ui").joinpath("datum-build.json").read_text("utf-8")
    return str(json.loads(text)["buildId"])


def test_a_distribution_imported_from_a_zip_is_refused_naming_zip(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive = tmp_path / "zipped.zip"
    with zipfile.ZipFile(archive, "w") as handle:
        handle.writestr("zipped_assets/__init__.py", "")
        handle.writestr("zipped_assets/datum-build.json", json.dumps({"buildId": BUILD}))
        handle.writestr("zipped_assets/assets/files.json", json.dumps({"files": {"datum-form.js": sha(b"x")}}))
        handle.writestr("zipped_assets/assets/datum-form.js", "x")
    monkeypatch.setattr(sys, "path", [str(archive), *sys.path])
    importlib.invalidate_caches()
    with pytest.raises(DatumConfigurationError, match="zip"):
        AssetSource.from_package("zipped_assets", name="datum-assets-zip")


def test_a_builder_list_that_a_ui_distribution_lacks_stops_the_start_naming_the_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_package(tmp_path, "fake_assets_nobuilderlist", builder_listing=False)
    import_from(tmp_path, monkeypatch)
    with pytest.raises(DatumConfigurationError, match=r"builder-files\.json"):
        AssetSource.from_package("fake_assets_nobuilderlist", name="datum-assets-fake", holds_builder_list=True)
    source = AssetSource.from_package("fake_assets_nobuilderlist", name="datum-assets-fake")
    assert source.builder_files == frozenset()


@pytest.mark.parametrize("spelling", ["assets/datum-builder.js", "Datum-Builder.js", "datum-builder.js "])
def test_a_builder_name_that_no_file_list_holds_stops_the_start_naming_it(tmp_path: Path, spelling: str) -> None:
    source = make_source(
        tmp_path, files={"datum-form.js": b"x", "datum-builder.js": b"b"}, builder=frozenset({spelling})
    )
    with pytest.raises(DatumConfigurationError, match="names files no file list holds") as raised:
        AssetCatalog([source])
    assert repr(spelling) in str(raised.value)
    assert "argusvane-datum-assets-ui" in str(raised.value)


def test_every_builder_name_the_installed_ui_distribution_lists_is_a_file_of_a_file_list() -> None:
    text = resources.files("datum_assets_ui").joinpath("assets", "builder-files.json").read_text("utf-8")
    names = set(json.loads(text)["files"])
    held = {name for files in shipped_files().values() for name in files}
    assert names
    assert names <= held


def test_an_omit_feature_token_no_distribution_lists_stops_the_start_naming_it(source: AssetSource) -> None:
    with pytest.raises(DatumConfigurationError) as raised:
        catalog_of(source, omit_features=["journeys", "pdf"])
    assert "'journeys'" in str(raised.value)
    assert "'pdf'" not in str(raised.value)


def test_omit_feature_tokens_compare_casefolded(source: AssetSource) -> None:
    catalog = catalog_of(source, omit_features=["PDF"])
    assert catalog.find(BUILD, "datum-pdf.js") is None
    assert catalog.find(BUILD, "datum-form.js") is not None
    folded = dataclasses.replace(source, features={"PDF": frozenset({"datum-pdf.js"})})
    assert catalog_of(folded, omit_features=["pdf"]).find(BUILD, "datum-pdf.js") is None


def test_a_feature_listed_by_one_distribution_withholds_files_of_another(tmp_path: Path) -> None:
    ui = make_source(tmp_path, name="argusvane-datum-assets-ui", features={"pdf": frozenset({"datum-pdf.js"})})
    pdf = make_source(tmp_path, name="argusvane-datum-assets-pdf", files={"datum-pdf.js": b"p"})
    assert AssetCatalog([ui, pdf], omit_features=["pdf"]).find(BUILD, "datum-pdf.js") is None
    assert AssetCatalog([ui, pdf]).find(BUILD, "datum-pdf.js") is not None


def write_features(base: Path, name: str, document: object) -> None:
    (base / name / "assets" / "feature-files.json").write_text(json.dumps(document), encoding="utf-8")


def test_a_distribution_reads_its_feature_files_and_aliases(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    write_package(tmp_path, "fake_assets_features", files={"a.js": b"a", "b.js": b"b", "c.js": b"c"})
    write_features(
        tmp_path,
        "fake_assets_features",
        {
            "features": {
                "journeys": {"files": ["a.js", "b.js"]},
                "print": {"files": []},
                "signing": {"files": [], "aliasOf": "webauthn"},
                "webauthn": {"files": ["c.js"]},
            },
            "aliases": {"signing": "webauthn"},
        },
    )
    import_from(tmp_path, monkeypatch)
    source = AssetSource.from_package("fake_assets_features", name="datum-assets-fake")
    assert source.features == {
        "journeys": frozenset({"a.js", "b.js"}),
        "print": frozenset(),
        "signing": frozenset({"c.js"}),
        "webauthn": frozenset({"c.js"}),
    }
    off = AssetCatalog([source], omit_features=["Signing", "print"])
    assert off.find(BUILD, "c.js") is None
    assert off.find(BUILD, "a.js") is not None


@pytest.mark.parametrize(
    "document",
    ["[]", '{"features": []}', '{"features": {"a": {"files": [1]}}}', '{"features": {"a": {}}}',
     '{"features": {}, "aliases": {"x": "missing"}}', '{"features": {}, "aliases": []}'],
)  # fmt: skip
def test_a_feature_list_that_is_not_the_documented_shape_stops_the_start(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, document: str
) -> None:
    write_package(tmp_path, "fake_assets_badfeatures")
    (tmp_path / "fake_assets_badfeatures" / "assets" / "feature-files.json").write_text(document, encoding="utf-8")
    import_from(tmp_path, monkeypatch)
    with pytest.raises(DatumConfigurationError, match=r"feature-files\.json"):
        AssetSource.from_package("fake_assets_badfeatures", name="datum-assets-fake")


def test_every_token_of_the_shipped_feature_list_withholds_its_files_in_the_installed_catalog() -> None:
    text = resources.files("datum_assets_ui").joinpath("assets", "feature-files.json").read_text("utf-8")
    document = json.loads(text)
    tokens = sorted(document["features"])
    assert "journeys" in tokens
    held = {name for files in shipped_files().values() for name in files}
    whole = AssetCatalog.installed()
    for token in tokens:
        owned = set(document["features"][document.get("aliases", {}).get(token, token)]["files"]) & held
        off = AssetCatalog.installed(omit_features=[token.upper()])
        for relative in owned:
            assert off.find(off.build_id, relative) is None, (token, relative)
            assert whole.find(whole.build_id, relative) is not None or relative in builder_names(), relative


def builder_names() -> set[str]:
    text = resources.files("datum_assets_ui").joinpath("assets", "builder-files.json").read_text("utf-8")
    return set(json.loads(text)["files"])


def test_the_shipped_ui_file_list_lists_the_feature_list() -> None:
    listed = json.loads(resources.files("datum_assets_ui").joinpath("assets", "files.json").read_text("utf-8"))["files"]
    assert "feature-files.json" in listed


def test_the_installed_catalog_refuses_an_unknown_omit_token_naming_it() -> None:
    with pytest.raises(DatumConfigurationError, match="no-such-feature"):
        AssetCatalog.installed(omit_features=["no-such-feature"])


def test_the_installed_catalog_withholds_the_pdf_distribution_for_the_pdf_pages_token() -> None:
    off = AssetCatalog.installed(omit_features=["pdf-pages"])
    pdf_files = shipped_files()["datum_assets_pdf"]
    assert pdf_files
    assert all(off.find(off.build_id, relative) is None for relative in pdf_files)


def restore_module(name: str, original: ModuleType | None) -> None:
    """Undo a throwaway package's import: drop it, put back the module that was loaded before (if any)."""
    sys.modules.pop(name, None)
    if original is not None:
        sys.modules[name] = original


@pytest.mark.parametrize("package", ["datum_programs", "datum_qjs_wasm"])
def test_the_default_agreement_covers_the_programs_and_the_qjs_distributions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, request: pytest.FixtureRequest, package: str
) -> None:
    write_package(tmp_path, package, build_id="ffffffffffff", files={})
    import_from(tmp_path, monkeypatch)
    original = sys.modules.pop(package, None)
    request.addfinalizer(lambda: restore_module(package, original))
    with pytest.raises(DatumConfigurationError) as raised:
        AssetCatalog.installed()
    text = str(raised.value)
    assert f"{package} is build ffffffffffff" in text
    assert installed_build_id() in text


# ---- the public build-id agreement -----------------------------------------------------------------------------------
def test_the_build_id_agreement_needs_no_catalog_and_takes_the_callers_markers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, request: pytest.FixtureRequest
) -> None:
    write_package(tmp_path, "fake_agree_a", build_id="aaaaaaaaaaaa", files={})
    import_from(tmp_path, monkeypatch)
    request.addfinalizer(lambda: sys.modules.pop("fake_agree_a", None))
    own = AssetSource.build_marker("fake_agree_a", name="fake-agree-a")
    assert agree_build_ids(packages=[("fake_agree_a", "fake-agree-a")]) == "aaaaaaaaaaaa"
    assert agree_build_ids(packages=[], markers=[own]) == "aaaaaaaaaaaa"
    other = dataclasses.replace(own, name="argusvane-datum-core", build_id="bbbbbbbbbbbb")
    with pytest.raises(DatumConfigurationError) as raised:
        agree_build_ids(packages=[("fake_agree_a", "fake-agree-a")], markers=[other])
    assert "fake-agree-a is build aaaaaaaaaaaa" in str(raised.value)
    assert "argusvane-datum-core is build bbbbbbbbbbbb" in str(raised.value)


def test_the_build_id_agreement_with_nothing_installed_is_a_start_error() -> None:
    with pytest.raises(DatumConfigurationError, match="no Datum resource distribution"):
        agree_build_ids(packages=[("no_such_distribution_package", "none")])


def test_the_default_packages_of_the_agreement_name_the_four_resource_distributions() -> None:
    assert [package for package, _ in RESOURCE_PACKAGES] == [
        "datum_assets_ui",
        "datum_assets_pdf",
        "datum_programs",
        "datum_qjs_wasm",
    ]
    assert agree_build_ids() == installed_build_id()


def test_the_qjs_distribution_on_another_build_fails_the_public_agreement(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, request: pytest.FixtureRequest
) -> None:
    write_package(tmp_path, "datum_qjs_wasm", build_id="ffffffffffff", files={})
    import_from(tmp_path, monkeypatch)
    original = sys.modules.pop("datum_qjs_wasm", None)
    request.addfinalizer(lambda: restore_module("datum_qjs_wasm", original))
    with pytest.raises(DatumConfigurationError) as raised:
        agree_build_ids()
    assert "argusvane-datum-qjs-wasm is build ffffffffffff" in str(raised.value)

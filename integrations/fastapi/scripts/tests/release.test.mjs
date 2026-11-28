// The release script's --check-pins mode and postcheck.py over a small fake dist. Run: node --test integrations/fastapi/scripts/tests
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { readMembers } from "../release-lib.mjs";

const scripts = join(dirname(fileURLToPath(import.meta.url)), "..");
const release = join(scripts, "release.mjs");
const postcheck = join(scripts, "postcheck.py");

test("release.mjs --check-pins --version 9.9.9 fails and names every member", () => {
  const result = spawnSync("node", [release, "--check-pins", "--version", "9.9.9"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  for (const member of readMembers()) {
    assert.ok(result.stderr.includes(`${member.name}: version`), member.name);
  }
});

test("release.mjs records and prints the umbrella tag v<version>, not a fastapi- family tag", () => {
  const source = readFileSync(release, "utf8");
  assert.match(source, /tag: `v\$\{version\}`/);
  assert.match(source, /Do not push the tag yet: the Maven release comes first/);
  assert.doesNotMatch(source, /git tag v\$\{version\} && git push/);
  assert.doesNotMatch(source, /git tag fastapi-/);
});

test("release.mjs --check-pins without --version passes on the tree", () => {
  const result = spawnSync("node", [release, "--check-pins"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

// A fake dist built by python -I: every distribution gets a wheel and an sdist; `mutate` names one deliberate fault.
const BUILDER = String.raw`
import json, sys, tarfile, zipfile, io
from pathlib import Path
dist, version, fault = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
names = {"argusvane-datum-qjs-wasm": "datum_qjs_wasm", "argusvane-datum-programs": "datum_programs", "argusvane-datum-assets-ui": "datum_assets_ui",
         "argusvane-datum-assets-pdf": "datum_assets_pdf", "argusvane-datum-sandbox": "datum_sandbox", "argusvane-datum-core": "datum_core", "argusvane-datum-sandbox-wasmtime": "datum_sandbox_wasmtime",
         "argusvane-datum-fastapi": "datum_fastapi"}
resource = {"datum_qjs_wasm", "datum_programs", "datum_assets_ui", "datum_assets_pdf"}
for dist_name, pkg in names.items():
    stem = f"{dist_name.replace('-', '_')}-{version}"  # the stem uv build writes: the distribution name, not the import
    record = {"version": version, "buildId": "b1", "sandboxAbi": "1.0.0", "pdfAbi": "1.0.0"}
    if fault == "version" and pkg == "datum_core": record["version"] = "0.0.0"
    if fault == "abi" and pkg == "datum_core": record["pdfAbi"] = "0.18.0"
    with zipfile.ZipFile(dist / f"{stem}-py3-none-any.whl", "w") as z:
        z.writestr(f"{pkg}/datum-build.json", json.dumps(record))
        if pkg in resource: z.writestr(f"{pkg}/manifest.json", "{}")
        z.writestr(f"{stem}.dist-info/licenses/LICENSE", "x")
        if not (fault == "notice" and pkg == "datum_core"): z.writestr(f"{stem}.dist-info/licenses/NOTICE", "x")
        if fault == "map" and pkg == "datum_core": z.writestr(f"{pkg}/a.js.map", "{}")
    with tarfile.open(dist / f"{stem}.tar.gz", "w:gz") as t:
        for n in ("LICENSE", "NOTICE"):
            info = tarfile.TarInfo(f"{stem}/{n}"); data = b"x"; info.size = 1; t.addfile(info, io.BytesIO(data))
if fault == "count": (dist / "extra-1.0-py3-none-any.whl").write_bytes(b"")
`;

const postcheckOutcome = (fault) => {
  const dir = mkdtempSync(join(tmpdir(), "datum-postcheck-"));
  try {
    const script = join(dir, "build.py");
    writeFileSync(script, BUILDER);
    const dist = join(dir, "dist");
    spawnSync("mkdir", [dist]);
    const built = spawnSync("python3", ["-I", script, dist, "0.1.0", fault], { encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    return spawnSync("python3", ["-I", postcheck, dist, "0.1.0"], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("postcheck accepts a complete fake dist", () => {
  const result = postcheckOutcome("none");
  assert.equal(result.status, 0, result.stdout);
});

for (const [fault, pattern] of [
  ["notice", /argusvane-datum-core: wheel has no dist-info\/licenses\/NOTICE/],
  ["version", /argusvane-datum-core: datum-build\.json version '0\.0\.0', release is 0\.1\.0/],
  ["abi", /argusvane-datum-core: datum-build\.json pdfAbi '0\.18\.0' is below 1\.0\.0/],
  ["map", /argusvane-datum-core: wheel carries datum_core\/a\.js\.map/],
  ["count", /expected 16 files .*found 17/]
]) {
  test(`postcheck reports ${fault}`, () => {
    const result = postcheckOutcome(fault);
    assert.equal(result.status, 1);
    assert.match(result.stdout, pattern);
  });
}

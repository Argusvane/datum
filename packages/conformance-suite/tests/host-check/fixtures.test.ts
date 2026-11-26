import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { capabilityOf } from "../../src/host-check/capabilities.js";
import { runHostCheckCli } from "../../src/host-check/cli.js";
import * as fixtures from "../../src/host-check/fixtures.js";
import { PACKAGE_ROOT, REPO_ROOT } from "../helpers/paths.js";

const JAVA_RESOURCES = join(REPO_ROOT, "integrations/jvm/tck/datum-host-tck/src/main/resources/META-INF/datum-tck");
const OWN = join(PACKAGE_ROOT, "src/host-check/fixtures");

describe("the kit's fixtures (KitTest.theFixturesAreTheSuitesControlVectors, theHardeningResourcesAreInTheJar)", () => {
  // The suite is the home of the two hostile files; the Java kit's copies must stay byte for byte equal while both exist.
  for (const name of ["hardening-rules.js", "stale-program.js", "fixture-pdf-theme.json", "host-context-form.json"]) {
    it.skipIf(!existsSync(join(JAVA_RESOURCES, name)))(`${name} is the Java kit's resource byte for byte`, () => {
      expect(readFileSync(join(OWN, name)).equals(readFileSync(join(JAVA_RESOURCES, name)))).toBe(true);
    });
  }

  it("carry the host context fixture the Java kit ships, byte for byte, as the form the host-context cases post", () => {
    const text = fixtures.hostContextFormText();
    const form = JSON.parse(text) as { id: string; version: string; journey: { journeys: { id: string; pages: { id: string; components: string[] }[] }[] } };
    expect(form.id).toBe(fixtures.HOST_CONTEXT_FORM);
    expect(form.version).toBe(fixtures.HOST_CONTEXT_VERSION);
    // The page the page-scope check names, in the journey the envelope names.
    expect(form.journey.journeys[0]?.id).toBe("main");
    expect(form.journey.journeys[0]?.pages[0]).toMatchObject({ id: "p1", components: ["name", "admin_note"] });
    expect(text).toContain('host.role = \\"admin\\"');
    expect(fixtures.TEST_ROLE_HEADER).toBe("X-Datum-Test-Role");
    // The Java kit's resource is the very file (skipped when the repository's Java tree is not present).
    const java = join(JAVA_RESOURCES, "host-context-form.json");
    if (existsSync(java)) expect(Buffer.from(text).equals(readFileSync(java))).toBe(true);
  });

  it("carry the PDF theme the per-route case looks for in the PDF", () => {
    const theme = fixtures.pdfTheme();
    expect(theme["id"]).toBe(fixtures.PDF_THEME_ID);
    expect(theme["target"]).toBe("pdf");
    expect((theme["pdf"] as { colors: { text: string } }).colors.text).toBe(fixtures.PDF_THEME_TEXT);
  });

  it("are the suite's control vectors", () => {
    expect(fixtures.form()["id"]).toBe(fixtures.FORM);
    expect(fixtures.form()["version"]).toBe(fixtures.VERSION);
    expect(fixtures.goldenErrors("CTL-02")).toEqual(["required@name"]);
    expect((fixtures.golden() as { controls: Record<string, { accepted: boolean }> }).controls["CTL-01"]?.accepted).toBe(true);
    expect((fixtures.envelope("CTL-04")["submission"] as { values: { code: string } }).values.code).toBe("abc");
    expect(fixtures.wrapped(fixtures.envelope("CTL-01")).startsWith('{"document":{"versionContext":')).toBe(true);
    expect(fixtures.formText()).toContain(fixtures.SECRET_MARKER);
  });

  it("writes the very text Jackson's ObjectNode.toString() writes for a control document", () => {
    expect(fixtures.wrapped(fixtures.envelope("CTL-02"))).toBe(
      '{"document":{"versionContext":{"form":{"id":"datum-security-suite","version":"1"},"client":{"runtimeVersion":"x","rendererVersion":"x","schemaVersion":"1"}},' +
        '"submission":{"locale":"en","values":{"name":"","code":"AB1234","addr":{"city":"Ottawa","pick":"ok"},"tags":{"x":true,"y":false},"rows":[{"sku":"s1","n":1}]}}}}'
    );
    expect(fixtures.codes([{ code: "required", field: "name" }, { code: "pattern" }, { code: "required", field: "name" }])).toEqual(["pattern@", "required@name"]);
  });

  it("carries the hostile rule module and the stale program", () => {
    const rules = fixtures.hardeningRules();
    expect(rules.startsWith("({")).toBe(true);
    for (const trigger of [fixtures.LOOP, fixtures.MEMORY, fixtures.HUGE, fixtures.STRAY]) {
      expect(rules).toContain(trigger);
      // It fits the fixture's name (maxLength 40).
      expect(trigger.length).toBeLessThanOrEqual(40);
    }
    expect(fixtures.staleProgram()).toContain('"2.11.0"');
    expect(capabilityOf("hardening")).toBe("hardening");
  });

  it("are written out by `fixtures --out`, byte for byte", async () => {
    const out = mkdtempSync(join(tmpdir(), "datum-host-check-fixtures-"));
    try {
      let text = "";
      const code = await runHostCheckCli(["fixtures", "--out", out], { stdout: (chunk) => void (text += chunk), stderr: () => undefined });
      expect(code).toBe(0);
      expect(readFileSync(join(out, "fixture-form.json")).equals(readFileSync(join(PACKAGE_ROOT, "fixtures/endpoint-fixture.definition.json")))).toBe(true);
      const second = JSON.parse(readFileSync(join(out, "fixture-form-b.json"), "utf8")) as Record<string, unknown>;
      expect(second["id"]).toBe(fixtures.FORM_B);
      expect({ ...second, id: fixtures.FORM }).toEqual(fixtures.form());
      expect(readFileSync(join(out, "golden.json")).equals(readFileSync(join(PACKAGE_ROOT, "golden/abi-4.1.json")))).toBe(true);
      expect(readFileSync(join(out, "hardening-rules.js")).equals(readFileSync(join(OWN, "hardening-rules.js")))).toBe(true);
      expect(readFileSync(join(out, "stale-program.js")).equals(readFileSync(join(OWN, "stale-program.js")))).toBe(true);
      expect(readFileSync(join(out, "fixture-pdf-theme.json")).equals(readFileSync(join(OWN, "fixture-pdf-theme.json")))).toBe(true);
      // The host context fixture, under the name the Spring example's notes use, is the Java kit's resource byte for byte.
      const written = readFileSync(join(out, "fixture-host-context-form.json"));
      expect(written.equals(readFileSync(join(OWN, "host-context-form.json")))).toBe(true);
      expect(text).toContain("fixture-host-context-form.json");
      expect(text).toContain("X-Datum-Test-Role");
      if (existsSync(join(JAVA_RESOURCES, "host-context-form.json"))) expect(written.equals(readFileSync(join(JAVA_RESOURCES, "host-context-form.json")))).toBe(true);
      expect(text).toContain("datum.forms.locations");
      expect(await runHostCheckCli(["fixtures"], { stdout: () => undefined, stderr: () => undefined })).toBe(2);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

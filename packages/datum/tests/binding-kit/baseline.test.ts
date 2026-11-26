import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KIT, load } from "./load.js";

const mod = () => load(join(KIT, "lib", "baseline.mjs"));
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kit-baseline-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const env = { platform: "test", browser: "chromium 0" };
const sign = (reviewer: string, date: string): void => {
  const file = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  manifest.signOff.reviewer = reviewer;
  manifest.signOff.date = date;
  writeFileSync(file, JSON.stringify(manifest));
};

describe("tier-2 baselines", () => {
  it("fails a case with no baseline", async () => {
    const { baselineStatus } = await mod();
    expect(baselineStatus(dir, "date").state).toBe("missing");
  });

  it("writes candidates with the PNG list filled and the reviewer and date blank", async () => {
    const { writeCandidates, readManifest, baselineStatus, sha256 } = await mod();
    const bytes = Buffer.from("png-one");
    const result = writeCandidates(dir, { date: bytes }, env);
    expect(result.written).toEqual(["date.png"]);
    const manifest = readManifest(dir);
    expect(manifest.signOff.reviewer).toBe("");
    expect(manifest.signOff.date).toBe("");
    expect(manifest.signOff.pngs).toEqual([{ file: "date.png", sha256: sha256(bytes) }]);
    expect(manifest.environment).toEqual(env);
    // Without a sign-off the case fails, however good the picture.
    expect(baselineStatus(dir, "date").state).toBe("unsigned");
  });

  it("accepts only a baseline a person signed off, by reviewer and date", async () => {
    const { writeCandidates, baselineStatus } = await mod();
    writeCandidates(dir, { date: Buffer.from("a") }, env);
    sign("Someone", "");
    expect(baselineStatus(dir, "date").state).toBe("unsigned");
    sign("", "2026-11-09");
    expect(baselineStatus(dir, "date").state).toBe("unsigned");
    sign("Someone", "yesterday");
    expect(baselineStatus(dir, "date").state).toBe("unsigned");
    sign("Someone", "2026-11-09");
    expect(baselineStatus(dir, "date").state).toBe("signed");
  });

  it("refuses a PNG that changed after it was signed off", async () => {
    const { writeCandidates, baselineStatus } = await mod();
    writeCandidates(dir, { date: Buffer.from("a") }, env);
    sign("Someone", "2026-11-09");
    writeFileSync(join(dir, "date.png"), "tampered");
    expect(baselineStatus(dir, "date").state).toBe("changed");
  });

  it("blanks the sign-off when a picture changes and keeps it when nothing did", async () => {
    const { writeCandidates, readManifest, baselineStatus } = await mod();
    writeCandidates(dir, { date: Buffer.from("a") }, env);
    sign("Someone", "2026-11-09");
    writeCandidates(dir, { date: Buffer.from("a") }, env);
    expect(readManifest(dir).signOff.reviewer).toBe("Someone");
    writeCandidates(dir, { date: Buffer.from("b") }, env);
    const manifest = readManifest(dir);
    expect(manifest.signOff.reviewer).toBe("");
    expect(manifest.signOff.date).toBe("");
    expect(baselineStatus(dir, "date").state).toBe("unsigned");
  });

  it("a PNG added after a sign-off is not covered by it", async () => {
    const { writeCandidates, baselineStatus } = await mod();
    writeCandidates(dir, { date: Buffer.from("a") }, env);
    sign("Someone", "2026-11-09");
    writeCandidates(dir, { tabs: Buffer.from("t") }, env);
    // A new picture changed the list, so the record is blank again for every picture.
    expect(baselineStatus(dir, "tabs").state).toBe("unsigned");
    expect(baselineStatus(dir, "date").state).toBe("unsigned");
  });
});

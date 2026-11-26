import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseHostArgs, HostUsageError } from "../../src/host-check/args.js";
import { capabilityOf } from "../../src/host-check/capabilities.js";
import { redactArgv } from "../../src/host-check/report.js";
import { api, csrfOf, parseProperties, targetFrom, TargetError } from "../../src/host-check/target.js";

const targetOf = (argv: string[]) => targetFrom(parseHostArgs(argv).properties);

describe("the target (KitTest.aTargetIsReadFromProperties)", () => {
  it("is read from HostTck's datum.tck.* keys, as arguments and from --config", () => {
    const dir = mkdtempSync(join(tmpdir(), "datum-host-check-config-"));
    try {
      const config = join(dir, "tck.properties");
      writeFileSync(
        config,
        [
          "# the Java kit's keys",
          "datum.tck.base-url=https://forms.example/app/",
          "datum.tck.capabilities = submissions, submissions-test,FLOOD",
          "datum.tck.api-path: /v1",
          "datum.tck.builder-enabled=true",
          "datum.tck.build-form=intake",
          "datum.tck.header.X-Tenant=a",
          "datum.tck.person.header.Authorization=Bearer \\",
          "    p",
          "other.key=ignored"
        ].join("\n")
      );
      const target = targetOf(["--config", config]);
      expect(target.baseUrl).toBe("https://forms.example/app");
      expect(api(target, "/submissions")).toBe("https://forms.example/app/v1/submissions");
      expect(target.assetsPath).toBe("/datum/assets");
      expect(target.capabilities).toEqual(["submissions", "submissions-test", "flood"]);
      expect(target.builderEnabled).toBe(true);
      expect(target.buildForm).toBe("intake");
      expect(target.headers).toEqual({ "X-Tenant": "a" });
      expect(target.personHeaders).toEqual({ Authorization: "Bearer p" });
      expect(target.otherPersonHeaders).toEqual({});
      expect(target.timeoutMs).toBe(120_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("takes the flags as aliases of the keys, the last value winning", () => {
    const target = targetOf([
      "datum.tck.base-url=http://a.example",
      "--endpoint=http://localhost:8080/",
      "--capabilities",
      "forms,assets",
      "--assets-path",
      "/static/datum",
      "--builder-enabled",
      "--pdf-signing=false",
      "--header",
      "X-A=1",
      "--person-header",
      "Authorization: Basic YXV0aG9yOmF1dGhvcg==",
      "--other-person-header",
      "Cookie=SESSION=b",
      "--csrf",
      "cookie:XSRF-TOKEN:X-XSRF-TOKEN",
      "--timeout",
      "5000"
    ]);
    expect(target.baseUrl).toBe("http://localhost:8080");
    expect(target.capabilities).toEqual(["forms", "assets"]);
    expect(target.assetsPath).toBe("/static/datum");
    expect(target.builderEnabled).toBe(true);
    expect(target.pdfSigning).toBe(false);
    expect(target.personHeaders).toEqual({ Authorization: "Basic YXV0aG9yOmF1dGhvcg==" });
    expect(target.otherPersonHeaders).toEqual({ Cookie: "SESSION=b" });
    expect(target.csrf).toEqual({ cookie: "XSRF-TOKEN", header: "X-XSRF-TOKEN" });
    expect(target.timeoutMs).toBe(5000);
  });

  it("refuses what HostTck refuses, and a bit more, as usage errors", () => {
    expect(() => targetOf(["--capabilities", "forms"])).toThrow(/base-url/);
    expect(() => targetOf(["--endpoint", "http://x", "--capabilities", "nope"])).toThrow(TargetError);
    expect(() => targetOf(["--endpoint", "ftp://x", "--capabilities", "forms"])).toThrow(/http/);
    expect(() => targetOf(["--endpoint", "http://u:p@x", "--capabilities", "forms"])).toThrow(/credentials/);
    expect(() => targetOf(["--endpoint", "http://x", "--capabilities", "forms", "--timeout", "0"])).toThrow(/timeout/);
    expect(() => parseHostArgs(["--frobnicate"])).toThrow(HostUsageError);
    expect(() => parseHostArgs(["--endpoint"])).toThrow(/needs a value/);
    expect(() => parseHostArgs(["--header", "novalue"])).toThrow(/Name=Value/);
    expect(() => parseHostArgs(["--builder-enabled=yes"])).toThrow(HostUsageError);
    expect(() => parseHostArgs(["explain"])).toThrow(/case id/);
    expect(() => csrfOf("XSRF-TOKEN")).toThrow(/cookie:/);
    expect(capabilityOf("runtime-down")).toBe("runtime-down");
    expect(capabilityOf("HOST_CONTEXT")).toBe("host-context");
    expect(capabilityOf("SUBMISSIONS_TEST")).toBe("submissions-test");
  });

  it("reads Java .properties escapes and separators", () => {
    const parsed = parseProperties("a=1\n! comment\nb : two words\nc\\ d=x\\u0041\\ty\nempty\n");
    expect([...parsed]).toEqual([
      ["a", "1"],
      ["b", "two words"],
      ["c d", "xA\ty"],
      ["empty", ""]
    ]);
  });

  it("keeps header values out of the report's argv", () => {
    expect(redactArgv(["--header", "Authorization=Bearer x", "--person-header=Cookie: S=1", "datum.tck.other-person.header.Authorization=Basic y", "--endpoint", "http://h"])).toEqual([
      "--header",
      "Authorization=<redacted>",
      "--person-header=Cookie=<redacted>",
      "datum.tck.other-person.header.Authorization=<redacted>",
      "--endpoint",
      "http://h"
    ]);
  });
});

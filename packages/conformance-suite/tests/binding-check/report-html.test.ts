import { describe, expect, it } from "vitest";

// @ts-expect-error The tester's report module is plain JavaScript with no declaration file.
import { html, summarize } from "../../binding-check/lib/report.mjs";

// report.html's header names the design system, the browser the run used and when it started,
// from the same report object cli.mjs writes to report.json.
describe("datum-binding-check: report.html", () => {
  it("names the browser from report.browser in the header", () => {
    const cases = [{ id: "MNT-01", group: "MNT", title: "mounts", status: "pass", message: "", ms: 12, console: [] }];
    const report = {
      tool: "datum-binding-check",
      startedAt: "2026-11-09T12:00:00Z",
      browser: "chromium 158.0.8127.18",
      binding: { name: "gcds", designSystem: "GC Design System" },
      summary: summarize(cases),
      cases,
      console: []
    };
    const page = html(report) as string;
    expect(page).toContain("<p>GC Design System &middot; chromium 158.0.8127.18 &middot; 2026-11-09T12:00:00Z</p>");
  });
});

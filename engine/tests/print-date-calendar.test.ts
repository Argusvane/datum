import { describe, expect, it } from "vitest";

import { formatPrintDate } from "../form-engine/render/print/index.js";

/*
 * A printed date is worded only when it is a real calendar date. Anything else prints as stored,
 * never as the date it would roll over to; and a year below 100 is that year, not one in the 1900s.
 */

describe("a printed date", () => {
  it("prints a date the calendar does not have as stored", () => {
    expect(formatPrintDate("2026-02-30", "en")).toBe("2026-02-30");
    expect(formatPrintDate("2026-13-01", "en")).toBe("2026-13-01");
    expect(formatPrintDate("2026-00-10", "en")).toBe("2026-00-10");
    expect(formatPrintDate("2026-04-31", "en")).toBe("2026-04-31");
    expect(formatPrintDate("2025-02-29", "en")).toBe("2025-02-29");
    expect(formatPrintDate("0000-01-01", "en")).toBe("0000-01-01");
  });

  it("words a real date, a leap day among them", () => {
    expect(formatPrintDate("2026-03-15", "en")).toBe("March 15, 2026");
    expect(formatPrintDate("2024-02-29", "en")).toBe("February 29, 2024");
  });

  it("keeps a year below 100 as written", () => {
    expect(formatPrintDate("0050-06-01", "en", true)).toBe("June 1, 50");
    expect(formatPrintDate("0099-12-31", "en", true)).not.toContain("1999");
  });
});

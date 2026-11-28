import { describe, expect, it } from "vitest";

import { monthNamesFor } from "../form-engine/render/live/datum/month-names.js";

/*
 * The month select names the months of the Gregorian calendar the stored `YYYY-MM-DD` answer is
 * in, even for a locale whose default calendar is another.
 */

describe("month names: the Gregorian calendar", () => {
  it("names January for month 01 in a locale whose default calendar is the Persian one", () => {
    const gregorian = new Intl.DateTimeFormat("fa", { month: "long", timeZone: "UTC", calendar: "gregory" }).format(new Date(Date.UTC(2024, 0, 15)));
    const persian = new Intl.DateTimeFormat("fa", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 15)));
    // The runtime's own data must tell the two calendars apart for the check to mean anything.
    expect(gregorian).not.toBe(persian);
    const names = monthNamesFor("fa");
    expect(names).toHaveLength(12);
    expect(names[0]).toBe(gregorian);
  });

  it("keeps English names for English", () => {
    expect(monthNamesFor("en")[0]).toBe("January");
    expect(monthNamesFor("en")[11]).toBe("December");
  });
});

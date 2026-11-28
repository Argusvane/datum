const EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * Localized month names via `Intl`, of the Gregorian calendar the stored `YYYY-MM-DD` answer is in
 * (a locale whose default calendar is another, such as `fa`, still names January for "01"); a
 * locale the runtime cannot format falls back to English.
 */
export function monthNamesFor(locale: string): string[] {
  try {
    const format = new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC", calendar: "gregory" });
    return Array.from({ length: 12 }, (_, month) => format.format(new Date(Date.UTC(2024, month, 15))));
  } catch {
    return EN_MONTHS;
  }
}

/**
 * What a person types into a text box drawn for a number or a date's month, read into the one
 * format the form stores — in the browser, as the box is read, never in validation: the stored
 * value and every check of it (the client's, the kernel's, a server's) keep to the strict
 * formats (a number, a `YYYY-MM-DD` date with digit parts), and anything this cannot read is
 * kept as typed, so validation still names what is wrong.
 *
 * - A number may be written with its digits grouped — "1,000", "1 000", the form's locale's own
 *   grouping ("1 000" in French) — and with the locale's decimal mark ("2,5" in French).
 * - A month may be written as its name or a short form of it — "February", "feb", "Feb." —
 *   in the form's language or English, as GOV.UK's date input asks services to accept.
 */

const SPACES = /[\s  ]/g;

/** The locale's grouping and decimal marks ("," and "." for English), from Intl; English when unknown. */
function numberMarks(locale: string): { group: string; decimal: string } {
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
    return {
      group: parts.find((part) => part.type === "group")?.value ?? ",",
      decimal: parts.find((part) => part.type === "decimal")?.value ?? "."
    };
  } catch {
    return { group: ",", decimal: "." };
  }
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The number `text` writes, or undefined when it is not one. Digits may be grouped in threes by
 * spaces or the locale's grouping mark (never in other sizes: "1,5" is not 15 in English), and the
 * fraction follows the locale's decimal mark, or "." where "." is not the locale's grouping mark.
 * A first group led by a zero ("0,500", "00,500", "0.500" in German) is never a grouping, so it
 * is not read, even where JavaScript would read it as a fraction. A plain numeral JavaScript
 * reads ("12", "-3.5", "1e3") is read as JavaScript reads it.
 */
export function readTypedNumber(text: string, locale: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const { group, decimal } = numberMarks(locale);
  const groupMarks = new Set([" ", group.replace(SPACES, " ")]);
  const decimals = new Set([decimal]);
  if (!groupMarks.has(".")) decimals.add(".");
  const compact = trimmed.replace(SPACES, " ");
  const groupClass = [...groupMarks].map(escape).join("");
  const decimalClass = [...decimals].filter((mark) => !groupMarks.has(mark)).map(escape).join("");
  if (new RegExp(`^[+-]?0\\d{0,2}(?:[${groupClass}]\\d{3})+(?:[${decimalClass}]\\d+)?$`).test(compact)) {
    return undefined;
  }
  const grouped = new RegExp(`^([+-]?)([1-9]\\d{0,2}(?:[${groupClass}]\\d{3})+|\\d+)(?:[${decimalClass}](\\d+))?$`);
  const match = decimalClass === "" ? null : grouped.exec(compact);
  if (match) {
    const value = Number(`${match[1]}${match[2]!.replace(/\D/g, "")}${match[3] !== undefined ? `.${match[3]}` : ""}`);
    if (Number.isFinite(value)) return value;
  }
  const plain = Number(trimmed);
  return Number.isFinite(plain) ? plain : undefined;
}

const fold = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\.$/, "")
    .trim();

function monthNames(locale: string): string[][] {
  const lists: string[][] = [];
  for (const code of [locale, "en"]) {
    for (const month of ["long", "short"] as const) {
      try {
        const format = new Intl.DateTimeFormat(code, { month, timeZone: "UTC", calendar: "gregory" });
        lists.push(Array.from({ length: 12 }, (_, index) => fold(format.format(new Date(Date.UTC(2024, index, 15))))));
      } catch {
        // An unknown locale: English's names still read.
      }
    }
  }
  return lists;
}

/**
 * The month (1–12) `text` names, or undefined: its digits ("2", "02"), or its name in the form's
 * language or English — whole, the locale's short form, or the first three letters or more of
 * the name when only one month starts so ("sept", "meh" for Mehefin) — ignoring case, accents
 * and a closing full stop.
 */
export function readTypedMonth(text: string, locale: string): number | undefined {
  const trimmed = text.trim();
  if (/^\d{1,2}$/.test(trimmed)) {
    const month = Number(trimmed);
    return month >= 1 && month <= 12 ? month : undefined;
  }
  const typed = fold(trimmed);
  if (typed.length < 3) return undefined;
  const lists = monthNames(locale);
  for (const names of lists) {
    const exact = names.indexOf(typed);
    if (exact >= 0) return exact + 1;
  }
  const starts = new Set<number>();
  for (const names of lists) names.forEach((name, index) => name.startsWith(typed) && starts.add(index + 1));
  return starts.size === 1 ? [...starts][0] : undefined;
}

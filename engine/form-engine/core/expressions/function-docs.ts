/**
 * The formula function library's words: one summary and one example per built-in, keyed by
 * name. Split from `function-table.ts` so the runtime bundle (which needs names, arity and
 * result kinds) never carries them; the builder's autocomplete, the Variables panel and the
 * generated docs read them. A test pins that every table row has an entry.
 */

export interface FormulaFunctionDoc {
  /** One sentence for the autocomplete hint and the docs table. */
  readonly summary: string;
  /** A call as it is written in a formula. */
  readonly example: string;
}

export const FORMULA_FUNCTION_DOCS: Readonly<Record<string, FormulaFunctionDoc>> = {
  coalesce: { summary: "The first argument that is not null or missing.", example: 'coalesce(nickname, firstName, "there")' },
  empty: { summary: "True when the value is missing, blank, an empty list or a group with nothing ticked.", example: "empty(email)" },
  isNumber: { summary: "True when the value is a number or a text that reads as one.", example: "isNumber(quantity)" },
  isDate: { summary: "True when the value is a calendar day written YYYY-MM-DD.", example: "isDate(startDate)" },
  concat: { summary: "Joins the arguments into one text; missing values add nothing.", example: 'concat(firstName, " ", lastName)' },
  len: { summary: "The number of characters in a text or items in a list.", example: "len(postcode)" },
  upper: { summary: "The text in upper case.", example: "upper(postcode)" },
  lower: { summary: "The text in lower case.", example: "lower(email)" },
  titleCase: { summary: "The text with the first letter of each word in upper case.", example: "titleCase(city)" },
  trim: { summary: "The text without spaces at either end.", example: "trim(reference)" },
  startsWith: { summary: "True when the text begins with the prefix.", example: 'startsWith(postcode, "K1")' },
  endsWith: { summary: "True when the text ends with the suffix.", example: 'endsWith(email, ".ca")' },
  contains: { summary: "True when the text contains the needle, or the list holds it as an item.", example: 'contains(languages, "fr")' },
  substring: { summary: "The part of the text from a 1-based position, optionally limited to a length.", example: "substring(sin, 1, 3)" },
  indexOf: { summary: "The 1-based position of the needle in the text or list, or 0 when absent.", example: 'indexOf(email, "@")' },
  replace: { summary: "The text with every occurrence of one piece replaced by another.", example: 'replace(phone, "-", "")' },
  split: { summary: "The text cut at each separator, as a list.", example: 'split(tags, ",")' },
  join: { summary: "The list's items as one text with the separator between them.", example: 'join(selected(languages), ", ")' },
  matches: { summary: "True when the whole text matches the regular expression.", example: 'matches(postcode, "[A-Z]\\d[A-Z] ?\\d[A-Z]\\d")' },
  text: { summary: "The value written as text.", example: "text(total)" },
  padStart: { summary: "The text padded at the start with the fill up to the length.", example: 'padStart(text(invoiceNumber), 6, "0")' },
  sum: { summary: "Adds the arguments; a list argument adds its items.", example: "sum(price, tax)" },
  min: { summary: "The smallest of the arguments; a list argument contributes its items.", example: "min(quote1, quote2)" },
  max: { summary: "The largest of the arguments; a list argument contributes its items.", example: "max(quote1, quote2)" },
  avg: { summary: "The mean of the arguments; a list argument contributes its items.", example: 'avg(pluck(scores, "mark"))' },
  count: { summary: "How many items are selected: a list's length or the ticked boxes of a group.", example: "count(interests)" },
  abs: { summary: "The number without its sign.", example: "abs(balance)" },
  round: { summary: "The number rounded to the nearest whole number.", example: "round(total)" },
  roundTo: { summary: "The number rounded to a count of decimal places.", example: "roundTo(total, 2)" },
  roundUp: { summary: "The number rounded away from zero, optionally at a count of decimal places.", example: "roundUp(hours)" },
  roundDown: { summary: "The number rounded towards zero, optionally at a count of decimal places.", example: "roundDown(hours)" },
  floor: { summary: "The largest whole number not above the number.", example: "floor(ratio)" },
  ceil: { summary: "The smallest whole number not below the number.", example: "ceil(ratio)" },
  modulo: { summary: "The remainder after dividing by the divisor.", example: "modulo(seats, 4)" },
  power: { summary: "The base raised to the exponent.", example: "power(1 + rate, years)" },
  sqrt: { summary: "The square root of the number.", example: "sqrt(area)" },
  clamp: { summary: "The number held between a low and a high bound.", example: "clamp(discount, 0, 100)" },
  number: { summary: "The text read as a number, or nothing when it does not read as one.", example: "number(amountText)" },
  selected: { summary: "The chosen options as a list: a group's ticked boxes, a list as is, one answer alone.", example: "selected(interests)" },
  first: { summary: "The first item of the list.", example: "first(selected(languages))" },
  last: { summary: "The last item of the list.", example: "last(items)" },
  distinct: { summary: "The list without repeated items, first occurrences kept in order.", example: 'distinct(pluck(items, "category"))' },
  sort: { summary: "The list in ascending order, numbers by value and texts by code unit.", example: "sort(scores)" },
  reverse: { summary: "The list in the opposite order.", example: "reverse(sort(scores))" },
  append: { summary: "The list with the item added at the end.", example: 'append(selected(languages), "en")' },
  pluck: { summary: "One column of a repeating section's rows, as a list.", example: 'sum(pluck(items, "amount"))' },
  any: { summary: "True when at least one item of the list is true.", example: 'any(pluck(items, "taxable"))' },
  all: { summary: "True when every item of the list is true.", example: 'all(pluck(items, "confirmed"))' },
  today: { summary: "The host's calendar day, YYYY-MM-DD; nothing when the host supplies none.", example: "dateDiff(startDate, today(), \"days\")" },
  date: { summary: "The text as a calendar day when it is one written YYYY-MM-DD.", example: 'date("2026-01-31")' },
  dateAdd: { summary: "The day moved by an amount of days, weeks, months or years; month ends clamp.", example: 'dateAdd(startDate, 30, "days")' },
  dateDiff: { summary: "The signed whole count of days, weeks, months or years from one day to another.", example: 'dateDiff(startDate, endDate, "days")' },
  year: { summary: "The year of the day.", example: "year(startDate)" },
  month: { summary: "The month of the day, 1 to 12.", example: "month(startDate)" },
  day: { summary: "The day of the month, 1 to 31.", example: "day(startDate)" },
  dayOfWeek: { summary: "The weekday as a number, 1 for Monday to 7 for Sunday.", example: "dayOfWeek(startDate)" },
  startOfMonth: { summary: "The first day of the day's month.", example: "startOfMonth(today())" },
  endOfMonth: { summary: "The last day of the day's month.", example: "endOfMonth(today())" },
  isWeekend: { summary: "True when the day is a Saturday or a Sunday.", example: "isWeekend(startDate)" },
  age: { summary: "Whole years from the date of birth to the host's day; nothing without a day.", example: "age(dateOfBirth) >= 18" },
  rowIndex: { summary: "The 1-based position of the current entry in its repeating section.", example: "rowIndex() = 1" },
  rowCount: { summary: "How many entries the current repeating section holds.", example: "rowIndex() = rowCount()" }
};

import type { ComponentNode, Journey, WasmPlugin } from "@argusvane/datum-engine";

/**
 * A form written in formulas, for the QuickJS vs in-process parity suite (sandbox ABI 2.8.0).
 *
 * Every rule is a FEEL-subset string or the `{ formula, run }` object, and every built-in in
 * the function table is called at least once across the rules (the comment on each field names
 * what it exercises). The fixture also carries a secret required rule, a browser-only visibility
 * rule, a server-only calculation, a browser-only calculation, a journey page whose condition
 * reads `today()`, and a plugin formula function. Each factory returns fresh objects: the kernel
 * must leave the author's definition untouched, and the suite checks that byte for byte.
 */

/** The day most assertions read; `dob` below makes the person 17 on it and 18 on the next. */
export const FORMULA_TODAY = "2026-10-06";
/** The day the journey's `next_year` page turns on. */
export const FORMULA_NEXT_YEAR = "2027-01-01";

type Rules = NonNullable<ComponentNode["rules"]>;

function field(id: string, type: string, rules?: Rules, configuration: Record<string, unknown> = {}): ComponentNode {
  return rules === undefined ? { id, type, configuration } : { id, type, configuration, rules };
}

const value = (formula: string): Rules => ({ value: formula });

/** The plain inputs, in document order. */
export const FORMULA_INPUTS = [
  "first_name",
  "last_name",
  "nickname",
  "email",
  "tags",
  "amount_text",
  "region",
  "amount",
  "rate",
  "dob",
  "options"
] as const;

/** The components whose server-side rules read the clock, in document order. */
export const FORMULA_CLOCK_DEPENDENT = ["age_years", "month_start", "month_end", "days_left", "overdue", "in_window", "adult_note"] as const;

/** The components holding a `server` or `server-secret` rule, in document order. */
export const FORMULA_SERVER_RULES = ["size", "big_reason"] as const;

/** Every calculated field outside the repeating section, in document order. */
export const FORMULA_CALCULATED = [
  "full_name",
  "email_ok",
  "initials",
  "name_len",
  "domain",
  "tag_count",
  "tag_summary",
  "has_a",
  "a_at",
  "fixed_name",
  "amount_label",
  "total",
  "bounds",
  "rounding",
  "parsed",
  "stats",
  "is_num",
  "is_date",
  "picked_count",
  "picked_first",
  "picked_all",
  "tier",
  "bonus",
  "fallback",
  "in_range",
  "age_years",
  "dob_parts",
  "dob_weekend",
  "month_start",
  "month_end",
  "deadline",
  "days_left",
  "overdue",
  "in_window",
  "tax",
  "size",
  "local_note",
  "items_total"
] as const;

/** The fields the `next_year` page holds and the ones every other page holds. */
export const FORMULA_NEXT_YEAR_FIELDS = ["adult_note"] as const;

/** The formula with the unclosed parenthesis the typo fixture carries. */
export const FORMULA_TYPO = "roundTo(amount * rate / 100, 2";

/** The root with every rule a formula. */
export function formulaRoot(): ComponentNode {
  return {
    id: "formulas",
    type: "form",
    configuration: {},
    children: {
      content: [
        field("first_name", "text"),
        field("last_name", "text"),
        field("nickname", "text"),
        field("email", "text", undefined, { required: true }),
        field("tags", "text"),
        field("amount_text", "text"),
        field("region", "text"),
        field("amount", "number"),
        field("rate", "number"),
        field("dob", "date"),
        field("options", "checkboxes", undefined, { options: ["a", "b", "c"] }),
        // concat, titleCase, trim, upper
        field("full_name", "text", value('concat(titleCase(trim(first_name)), " ", upper(last_name))')),
        // matches, lower, not, empty
        field("email_ok", "checkbox", value('matches(lower(email), "^[^@]+@[^@]+$") and not(empty(email))')),
        // padStart, substring
        field("initials", "text", value('padStart(substring(first_name, 1, 1), 3, "*")')),
        // len
        field("name_len", "number", value("len(full_name)")),
        // last, split
        field("domain", "text", value('last(split(email, "@"))')),
        // count, distinct
        field("tag_count", "number", value('count(distinct(split(tags, ",")))')),
        // join, reverse, sort, append
        field("tag_summary", "text", value('join(reverse(sort(append(distinct(split(tags, ",")), "extra"))), ";")')),
        // startsWith, endsWith, contains, or
        field("has_a", "checkbox", value('startsWith(first_name, "A") or endsWith(last_name, "a") or contains(first_name, "d")')),
        // indexOf
        field("a_at", "number", value('indexOf(first_name, "a")')),
        // replace
        field("fixed_name", "text", value('replace(first_name, "x", "y")')),
        // text
        field("amount_label", "text", value("text(amount)")),
        // roundTo, arithmetic
        field("total", "number", value("roundTo(amount * rate / 100, 2)")),
        // clamp, abs, modulo, power, sqrt
        field("bounds", "number", value("clamp(abs(amount), 0, 1000) + modulo(amount, 7) + power(2, 3) + sqrt(16)")),
        // round, roundUp, roundDown, floor, ceil
        field("rounding", "number", value("round(rate) + roundUp(rate) + roundDown(rate) + floor(rate) + ceil(rate)")),
        // number, trim
        field("parsed", "number", value("number(trim(amount_text))")),
        // sum, min, max, avg
        field("stats", "number", value("sum(1, 2, 3) + min(amount, rate) + max(amount, rate) + avg(amount, rate)")),
        // isNumber
        field("is_num", "checkbox", value("isNumber(amount_text)")),
        // isDate
        field("is_date", "checkbox", value("isDate(dob)")),
        // count, selected
        field("picked_count", "number", value("count(selected(options))")),
        // first
        field("picked_first", "text", value("first(selected(options))")),
        // all, any
        field("picked_all", "checkbox", value("all(selected(options)) and any(selected(options))")),
        // if, else if, else
        field("tier", "text", value('if amount >= 1000 then "gold" else if amount >= 100 then "silver" else "bronze"')),
        // if without else: no answer when the case does not hold
        field("bonus", "number", value("if amount > 500 then round(amount / 10)")),
        // coalesce
        field("fallback", "text", value('coalesce(nickname, first_name, "anonymous")')),
        // between, in (list), in [interval]
        field("in_range", "checkbox", value("amount between 1 and 10 or rate in (5, 10) or amount in [1..10]")),
        // age (reads the clock)
        field("age_years", "number", value("age(dob)")),
        // year, month, day, dayOfWeek
        field("dob_parts", "number", value("year(dob) * 10000 + month(dob) * 100 + day(dob) + dayOfWeek(dob)")),
        // isWeekend
        field("dob_weekend", "checkbox", value("isWeekend(dob)")),
        // startOfMonth, today
        field("month_start", "date", value("startOfMonth(today())")),
        // endOfMonth, today
        field("month_end", "date", value("endOfMonth(today())")),
        // dateAdd, date: the 31st clamps to the end of February
        field("deadline", "date", value('dateAdd(date("2026-01-31"), 1, "months")')),
        // dateDiff, today
        field("days_left", "number", value('dateDiff(today(), deadline, "days")')),
        // a date comparison against the clock
        field("overdue", "checkbox", value("today() > deadline")),
        // between over dates, a date literal, today
        field("in_window", "checkbox", value('dob between @"1900-01-01" and today()')),
        // a plugin function
        field("tax", "number", value("roundTo(regionTax(amount, region), 2)")),
        // a server-only calculation (the browser never works it out)
        field("size", "text", { value: { formula: 'if amount > 100 then "large" else "small"', run: "server" } }),
        // a browser-only calculation (the server takes it as sent)
        field("local_note", "text", { value: { formula: "upper(nickname)", run: "browser" } }),
        // a browser-only visibility rule on a required field
        field("nickname_note", "text", { visibleWhen: { formula: "not(empty(nickname))", run: "browser" } }, { required: true }),
        // a secret required rule
        field("big_reason", "text", { requiredWhen: { formula: "amount > 1000", run: "server-secret" } }),
        // a clock-dependent visibility rule
        field("adult_note", "text", { visibleWhen: "age(dob) >= 18" }),
        {
          id: "items",
          type: "repeatingSection",
          configuration: {},
          collection: { collectionPath: "lines", itemFields: ["qty", "price", "line_label"] },
          children: {
            content: [
              field("qty", "number"),
              field("price", "number"),
              // rowIndex, rowCount, text
              field("line_label", "text", value('concat(text(rowIndex()), "/", text(rowCount()))'))
            ]
          }
        },
        // pluck, sum over a list
        field("items_total", "number", value('sum(pluck(lines, "price"))'))
      ]
    }
  };
}

/** The same root with a typo in `total`'s formula and the form set to refuse such a thing. */
export function formulaRootWithTypo(): ComponentNode {
  const root = formulaRoot();
  root.configuration = { formulaErrors: "fail" };
  const total = root.children?.content?.find((node) => node.id === "total");
  if (total === undefined) {
    throw new Error("the formula fixture has no total field");
  }
  total.rules = { value: FORMULA_TYPO };
  return root;
}

/** The ids of the root's direct children, in document order. */
export function formulaFieldIds(): string[] {
  return (formulaRoot().children?.content ?? []).map((node) => node.id);
}

/** Three pages: the inputs, a page that opens on the clock, and the rest. */
export function formulaJourney(): Journey {
  const inputs: string[] = [...FORMULA_INPUTS];
  const nextYear: string[] = [...FORMULA_NEXT_YEAR_FIELDS];
  const rest = formulaFieldIds().filter((id) => !inputs.includes(id) && !nextYear.includes(id));
  return {
    id: "formulas",
    pages: [
      { id: "start", components: inputs, routes: [{ when: `today() < @"${FORMULA_NEXT_YEAR}"`, to: "rest" }] },
      { id: "next_year", components: nextYear },
      { id: "rest", components: rest }
    ]
  };
}

/**
 * A plugin contributing one formula function, in the function-backed form the in-process
 * adapter reads; `toSourcePlugin` derives the sandbox module from it, so the function is
 * closure-free and reads only its arguments.
 */
export function formulaPlugin(): WasmPlugin & { functions: Record<string, (args: unknown[]) => unknown> } {
  return {
    id: "region-tax",
    version: "1.0.0",
    validators: [],
    functions: {
      regionTax: function regionTax(args: unknown[]): unknown {
        const amount = args[0];
        if (typeof amount !== "number") {
          return undefined;
        }
        return args[1] === "QC" ? amount * 0.14975 : amount * 0.05;
      }
    }
  };
}

/** Every input answered, every read path a calculation needs present. */
export function formulaHonestAnswers(): Record<string, unknown> {
  return {
    first_name: "ada",
    last_name: "lovelace",
    nickname: "countess",
    email: "ada@example.org",
    tags: "b,a,b",
    amount_text: " 42 ",
    region: "QC",
    amount: 1500,
    rate: 7.5,
    dob: "2008-12-15",
    options: { a: true, b: false, c: true },
    local_note: "COUNTESS",
    nickname_note: "a note",
    big_reason: "because",
    "lines[0].qty": 2,
    "lines[0].price": 10,
    "lines[1].qty": 1,
    "lines[1].price": 5
  };
}

/** The honest answers plus a wrong browser answer for every calculated field. */
export function formulaStaleAnswers(): Record<string, unknown> {
  const stale: Record<string, unknown> = formulaHonestAnswers();
  for (const id of FORMULA_CALCULATED) {
    if (id === "local_note") {
      continue;
    }
    // The section total is taken on trust (its read of the entries comes back unanswered here),
    // so its stale answer must still pass the number check.
    stale[id] = id === "size" ? "small" : id === "items_total" ? 999 : `stale ${id}`;
  }
  return stale;
}

/** The answer sets the parity matrix runs, each labelled for the failure message. */
export function formulaAnswerSets(): Array<{ label: string; values: Record<string, unknown> }> {
  return [
    { label: "nothing answered", values: {} },
    { label: "honest", values: formulaHonestAnswers() },
    {
      label: "small amount",
      values: { first_name: "Ada", last_name: "Byron", nickname: "A", email: "a@b", tags: "x", amount_text: "7", region: "ON", amount: 50, rate: 5, dob: "1990-02-28", options: { a: false }, nickname_note: "a note" }
    },
    { label: "stale calculations", values: formulaStaleAnswers() },
    { label: "a minor on both days", values: { ...formulaHonestAnswers(), dob: "2010-01-01" } },
    { label: "empty paths", values: { ...formulaHonestAnswers(), options: [], tags: "", nickname: "", amount_text: "" } }
  ];
}

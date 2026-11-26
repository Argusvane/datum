/**
 * The shared fixture of the form-tests build: one form that exercises every
 * statement of the language, a tiny second form that reads the clock, and the scenario corpus
 * the drivers run over them. The runtime driver's tests (`runtime-driver.test.ts`), the kernel
 * driver's and the parity check read the same texts, so a scenario that passes on one side and
 * not the other is the `parity` finding the design exists to catch.
 *
 * The main form, page by page of its one journey (`main`):
 * - `intro`: a required name (French label and engine wording in `fr`), an age between 18 and
 *   120, a calculation (`age_next_year = age + 1`), the box that brings the details page on the
 *   path, and a nickname enabled by that box and made read-only by one name.
 * - `contact`: a choice of how to be reached, an email required when that is the way, a phone
 *   shown when that is the way and withheld when hidden (the default, `exclude-from-submission`), a
 *   confirmation checked against the email (`validWhen`, with its own message in two locales),
 *   a province from a data source, and a code that routes to the exit page `stop` on "STOP".
 * - `details` (on the path only while `wants_details`): a checkbox group, a pet box and a pet
 *   name shown by it and kept when hidden (an explicit `retain`).
 * - `review`: a repeating section of quantities, a note only an admin host sees (`host.role`),
 *   and a reference number checked by the server alone (`run: "server"`).
 * - `stop`: the exit page.
 * Two PDF layouts: `standard` (the default, no condition) and `pets` (when `has_pet`).
 */
import type { FormDefinition } from "../../../form-engine/core/schema/types.js";
import type { FormTestScenarioStatus } from "../../../form-engine/core/form-tests/form-test-types.js";

export const FORM_TESTS_FIXTURE: FormDefinition = {
  id: "form-tests-fixture",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr" }] },
  root: {
    id: "form",
    type: "form",
    configuration: { label: "Form tests fixture" },
    children: {
      content: [
        { id: "applicant_name", type: "text", configuration: { label: "Name", required: true } },
        { id: "age", type: "number", configuration: { label: "Age", min: 18, max: 120 } },
        { id: "age_next_year", type: "number", configuration: { label: "Age next year" }, rules: { value: "age + 1" } },
        { id: "wants_details", type: "checkbox", configuration: { label: "Tell us more" } },
        {
          id: "nickname",
          type: "text",
          configuration: { label: "Nickname" },
          rules: { enabledWhen: "wants_details = true", readonlyWhen: 'applicant_name = "Locked"' }
        },
        {
          id: "contact_method",
          type: "select",
          configuration: { label: "How to reach you", options: [{ value: "email", label: "Email" }, { value: "phone", label: "Phone" }] }
        },
        { id: "email", type: "text", configuration: { label: "Email" }, rules: { requiredWhen: 'contact_method = "email"' } },
        {
          id: "phone",
          type: "text",
          configuration: { label: "Phone" },
          rules: { visibleWhen: 'contact_method = "phone"' }
        },
        {
          id: "confirm_email",
          type: "text",
          configuration: {
            label: "Confirm email",
            messages: { rule: "The two emails must match." }
          },
          rules: { validWhen: "confirm_email = email" }
        },
        { id: "province", type: "select", configuration: { label: "Province", data: { sourceId: "provinces" } } },
        { id: "stop_code", type: "text", configuration: { label: "Code" } },
        {
          id: "topics",
          type: "checkboxes",
          configuration: {
            label: "Topics",
            options: [{ value: "news", label: "News" }, { value: "offers", label: "Offers" }, { value: "events", label: "Events" }]
          }
        },
        { id: "has_pet", type: "checkbox", configuration: { label: "I have a pet" } },
        { id: "pet_name", type: "text", configuration: { label: "Pet name", hiddenValueBehavior: "retain" }, rules: { visibleWhen: "has_pet = true" } },
        {
          id: "items",
          type: "repeatingSection",
          configuration: { label: "Items" },
          collection: { itemFields: ["qty"] },
          children: { content: [{ id: "qty", type: "number", configuration: { label: "Quantity" } }] }
        },
        { id: "role_note", type: "text", configuration: { label: "Admin note" }, rules: { visibleWhen: 'host.role = "admin"' } },
        {
          id: "ref_number",
          type: "text",
          configuration: { label: "Reference", messages: { rule: "That reference is not ours." } },
          rules: { validWhen: { formula: 'ref_number != "BAD"', run: "server" } }
        }
      ]
    }
  },
  journey: {
    journeys: [
      {
        id: "main",
        validation: { continue: "page" },
        pages: [
          { id: "intro", components: ["applicant_name", "age", "age_next_year", "wants_details", "nickname"] },
          {
            id: "contact",
            components: ["contact_method", "email", "phone", "confirm_email", "province", "stop_code"],
            routes: [
              { when: 'stop_code = "STOP"', to: "stop" },
              { when: "not(wants_details = true)", to: "review" }
            ]
          },
          { id: "details", components: ["topics", "has_pet", "pet_name"] },
          { id: "review", components: ["items", "role_note", "ref_number"], routes: [{ to: "$end" }] },
          { id: "stop", kind: "exit", title: "Not eligible", components: [] }
        ]
      }
    ]
  },
  pdf: {
    layouts: [
      {
        id: "standard",
        kind: "generated",
        root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [], header: [], footer: [] } }
      },
      {
        id: "pets",
        kind: "generated",
        when: "has_pet = true",
        root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [], header: [], footer: [] } }
      }
    ],
    defaultLayoutId: "standard"
  },
  // The French label and rule message: texts are strings, their translations live here.
  // The engine words only English: its French `required` is the form's own `texts` entry.
  translations: {
    fr: {
      components: {
        applicant_name: { label: { text: "Nom", source: "4el6o6" } },
        confirm_email: { messages: { rule: { text: "Les deux courriels doivent correspondre.", source: "1f23inx" } } }
      },
      texts: { messages: { required: { text: "Ce champ est obligatoire", source: "1cyzib0" } } }
    }
  }
} as unknown as FormDefinition;

/** A form whose rule reads the clock: a scenario on it must name the day (`given today`). */
export const FORM_TESTS_CLOCK_FIXTURE: FormDefinition = {
  id: "form-tests-clock",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  root: {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        {
          id: "event_date",
          type: "date",
          configuration: { label: "Event date", messages: { rule: "The event cannot be in the past." } },
          rules: { validWhen: "event_date >= today()" }
        }
      ]
    }
  }
} as unknown as FormDefinition;

/** Which side a status is expected on: the browser runtime's driver, the validation kernel's. */
export interface FormTestsFixtureExpected {
  runtime: FormTestScenarioStatus;
  kernel: FormTestScenarioStatus;
}

export interface FormTestsFixtureScenario {
  name: string;
  /** One `test` block, as a definition's `tests.scenarios[].source` holds it. */
  source: string;
  /** Which fixture form the scenario runs on. */
  form: "main" | "clock";
  expected: FormTestsFixtureExpected;
  /** The scenario's `reason` where a status carries one (a skip's, an error's code). */
  reason?: Partial<Record<keyof FormTestsFixtureExpected, string>>;
}

function block(name: string, lines: string[]): string {
  return [`test "${name}"`, ...lines.map((line) => `  ${line}`)].join("\n");
}

function scenario(
  name: string,
  lines: string[],
  expected: FormTestsFixtureExpected = { runtime: "passed", kernel: "passed" },
  extra: { form?: "main" | "clock"; reason?: FormTestsFixtureScenario["reason"] } = {}
): FormTestsFixtureScenario {
  return {
    name,
    source: block(name, lines),
    form: extra.form ?? "main",
    expected,
    ...(extra.reason !== undefined ? { reason: extra.reason } : {})
  };
}

/** The name of the scenario that fails on purpose (its one step, on line 2, expects the required name optional). */
export const FORM_TESTS_FAILING_SCENARIO = "a deliberate failure: the name is not optional";

export const FORM_TESTS_FIXTURE_SCENARIOS: FormTestsFixtureScenario[] = [
  scenario("intro holds until a name is given", [
    "expect page = intro",
    "expect applicant_name visible",
    "expect applicant_name required",
    "expect applicant_name enabled",
    "expect applicant_name editable",
    "expect applicant_name empty",
    "continue",
    "expect page = intro",
    "expect error on applicant_name",
    "expect error on applicant_name: required",
    "set applicant_name = \"Ada\"",
    "set age = 30",
    "expect applicant_name not empty",
    "continue",
    "expect page = contact",
    "expect no error on applicant_name"
  ]),
  scenario("the age bounds and the calculation", [
    "set applicant_name = \"Ada\"",
    "set age = 15",
    "expect age = 15",
    "expect age != 16",
    "expect age_next_year = 16",
    "expect age_next_year = age + 1",
    "check",
    "expect refused",
    "expect error on age: number.min",
    "set age = 30",
    "check",
    "expect accepted",
    "expect no errors"
  ]),
  scenario("the nickname follows the details box", [
    "expect nickname disabled",
    "set wants_details = true",
    "expect nickname enabled",
    "set applicant_name = \"Locked\"",
    "expect nickname readonly",
    "set applicant_name = \"Ada\"",
    "expect nickname editable"
  ]),
  scenario("email is required when it is the way to reach you", [
    "set applicant_name = \"Ada\"",
    "set age = 30",
    "continue",
    "expect page = contact",
    "expect email optional",
    "set contact_method = \"email\"",
    "expect email required",
    "continue",
    "expect page = contact",
    "expect error on email: required"
  ]),
  scenario("the confirmation must match the email", [
    "given journey = none",
    "set email = \"a@example.com\"",
    "set confirm_email = \"b@example.com\"",
    "check",
    "expect refused",
    "expect error on confirm_email: rule",
    "expect message on confirm_email = \"The two emails must match.\"",
    "set confirm_email = \"a@example.com\"",
    "check",
    "expect no error on confirm_email"
  ]),
  scenario("the confirmation message in French", [
    "given journey = none",
    "given locale = \"fr\"",
    "set email = \"a@example.com\"",
    "set confirm_email = \"b@example.com\"",
    "check",
    "expect error on confirm_email: rule",
    "expect message on confirm_email = \"Les deux courriels doivent correspondre.\""
  ]),
  scenario("a hidden phone is withheld, a hidden pet name is kept", [
    "given journey = none",
    "set applicant_name = \"Ada\"",
    "set age = 30",
    "set contact_method = \"phone\"",
    "set phone = \"555-0100\"",
    "expect phone visible",
    "set contact_method = \"email\"",
    "set email = \"a@example.com\"",
    "set confirm_email = \"a@example.com\"",
    "expect phone hidden",
    "set has_pet = false",
    "set pet_name = \"Rex\"",
    "expect pet_name hidden",
    "submit",
    "expect accepted",
    "expect phone withheld",
    "expect submitted pet_name = \"Rex\"",
    "expect submitted applicant_name = \"Ada\""
  ]),
  scenario("STOP routes to the exit page", [
    "set applicant_name = \"Ada\"",
    "set age = 30",
    "continue",
    "set stop_code = \"STOP\"",
    "continue",
    "expect page = stop",
    "expect path = (intro, contact, stop)",
    "expect path ends at stop",
    "expect review off path"
  ]),
  scenario("the details page is skipped unless asked for", [
    "expect details off path",
    "expect path = (intro, contact, review)",
    "expect path ends",
    "set wants_details = true",
    "expect details on path",
    "expect path = (intro, contact, details, review)"
  ]),
  scenario("an answer on a skipped page is withheld", [
    "set applicant_name = \"Ada\"",
    "set age = 30",
    "set wants_details = true",
    "set has_pet = true",
    "set wants_details = false",
    "submit",
    "expect accepted",
    "expect has_pet withheld"
  ]),
  scenario("Back and a jump move between pages", [
    "set applicant_name = \"Ada\"",
    "set age = 30",
    "continue",
    "expect page = contact",
    "back",
    "expect page = intro",
    "go to contact",
    "expect page = contact"
  ]),
  scenario("rows are added, answered and removed", [
    "given journey = none",
    "expect rows of items = 0",
    "add row to items with qty = 2",
    "add row to items",
    "expect rows of items = 2",
    "expect items[0].qty = 2",
    "set items[1].qty = 5",
    "expect items[1].qty = 5",
    "remove row 0 of items",
    "expect rows of items = 1",
    "expect items[0].qty = 5"
  ]),
  scenario("the pets layout when there is a pet", [
    "given journey = none",
    "expect layout = standard",
    "set has_pet = true",
    "expect layout = pets"
  ]),
  scenario("topics read through a formula", [
    "given journey = none",
    "expect topics empty",
    "set topics = (\"news\", \"events\")",
    "expect topics not empty",
    "expect count(selected(topics)) = 2",
    "set topics = ()",
    "expect topics empty"
  ]),
  scenario("a province from the given options", [
    "given journey = none",
    "given options for province = (\"ON\", \"QC\")",
    "set applicant_name = \"Ada\"",
    "set age = 30",
    "set province = \"QC\"",
    "submit",
    "expect accepted",
    "expect submitted province = \"QC\""
  ]),
  scenario("an admin sees the role note", ["given journey = none", "given host.role = \"admin\"", "expect role_note visible"]),
  scenario("anyone else does not see the role note", ["given journey = none", "given host.role = \"user\"", "expect role_note hidden"]),
  scenario("a server-only check is not the browser's to judge", ["given journey = none", "set ref_number = \"BAD\"", "check", "expect error on ref_number: rule"], {
    runtime: "skipped",
    kernel: "passed"
  }, { reason: { runtime: "unreplayable.server" } }),
  scenario(FORM_TESTS_FAILING_SCENARIO, ["expect applicant_name optional"], { runtime: "failed", kernel: "failed" }),
  scenario("a scenario kept for later", ["skip \"waiting on the address rules\"", "expect applicant_name visible"], { runtime: "skipped", kernel: "skipped" }, {
    reason: { runtime: "waiting on the address rules", kernel: "waiting on the address rules" }
  }),
  scenario("a journey the form does not have", ["given journey = elsewhere", "expect applicant_name visible"], { runtime: "error", kernel: "error" }, {
    reason: { runtime: "scenario.unknownJourney", kernel: "scenario.unknownJourney" }
  }),
  scenario(
    "an event must not be in the past",
    [
      "given today = @\"2026-03-01\"",
      "set event_date = @\"2026-02-01\"",
      "check",
      "expect refused",
      "expect error on event_date: rule",
      "set event_date = \"2026-04-01\"",
      "check",
      "expect accepted"
    ],
    { runtime: "passed", kernel: "passed" },
    { form: "clock" }
  ),
  scenario("the clock must be given", ["set event_date = \"2026-04-01\"", "expect event_date visible"], { runtime: "error", kernel: "error" }, {
    form: "clock",
    reason: { runtime: "scenario.clockUnset", kernel: "scenario.clockUnset" }
  })
];

/** The fixture forms with their scenarios embedded under `tests`, as a definition stores them. */
export function fixtureWithTests(form: "main" | "clock"): FormDefinition {
  const base = form === "main" ? FORM_TESTS_FIXTURE : FORM_TESTS_CLOCK_FIXTURE;
  const scenarios = FORM_TESTS_FIXTURE_SCENARIOS.filter((entry) => entry.form === form).map((entry, index) => ({
    id: `${form}-${index + 1}`,
    source: entry.source
  }));
  return { ...base, tests: { scenarios } };
}

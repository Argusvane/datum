# ADR 0122: Number and date answers are checked

## Status

Accepted.

## Context

A number must be a number and a date must be a date, in the browser and on every server.

- A binding may draw a number as a text box (the datum binding does by default,
  `controls.number: "text"`, ADR 0079). The box keeps text it cannot parse as typed: "abc",
  "12 kg". Nothing downstream may accept it.
- The browser's own number box must not store `Number("")`, which is 0: clearing a number field
  stores the empty answer, so Required can fire. Text the browser cannot read ("1e") also reads
  as an empty value and must not store 0.
- A date drawn as parts (day, month, year) must not be joined without a check: 31 February,
  day 45 or a text month are not dates.
- A date typed in part stores "", and the person must be told what was missing, not just
  "required" or nothing.

## Decision

1. **Three codes.** `number`: a non-empty answer on a `number` component that is not a number.
   `date`: a non-empty answer on a `date` component that is not a real calendar date.
   `dateIncomplete`: a date typed in part, browser only (decision 7).

2. **What passes.** An empty answer raises neither code: Required judges it. A number is a finite
   number or a string that is a plain decimal numeral once trimmed; numeric strings pass so host
   prefill, imports and drafts keep working. A date is exactly `YYYY-MM-DD` and real. No answer
   is rewritten: this is validation only. A string is judged by its spelling alone, never by the
   number an engine parses it to. Engines round a numeral near the largest double differently: V8
   reads the 309-digit rounding midpoint as `Infinity`, QuickJS as the largest finite double. The
   verdict must be the same on every host, so a numeral too large for a double ("1e999") passes as
   a numeral, while a stored JS number must still be finite. The full list of what passes and
   fails is in `docs/translation-support.md`, "Validation messages".

3. **One reading on both sides.** The predicates live in `core/schema/answer-kinds.ts`:
   `kernelIsNumberAnswer`, `kernelIsDateAnswer` and `kernelAnswerKindCode(type, value)`. They
   follow the kernel's rules and are spliced into the sandbox program (`ANSWER_KIND_FUNCTIONS`
   in `PORTABLE_KERNEL_FUNCTIONS`). The browser's field-constraints stage and
   `kernelRunFieldConstraints` call the same functions. The check comes after Required and
   before bounds, length and pattern, so "abc" on a number field with a pattern is told `number`.

4. **Which components.** The built-in `number` and `date` types: what the markup draws as a
   number box or a date control. Every such component is checked, whatever else it declares. A
   plugin's number or date input is not: the kernel has no component registry to ask what a type
   holds. The engine draws no time or datetime field, so there is nothing to check for them.

5. **Format codes.** `number` and `date` are format checks, like `pattern`, so the hidden rules
   of ADR 0142 apply: they hold for a hidden answer that is still submitted. They hold for a form
   field a presentation fills or works out (to the kernel it is an ordinary form field, so a
   forged non-numeric worked-out total is refused) and for a field of a repeating section or a
   data grid at each entry's key (`items[0].qty`).

6. **Messages.** `ENGINE_VALIDATION_CODES` lists the three codes, so the builder's messages
   editor offers them, and `validationCodesRaisedBy` names `number` for a number and `date` and
   `dateIncomplete` for a date. `DEFAULT_VALIDATION_MESSAGES` words them in English; a binding's
   language pack or the form's translations word them over that. Under a binding with
   `unwordedErrors: "noted"` (`LiveBinding`; the GOV.UK reference binding sets it), the builder
   puts its advisory note on every number and date field that has no message of its own for them.

7. **What only the browser knows.** Two things a control knows cannot be carried by the value,
   because the value is empty: a date typed in part, and a number box holding text the browser
   cannot read (`validity.badInput`). The runtime keeps them as **input states**, by value path
   (`FormRuntime.setInputState(path, state)` and `inputState(path)`). The renderer records them
   right after it writes the empty answer: an adapter reports an unreadable number box with its
   write (`on.input(value, { badInput: true })`; an empty box stores "" and never 0), and a date
   drawn as parts reports its parts (`on.parts`), which the runtime composes (`setDateParts`). Any
   answer written to the path forgets the state, the empty one included, so a host that clears a
   field replaces what the control said; the control's own write keeps it because the state is
   recorded after it. Loading a draft, leaving a journey and starting another forget every state.

   Only a date drawn as parts can be typed in part: the datum binding's date by default
   (`render/live/datum/date.ts`), and any binding's date adapter that reports parts. A browser's
   own `<input type="date">` (the datum date's `control: "native"`) typed in part reports an empty value and says nothing more, so it
   reads `required`, or nothing.

   Validation hands the states to its stages as `ValidationContext.inputStates`. For an empty
   answer, the field-constraints stage then raises, in place of `required`, `dateIncomplete` for a
   date typed in part (with or without Required; its parameters `missing`, `missingKey` and
   `missingParts` name the parts left (`missingKey` is one of `day`, `month`, `year`, `day-month`,
   `day-year`, `month-year`), so a binding or a translation can word each case), or
   `number` with `parameters: { badInput: true }` for a number box the browser could not read.

   The states never leave the browser. They are not in a draft, the envelope or the sandbox
   request (`WasmSubmissionContext` leaves `inputStates` out, and `JsonWasmAbi.serializeContext`
   drops it by name, as it drops `requiredComponents`). A server only ever holds the empty
   answer, so its verdict for the same envelope is `required` or nothing. This is the deliberate
   case where the browser is stricter than the server: the browser tells the person what they
   typed; the server has nothing typed to judge. The states are dropped whenever the component is
   not visible, whatever its hidden-validation behaviour says: a control nobody sees has nothing
   to tell the person, and a hidden, empty answer has no shape to check.

8. **Typed numbers and month names are read at the box.** A number may be typed with its digits
   grouped ("1,000", "1 000") and a month by its name ("Feb", "February"), at the UI level only.
   The reading happens where the box is read: `readTypedNumber` and `readTypedMonth`
   (`render/web-component/typed-answers.ts`), used by `typedNumberAnswer` (`render/live/fields.ts`)
   for a number box and by `FormRuntime.setDateParts` for a month typed as a name, and only the
   canonical value is ever stored: a number, or a `YYYY-MM-DD` date with digit parts. Validation
   is unchanged: `number` and `date` read the stored value's strict format, text neither reader
   can read is kept as typed so validation still names what is wrong, and a value written by a
   host, a draft or a server is never read this way. The grouping and month-name rules are in
   `docs/translation-support.md`, "Validation messages".

## Consequences

- Text on a number field that is not a number is refused, by the browser and by every server
  running a program that knows the check. Numeric strings pass.
- An impossible date (31 February, day 45, a text month, a datetime string) is refused on both
  sides.
- A cleared browser number box is empty, not 0, so Required fires.
- Under a binding that draws dates as parts, a date typed in part reads "Enter a complete date"
  (or the binding's words) instead of the bare `required`, and an optional date typed in part is
  refused in the browser. A browser's own date box typed in part reports nothing more.
- A number or date component whose calculation yields something else (a string, say) is refused
  on both sides, as the kernel works the same value out.

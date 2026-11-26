/**
 * The Move to... dialog's and the keyboard move mode's English, in the lazy chunk the
 * canvas loads on the first Move to... or `M`, kept out of the eager table in
 * `logic/builder-texts.ts` (to keep the eager bundle small). Read only by `move-ui.ts`,
 * through this module's `areaWords`; a host catalog words them by key as any other.
 * `engine/tests/builder-texts.test.ts` holds each key to exactly one table and each table to its
 * own readers. The selection bar's own button ("Move to…") is drawn with the bar, so its two
 * keys are the canvas's (`canvas.action.move` and `canvas.action.moveTip` in `logic/builder-texts.ts`).
 */
import { areaText } from "../logic/builder-texts.js";

export const MOVE_EN = {
  "move.title": "Move “{name}”",
  "move.target": "Move to",
  "move.position": "Position",
  "move.first": "First",
  "move.last": "Last",
  "move.after": "After {name}",
  "move.here": "{place} (where it is now)",
  "move.top": "Top level",
  "move.slot": "{place} › {slot}",
  "move.confirm": "Move",
  "move.at": "{place}, position {n} of {total}",
  "move.moved": "Moved to {place}, position {n} of {total}",
  "move.empties": "{place} will have no fields: it shows only its buttons.",
  "move.emptied": "{place} is now empty.",
  "move.edge": "{at}. No further places.",
  "move.start": "Moving {name}. Arrow keys choose a place, Enter moves it there, Escape cancels. {at}",
  "move.cancelled": "Move cancelled.",
  "move.unchanged": "Not moved: it is already there.",
  "move.nowhere": "{name} has nowhere else to go."
} as const;

export const { areaWords } = /* @__PURE__ */ areaText(MOVE_EN);

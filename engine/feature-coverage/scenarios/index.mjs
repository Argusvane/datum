// The scenarios, in run order. Each module's default export:
//   { id, title, features: [checklist ids], hosts?: ["element"], pending?: "why it cannot pass yet", run(t) }
// `hosts` names the hosts a scenario runs in (both when left out): the element's own settings have no
// live-host counterpart.
// `t` is the scenario API (lib/driver.mjs). A scenario the new renderer cannot pass yet is
// marked `pending` with its reason: it still runs and is reported, but never fails the run.
import { BEHAVIOUR_SCENARIOS } from "./index-behaviour.mjs";
import { ELEMENT_SCENARIOS } from "./element-settings.mjs";
import { OTHER_SCENARIOS } from "./other-behaviour.mjs";
import chrome from "./chrome.mjs";
import dataGrid from "./data-grid.mjs";
import dates from "./dates.mjs";
import implicitSubmit from "./implicit-submit.mjs";
import journey from "./journey.mjs";
import language from "./language.mjs";
import readOnly from "./read-only.mjs";
import steps from "./steps.mjs";
import summaryLinks from "./summary-links.mjs";
import summaryTargets from "./summary-targets.mjs";
import tabs from "./tabs.mjs";
import validateFocus from "./validate-focus.mjs";

export const SCENARIOS = [validateFocus, summaryLinks, readOnly, tabs, summaryTargets, dataGrid, dates, steps, journey, chrome, language, implicitSubmit, ...BEHAVIOUR_SCENARIOS, ...OTHER_SCENARIOS, ...ELEMENT_SCENARIOS];

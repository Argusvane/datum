// The behaviour scenarios (count, files, locks, pending and busy, notices, data sources,
// validate-on, agent contract and state hooks, translations), in run order.
import countAnnounce from "./count-announce.mjs";
import { FILE_SCENARIOS } from "./files.mjs";
import { LOCK_SCENARIOS } from "./field-locks.mjs";
import { SOURCE_SCENARIOS } from "./data-sources.mjs";
import { TRANSLATION_SCENARIOS } from "./translations.mjs";
import { VALIDATE_ON_SCENARIOS } from "./validate-on.mjs";
import { NOTICE_SCENARIOS } from "./notices.mjs";
import { AGENT_SCENARIOS } from "./agent-contract.mjs";
import { BUSY_SCENARIOS } from "./pending-busy.mjs";

export const BEHAVIOUR_SCENARIOS = [countAnnounce, ...FILE_SCENARIOS, ...LOCK_SCENARIOS, ...BUSY_SCENARIOS, ...NOTICE_SCENARIOS, ...SOURCE_SCENARIOS, ...VALIDATE_ON_SCENARIOS, ...TRANSLATION_SCENARIOS, ...AGENT_SCENARIOS];

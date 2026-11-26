import { kernelReadEnum } from "../state/semantic-state.js";

/** The author's switch for assistants in the browser: root.configuration.agentTools. */
export const AGENT_TOOLS_SETTINGS = ["allowed", "off"] as const;
export type AgentToolsSetting = (typeof AGENT_TOOLS_SETTINGS)[number];
/** The root configuration's value, or undefined when it is absent or not one of the two words (not provided). */
export function readAgentToolsSetting(rootConfiguration: unknown): AgentToolsSetting | undefined {
  return kernelReadEnum(rootConfiguration, "agentTools", AGENT_TOOLS_SETTINGS) as AgentToolsSetting | undefined;
}

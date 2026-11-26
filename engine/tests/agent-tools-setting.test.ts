import { describe, expect, it } from "vitest";

import {
  AGENT_ACCESS_VALUES,
  AGENT_TOOLS_SETTINGS,
  DEFAULT_AGENT_ACCESS,
  readAgentToolsSetting,
  type AgentAccess,
  type AgentToolsSetting
} from "../form-engine/index.js";

/*
 * The author's switch for assistants in the browser: root.configuration.agentTools
 * reads as "allowed" or "off", and any other value, or none, reads as not provided (undefined). The
 * host's agent-access policy and its default are the two constants beside the renderer element.
 */

describe("readAgentToolsSetting", () => {
  it("reads the two words of root.configuration.agentTools", () => {
    expect(readAgentToolsSetting({ agentTools: "allowed" })).toBe("allowed");
    expect(readAgentToolsSetting({ agentTools: "off" })).toBe("off");
  });

  it("reads anything else, or nothing, as not provided", () => {
    expect(readAgentToolsSetting({})).toBeUndefined();
    expect(readAgentToolsSetting({ agentTools: "maybe" })).toBeUndefined();
    expect(readAgentToolsSetting({ agentTools: true })).toBeUndefined();
    expect(readAgentToolsSetting({ agentTools: "Off" })).toBeUndefined();
    expect(readAgentToolsSetting({ formulaErrors: "warn" })).toBeUndefined();
  });

  it("reads nothing from a configuration that is not an object", () => {
    expect(readAgentToolsSetting(null)).toBeUndefined();
    expect(readAgentToolsSetting(undefined)).toBeUndefined();
    expect(readAgentToolsSetting("allowed")).toBeUndefined();
    expect(readAgentToolsSetting(["allowed"])).toBeUndefined();
  });
});

describe("the access constants", () => {
  it("lists the two author words", () => {
    expect(AGENT_TOOLS_SETTINGS).toEqual(["allowed", "off"]);
    const setting: AgentToolsSetting = "allowed";
    expect(setting).toBe("allowed");
  });

  it("lists the three host policy words in order", () => {
    expect(AGENT_ACCESS_VALUES).toEqual(["always", "definition", "never"]);
  });

  it("defaults the host policy to definition", () => {
    expect(DEFAULT_AGENT_ACCESS).toBe("definition");
    const access: AgentAccess = DEFAULT_AGENT_ACCESS;
    expect(access).toBe("definition");
  });
});

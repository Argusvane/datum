import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILDER_FEATURES,
  BUILDER_FEATURE_SUMMARY,
  BUILDER_OPT_IN_FEATURES,
  builderSides,
  featureOn,
  isOptInBuilderFeature,
  normalizeBuilderFeatures,
  optInFeatureOn,
  panelAllowed,
  parseBuilderFeatures,
  resetBuilderFeatureWarnings,
  workspaceAllowed,
  type BuilderFeature
} from "../form-engine/builder/web-component/builder-features.js";

/*
 * The builder's `features` list as a pure model: tokens, presets, normalisation, what
 * each part owns, and what the master list leaves of the sides the other attributes switch.
 */

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetBuilderFeatureWarnings();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

const listed = (value: string | readonly string[] | null | undefined): BuilderFeature[] => {
  const set = parseBuilderFeatures(value);
  return set === undefined ? [] : BUILDER_FEATURES.filter((feature) => set.has(feature));
};

/** What `all` names: every part but the opt-in `agent`. */
const everyPart: BuilderFeature[] = BUILDER_FEATURES.filter((feature) => feature !== "agent");

describe("parseBuilderFeatures", () => {
  it("gives no list for an absent value, where every part exists", () => {
    expect(parseBuilderFeatures(undefined)).toBeUndefined();
    expect(parseBuilderFeatures(null)).toBeUndefined();
    for (const feature of BUILDER_FEATURES) {
      // Every part but the opt-in ones, which an absent list never switches on.
      expect(featureOn(undefined, feature), feature).toBe(!isOptInBuilderFeature(feature));
    }
  });

  it("reads tokens separated by spaces and commas, in any case", () => {
    expect(listed("logic data")).toEqual(["logic", "data"]);
    expect(listed("Logic,DATA , pdf")).toEqual(["logic", "data", "pdf"]);
    expect(listed("  header-footer\ttry-it\n json ")).toEqual(["header-footer", "try-it", "json"]);
  });

  it("takes an array of tokens, each of which may itself be a list", () => {
    expect(listed(["logic", "pdf data"])).toEqual(["logic", "data", "pdf"]);
  });

  it("expands all to every part but the opt-in ones, and minimal to none", () => {
    expect(listed("all")).toEqual(everyPart);
    expect(listed("all")).not.toContain("agent");
    expect(listed("minimal")).toEqual([]);
    expect(parseBuilderFeatures("minimal")?.size).toBe(0);
  });

  it("combines a preset with tokens: minimal logic is the form plus Logic", () => {
    expect(listed("minimal logic")).toEqual(["logic"]);
    expect(listed("logic minimal")).toEqual(["logic"]);
    expect(listed("minimal logic pdf")).toEqual(["logic", "pdf"]);
    expect(listed("minimal all")).toEqual(everyPart);
  });

  it("switches the opt-in agent token on only when the list names it", () => {
    expect(BUILDER_OPT_IN_FEATURES).toEqual(["agent"]);
    expect(isOptInBuilderFeature("agent")).toBe(true);
    expect(isOptInBuilderFeature("pdf")).toBe(false);
    expect(listed("all agent")).toEqual([...BUILDER_FEATURES]);
    expect(listed("agent")).toEqual(["agent"]);
    expect(listed("minimal agent")).toEqual(["agent"]);

    expect(featureOn(undefined, "agent")).toBe(false);
    expect(featureOn(parseBuilderFeatures("all"), "agent")).toBe(false);
    expect(featureOn(parseBuilderFeatures("all agent"), "agent")).toBe(true);
    expect(optInFeatureOn(undefined, "agent")).toBe(false);
    expect(optInFeatureOn(parseBuilderFeatures("all"), "agent")).toBe(false);
    expect(optInFeatureOn(parseBuilderFeatures("agent"), "agent")).toBe(true);
    expect(optInFeatureOn(parseBuilderFeatures("all agent"), "agent")).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats an empty list as a list that names nothing (the Form workspace alone)", () => {
    expect(parseBuilderFeatures("")?.size).toBe(0);
    expect(parseBuilderFeatures("  ,  ")?.size).toBe(0);
    expect(parseBuilderFeatures([])?.size).toBe(0);
  });

  it("ignores an unknown token and warns once for it", () => {
    expect(listed("logic wrong")).toEqual(["logic"]);
    expect(listed("wrong pdf")).toEqual(["pdf"]);
    expect(listed("other")).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain('unknown feature "wrong" ignored');
    expect(String(warn.mock.calls[1]?.[0])).toContain('unknown feature "other" ignored');
  });

  it("takes a part out with -name: after all, alone (which starts from all), and wherever it stands", () => {
    const allButPdf = everyPart.filter((feature) => feature !== "pdf");
    expect(listed("all -pdf")).toEqual(allButPdf);
    expect(listed("-pdf")).toEqual(allButPdf);
    expect(listed("-PDF, all")).toEqual(allButPdf);
    expect(listed(["-pdf", "-journeys"])).toEqual(allButPdf.filter((feature) => feature !== "journeys"));
    expect(listed("minimal logic pdf -pdf")).toEqual(["logic"]);
    expect(listed("-pdf agent")).toEqual(["agent"]);
    expect(normalizeBuilderFeatures("-pdf")).toBe(allButPdf.join(" "));
    expect(warn).not.toHaveBeenCalled();
  });

  it("never widens on a mistyped exclusion: the list then starts from nothing, with one warning", () => {
    expect(listed("-pfd")).toEqual([]);
    expect(listed("-pdf -pfd")).toEqual([]);
    expect(listed("-form")).toEqual([]);
    expect(listed("-all")).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0]?.[0])).toContain('unknown feature "-pfd" ignored');
  });

  it("never reads an unknown token as everything", () => {
    expect(parseBuilderFeatures("typo")?.size).toBe(0);
    expect(featureOn(parseBuilderFeatures("typo"), "pdf")).toBe(false);
  });

  it("names the seventeen parts (the Tests panel; the Print workspace; the opt-in agent tools, last)", () => {
    expect([...BUILDER_FEATURES]).toEqual([
      "logic",
      "data",
      "languages",
      "translations",
      "journeys",
      "pdf",
      "print",
      "variables",
      "header-footer",
      "data-model",
      "palette",
      "try-it",
      "tests",
      "json",
      "binding-picker",
      "advanced-fields",
      "agent"
    ]);
  });

  it("words every token in the summary, the opt-in one as such", () => {
    expect(Object.keys(BUILDER_FEATURE_SUMMARY).sort()).toEqual([...BUILDER_FEATURES].sort());
    expect(BUILDER_FEATURE_SUMMARY.agent).toBe("the agent tools (WebMCP) over the builder, a lazy chunk; opt-in, not part of all");
  });
});

describe("normalizeBuilderFeatures", () => {
  it("gives undefined for no list", () => {
    expect(normalizeBuilderFeatures(undefined)).toBeUndefined();
    expect(normalizeBuilderFeatures(null)).toBeUndefined();
  });

  it("gives the parts in the table's order, once each", () => {
    expect(normalizeBuilderFeatures("pdf, logic logic DATA")).toBe("logic data pdf");
  });

  it("gives all for every part and minimal for none", () => {
    expect(normalizeBuilderFeatures("all")).toBe("all");
    expect(normalizeBuilderFeatures(everyPart)).toBe("all");
    expect(normalizeBuilderFeatures(BUILDER_FEATURES.filter((feature) => feature !== "agent"))).toBe("all");
    expect(normalizeBuilderFeatures("")).toBe("minimal");
    expect(normalizeBuilderFeatures("minimal")).toBe("minimal");
    expect(normalizeBuilderFeatures("typo")).toBe("minimal");
  });

  it("prints the opt-in agent token after all, and alone when nothing else is named", () => {
    expect(normalizeBuilderFeatures("all agent")).toBe("all agent");
    expect(normalizeBuilderFeatures("agent all")).toBe("all agent");
    expect(normalizeBuilderFeatures([...BUILDER_FEATURES])).toBe("all agent");
    expect(normalizeBuilderFeatures("agent")).toBe("agent");
    expect(normalizeBuilderFeatures("minimal agent")).toBe("agent");
    expect(normalizeBuilderFeatures("logic agent")).toBe("logic agent");
  });

  it("is stable: normalising its own output changes nothing", () => {
    for (const text of ["logic data", "all", "minimal", "pdf palette json", "all agent", "agent"]) {
      const once = normalizeBuilderFeatures(text);
      expect(normalizeBuilderFeatures(once)).toBe(once);
    }
  });
});

describe("what each part owns", () => {
  it("lets the Form workspace and the always-on panels exist under any list", () => {
    const none = parseBuilderFeatures("minimal");
    expect(workspaceAllowed(none, "form")).toBe(true);
    for (const panel of ["form", "components", "outline", "view", "settings", "translations"]) {
      expect(panelAllowed(none, panel)).toBe(true);
    }
  });

  it("ties each workspace to the part of the same name", () => {
    for (const workspace of ["logic", "data", "languages", "journeys", "pdf", "print"]) {
      expect(workspaceAllowed(parseBuilderFeatures("minimal"), workspace)).toBe(false);
      expect(workspaceAllowed(parseBuilderFeatures(workspace), workspace)).toBe(true);
      expect(workspaceAllowed(undefined, workspace)).toBe(true);
    }
  });

  it("ties the Print workspace to its part, which all names and minimal leaves off", () => {
    expect(workspaceAllowed(parseBuilderFeatures("all"), "print")).toBe(true);
    expect(workspaceAllowed(parseBuilderFeatures("all -print"), "print")).toBe(false);
    expect(workspaceAllowed(parseBuilderFeatures("-print"), "print")).toBe(false);
    expect(workspaceAllowed(parseBuilderFeatures("-print"), "pdf")).toBe(true);
    expect(normalizeBuilderFeatures("pdf print")).toBe("pdf print");
    expect(BUILDER_FEATURE_SUMMARY.print).toMatch(/Print workspace/);
  });

  it("ties the Tests panel to its part, and the minimal preset leaves it off", () => {
    expect(panelAllowed(parseBuilderFeatures("minimal"), "tests")).toBe(false);
    expect(panelAllowed(parseBuilderFeatures("tests"), "tests")).toBe(true);
    expect(panelAllowed(undefined, "tests")).toBe(true);
    expect(BUILDER_FEATURE_SUMMARY.tests).toBe("the Tests panel");
  });

  it("ties Header & footer and Variables to their parts", () => {
    expect(panelAllowed(parseBuilderFeatures("minimal"), "chrome")).toBe(false);
    expect(panelAllowed(parseBuilderFeatures("header-footer"), "chrome")).toBe(true);
    expect(panelAllowed(parseBuilderFeatures("minimal"), "variables")).toBe(false);
    expect(panelAllowed(parseBuilderFeatures("variables"), "variables")).toBe(true);
    expect(panelAllowed(undefined, "chrome")).toBe(true);
  });
});

describe("builderSides: the list is the master, a hidden workspace only restricts", () => {
  const states = [undefined, "auto", "/pdf.js"] as const;

  it.each(states)("pdf=%s with pdf listed: on unless the workspace is hidden", (pdf) => {
    expect(builderSides({ features: parseBuilderFeatures("pdf"), pdf, hiddenWorkspaces: [] }).pdf).toBe(true);
    expect(builderSides({ features: parseBuilderFeatures("pdf"), pdf, hiddenWorkspaces: ["pdf"] }).pdf).toBe(false);
  });

  it.each(states)("pdf=%s with pdf unlisted: never on, and a pdf that names an executor warns once", (pdf) => {
    const sides = builderSides({ features: parseBuilderFeatures("logic"), pdf, hiddenWorkspaces: [] });
    expect(sides.pdf).toBe(false);
    builderSides({ features: parseBuilderFeatures("logic"), pdf, hiddenWorkspaces: [] });
    const asked = pdf !== undefined;
    expect(warn).toHaveBeenCalledTimes(asked ? 1 : 0);
    if (asked) {
      expect(String(warn.mock.calls[0]?.[0])).toContain("pdf attribute ignored: not in features");
    }
  });

  it("the journeys side follows the list and the hidden workspaces alone", () => {
    expect(builderSides({ features: parseBuilderFeatures("journeys"), pdf: undefined, hiddenWorkspaces: [] }).journeys).toBe(true);
    expect(builderSides({ features: parseBuilderFeatures("journeys"), pdf: undefined, hiddenWorkspaces: ["journeys"] }).journeys).toBe(false);
    expect(builderSides({ features: parseBuilderFeatures("pdf"), pdf: undefined, hiddenWorkspaces: [] }).journeys).toBe(false);
    expect(builderSides({ features: parseBuilderFeatures("-journeys"), pdf: undefined, hiddenWorkspaces: [] })).toEqual({ pdf: true, journeys: false });
  });

  it("has both sides without a list", () => {
    expect(builderSides({ features: undefined, pdf: undefined, hiddenWorkspaces: [] })).toEqual({ pdf: true, journeys: true });
    expect(builderSides({ features: undefined, pdf: undefined, hiddenWorkspaces: ["pdf", "journeys"] })).toEqual({ pdf: false, journeys: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn for a side the list leaves out when nothing asked for it", () => {
    builderSides({ features: parseBuilderFeatures("minimal"), pdf: undefined, hiddenWorkspaces: [] });
    expect(warn).not.toHaveBeenCalled();
  });
});

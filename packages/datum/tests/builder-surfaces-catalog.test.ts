import { afterEach, describe, expect, it } from "vitest";

import { DATUM_BUILDER_OVERVIEW_TAG } from "../../../engine/form-engine/builder/overview/overview-surface.js";
import { DATUM_BUILDER_PALETTE_TAG } from "../../../engine/form-engine/builder/palette/command-palette.js";

/** The surfaces the shell does not wire yet (the palette, the overview) read the host's catalog when it sets one. */

afterEach(() => {
  document.body.innerHTML = "";
});

const FRENCH = {
  fr: {
    "palette.label": "Commandes",
    "palette.none": "Aucune commande",
    "overview.empty": "Rien à afficher pour l'instant."
  }
};

describe("builder surfaces take a text catalog", () => {
  it("words the command palette's dialog and its empty count in the host's catalog", async () => {
    await import("../../../engine/form-engine/builder/palette/command-palette.js");
    const palette = document.createElement(DATUM_BUILDER_PALETTE_TAG) as HTMLElement & {
      textLocale: string;
      textCatalog: typeof FRENCH;
      open(options: { commands: never[]; recent: string[] }): void;
    };
    palette.textLocale = "fr";
    palette.textCatalog = FRENCH;
    document.body.append(palette);
    palette.open({ commands: [], recent: [] });
    const dialog = palette.shadowRoot!.querySelector("dialog")!;
    expect(dialog.getAttribute("aria-label")).toBe("Commandes");
    expect(palette.shadowRoot!.querySelector("[data-palette-count]")!.textContent).toBe("Aucune commande");
  });

  it("words the overview's empty state in the host's catalog", async () => {
    await import("../../../engine/form-engine/builder/overview/overview-surface.js");
    const overview = document.createElement(DATUM_BUILDER_OVERVIEW_TAG) as HTMLElement & { textLocale: string; textCatalog: typeof FRENCH };
    overview.textLocale = "fr";
    overview.textCatalog = FRENCH;
    document.body.append(overview);
    expect(overview.shadowRoot!.querySelector(".empty")!.textContent).toBe("Rien à afficher pour l'instant.");
  });
});

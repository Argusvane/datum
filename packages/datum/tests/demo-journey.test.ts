import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import "../src/form.js";
import type { DatumFormElement } from "../src/form.js";

import { until } from "./helpers.js";

/*
 * demo/journey.html's host wiring: the page's own script, run against the element
 * from source, for the history recipe it shows — the one the README words, and the one a page
 * copies. The bundle the page loads is left out; the element is defined by this import.
 */

const html = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../demo/journey.html"), "utf8");

afterEach(async () => {
  await (document.getElementById("form") as DatumFormElement | null)?.clearDraft();
  document.body.innerHTML = "";
  history.replaceState(null, "", "/");
});

/** The demo's body and its inline script, run as the page runs it. */
function loadDemo(): DatumFormElement {
  const body = html.slice(html.indexOf("<body>") + "<body>".length, html.indexOf("</body>"));
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(body)?.[1];
  expect(script).toBeDefined();
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, "");
  new Function(script!)();
  return document.getElementById("form") as DatumFormElement;
}

const pageInUrl = (): string | null => new URLSearchParams(location.search).get("page");

describe("demo/journey.html: the address bar follows the journey", () => {
  it("adds an entry for every move the person makes, so the browser's Back always moves, and puts back an address the journey refuses", async () => {
    const form = loadDemo();
    await until(() => form.page === "about" && pageInUrl() === "about");
    const start = history.length;
    form.runtime!.setValue("adult", "yes");
    form.runtime!.setValue("resident", "yes");
    expect((await form.nextPage()).pageId).toBe("residence");
    form.runtime!.setValue("province", "NS");
    form.runtime!.setValue("postalCode", "B3H 1A1");
    expect((await form.nextPage()).pageId).toBe("contact");
    await until(() => pageInUrl() === "contact");

    // The form's own Back is a move too: a new entry, not the current one rewritten, so the
    // browser's Back that follows has somewhere to go.
    expect((await form.previousPage()).pageId).toBe("residence");
    await until(() => pageInUrl() === "residence");
    expect(history.length).toBe(start + 3);
    history.back();
    await until(() => pageInUrl() === "contact");
    await until(() => form.page === "contact");

    // An address naming a page the person has not reached: the jump is refused, and the
    // address is put back on the page the form shows.
    history.pushState({ page: "not-eligible" }, "", "?page=not-eligible");
    history.pushState({ page: "contact" }, "", "?page=contact");
    history.back();
    await until(() => pageInUrl() === "contact" && history.state?.page === "contact");
    expect(form.page).toBe("contact");
  });
});

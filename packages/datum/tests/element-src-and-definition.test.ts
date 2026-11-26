import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/form.js";
import "../src/builder.js";
import type { DatumFormElement } from "../src/form.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import type { FormDefinition } from "@argusvane/datum-engine";
import { MAX_DEFINITION_BYTES } from "../src/support.js";
import { until } from "./helpers.js";

/*
 * `src` and an assigned definition never race: while a definition the page assigned (the
 * property or the attribute) is in place, setting `src` is refused, and while a `src` fetch is
 * pending, assigning a definition is refused. Each refusal is a datum-error and nothing is
 * replaced. A definition is read at most `max-definition-bytes` long (2 MiB unless the page says
 * otherwise), from `src` and from the builder's Open, before it is parsed.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const form = (id: string, fieldId = "keep") => ({
  id,
  version: "1.0.0",
  schemaVersion: "1",
  root: { id: "root", type: "form", configuration: {}, children: { content: [{ id: fieldId, type: "text", configuration: { label: fieldId } }] } }
});

/** A fetch that holds every response until `release()` and answers `body` (re-read when released). */
function gatedFetch(body: () => unknown): { release(): void; calls: string[] } {
  const waiting: Array<() => void> = [];
  const calls: string[] = [];
  vi.stubGlobal("fetch", (url: string) => {
    calls.push(String(url));
    return new Promise<Response>((resolve) => {
      waiting.push(() => resolve(new Response(JSON.stringify(body()), { status: 200, headers: { "content-type": "application/json" } })));
    });
  });
  return {
    calls,
    release() {
      for (const go of waiting.splice(0)) {
        go();
      }
    }
  };
}

function errorsOf(el: HTMLElement): string[] {
  const heard: string[] = [];
  el.addEventListener("datum-error", (event) => heard.push((event as CustomEvent<{ message: string }>).detail.message));
  return heard;
}

describe("<datum-form>: src and an assigned definition", () => {
  it("refuses a definition assigned while a src fetch is pending; the fetched form loads", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const gate = gatedFetch(() => form("from-src"));
    const el = document.createElement("datum-form") as DatumFormElement;
    const heard = errorsOf(el);
    document.body.append(el);
    el.src = "/forms/a.json";
    el.definition = form("assigned") as unknown as FormDefinition;
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatch(/still loading/);
    expect(el.definition).toBeUndefined();
    gate.release();
    await until(() => el.definition?.id === "from-src");
    await sleep(20);
    expect(el.definition?.id).toBe("from-src");
    expect(heard).toHaveLength(1);
  });

  it("refuses the definition attribute while a src fetch is pending", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const gate = gatedFetch(() => form("from-src"));
    const el = document.createElement("datum-form") as DatumFormElement;
    const heard = errorsOf(el);
    document.body.append(el);
    el.setAttribute("src", "/forms/a.json");
    el.setAttribute("definition", JSON.stringify(form("assigned")));
    expect(heard).toHaveLength(1);
    gate.release();
    await until(() => el.definition?.id === "from-src");
  });

  it("refuses src while an assigned definition is in place; nothing is fetched and the form stays", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const gate = gatedFetch(() => form("from-src"));
    const el = document.createElement("datum-form") as DatumFormElement;
    const heard = errorsOf(el);
    el.definition = form("assigned") as unknown as FormDefinition;
    document.body.append(el);
    el.src = "/forms/a.json";
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatch(/definition .*assigned/);
    expect(el.src).toBeUndefined();
    expect(gate.calls).toEqual([]);
    gate.release();
    await sleep(20);
    expect(el.definition?.id).toBe("assigned");
  });

  it("lets src load once the assigned definition is cleared, and a definition be assigned once src is cleared", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const gate = gatedFetch(() => form("from-src"));
    const el = document.createElement("datum-form") as DatumFormElement;
    const heard = errorsOf(el);
    el.definition = form("assigned") as unknown as FormDefinition;
    document.body.append(el);
    el.definition = undefined;
    el.src = "/forms/a.json";
    gate.release();
    await until(() => el.definition?.id === "from-src");
    // A second src replaces a form src brought.
    el.src = "/forms/b.json";
    el.src = undefined;
    el.definition = form("assigned-again") as unknown as FormDefinition;
    gate.release();
    await sleep(20);
    expect(el.definition?.id).toBe("assigned-again");
    expect(heard).toEqual([]);
  });
});

describe("<datum-form-builder>: src and an assigned definition", () => {
  async function builder(setup?: (el: DatumFormBuilderElement) => void): Promise<DatumFormBuilderElement> {
    const el = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    setup?.(el);
    document.body.append(el);
    await until(() => el.controller);
    return el;
  }
  const ids = (el: DatumFormBuilderElement) => el.controller?.snapshot().children?.content?.map((child) => child.id);

  it("refuses a definition assigned while a src fetch is pending; the fetched form loads", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const gate = gatedFetch(() => form("from-src", "remote"));
    const el = await builder();
    const heard = errorsOf(el);
    el.src = "/forms/a.json";
    el.definition = form("assigned", "local") as unknown as FormDefinition;
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatch(/still loading/);
    gate.release();
    await until(() => ids(el)?.[0] === "remote");
    expect(el.definition.id).toBe("from-src");
    expect(heard).toHaveLength(1);
  });

  it("refuses src while an assigned definition is in place; the form and its edits stay", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const gate = gatedFetch(() => form("from-src", "remote"));
    const el = await builder((b) => {
      b.definition = form("assigned", "local") as unknown as FormDefinition;
    });
    await until(() => ids(el)?.[0] === "local");
    const heard = errorsOf(el);
    el.setAttribute("src", "/forms/a.json");
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatch(/definition .*assigned/);
    expect(gate.calls).toEqual([]);
    expect(el.src).toBeUndefined();
    await sleep(30);
    expect(ids(el)).toEqual(["local"]);
  });

  it("keeps Open and New from replacing the form while src is loading", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const gate = gatedFetch(() => form("from-src", "remote"));
    const el = await builder();
    el.src = "/forms/a.json";
    expect(() => el.fileActions.open!({ name: "f.json", text: JSON.stringify(form("opened", "opened")) })).toThrow(/still loading/);
    expect(() => el.fileActions.new!()).toThrow(/still loading/);
    gate.release();
    await until(() => ids(el)?.[0] === "remote");
  });

  it("refuses a later src once New or Open has put a form in place, as for an assigned one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const gate = gatedFetch(() => form("from-src", "remote"));
    for (const action of ["open", "new"] as const) {
      const el = await builder();
      const heard = errorsOf(el);
      if (action === "open") {
        (el.fileActions.open!({ name: "f.json", text: JSON.stringify(form("opened", "opened")) }) as () => void)();
        expect(ids(el)).toEqual(["opened"]);
      } else {
        el.fileActions.new!();
      }
      const before = el.definition.id;
      el.src = "/forms/a.json";
      expect(heard, action).toHaveLength(1);
      expect(heard[0], action).toMatch(/definition .*assigned/);
      expect(gate.calls, action).toEqual([]);
      expect(el.src, action).toBeUndefined();
      gate.release();
      await sleep(30);
      expect(el.definition.id, action).toBe(before);
      el.remove();
    }
  }, 20000);

  it("drops a src response that arrives after the author edited, with a datum-warning, and keeps the edits", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const gate = gatedFetch(() => form("from-src", "remote"));
    const el = await builder();
    const heard = errorsOf(el);
    const warnings: Array<{ code: string; message: string }> = [];
    el.addEventListener("datum-warning", (event) => warnings.push((event as CustomEvent<{ code: string; message: string }>).detail));
    el.src = "/forms/a.json";
    el.controller!.add("text");
    const edited = ids(el);
    // The new component lands before the Submit button the starting form holds.
    expect(edited).toEqual(["text_1", "submit"]);
    gate.release();
    await until(() => warnings.length > 0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe("src.superseded");
    expect(warnings[0]!.message).toContain("/forms/a.json");
    await sleep(30);
    expect(ids(el)).toEqual(edited);
    expect(el.definition.id).not.toBe("from-src");
    expect(heard).toEqual([]);
    // A later src, with no edit while it loads, lands as before.
    el.src = "/forms/b.json";
    gate.release();
    await until(() => ids(el)?.[0] === "remote");
    expect(warnings).toHaveLength(1);
  }, 20000);

  it("lets a later src replace a form an earlier src brought", async () => {
    let next = "first";
    const gate = gatedFetch(() => form(next, next));
    const el = await builder();
    const heard = errorsOf(el);
    el.src = "/forms/a.json";
    gate.release();
    await until(() => ids(el)?.[0] === "first");
    next = "second";
    el.src = "/forms/b.json";
    gate.release();
    await until(() => ids(el)?.[0] === "second");
    expect(heard).toEqual([]);
  });
});

describe("the definition byte cap", () => {
  const padded = (bytes: number) => {
    const base = form("big");
    const text = JSON.stringify({ ...base, padding: "" });
    return JSON.stringify({ ...base, padding: "x".repeat(Math.max(0, bytes - text.length)) });
  };

  it("is 2 MiB", () => {
    expect(MAX_DEFINITION_BYTES).toBe(2 * 1024 * 1024);
  });

  it("refuses a src response past the cap before parsing it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const text = padded(MAX_DEFINITION_BYTES + 10);
    const parse = vi.spyOn(JSON, "parse");
    vi.stubGlobal("fetch", async () => new Response(text, { status: 200, headers: { "content-type": "application/json" } }));
    const el = document.createElement("datum-form") as DatumFormElement;
    const heard = errorsOf(el);
    document.body.append(el);
    el.src = "/forms/big.json";
    await until(() => heard.length > 0);
    expect(heard[0]).toMatch(/up to 2 MB is read/);
    expect(el.definition).toBeUndefined();
    expect(parse.mock.calls.some(([arg]) => typeof arg === "string" && arg.length > MAX_DEFINITION_BYTES)).toBe(false);
  });

  it("refuses a src response past the cap in the builder too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const text = padded(MAX_DEFINITION_BYTES + 10);
    vi.stubGlobal("fetch", async () => new Response(text, { status: 200, headers: { "content-type": "application/json" } }));
    const b = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    const builderHeard = errorsOf(b);
    document.body.append(b);
    await until(() => b.controller);
    b.src = "/forms/big.json";
    await until(() => builderHeard.length > 0);
    expect(builderHeard[0]).toMatch(/up to 2 MB is read/);
    expect(b.definition.id).not.toBe("big");
  }, 20000);

  it("refuses a response whose Content-Length is past the cap without reading the body", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const body = vi.fn(async () => "{}");
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, statusText: "OK", headers: new Headers({ "content-length": String(MAX_DEFINITION_BYTES + 1) }), text: body }) as unknown as Response);
    const el = document.createElement("datum-form") as DatumFormElement;
    const heard = errorsOf(el);
    document.body.append(el);
    el.src = "/forms/big.json";
    await until(() => heard.length > 0);
    expect(heard[0]).toMatch(/up to 2 MB is read/);
    expect(body).not.toHaveBeenCalled();
  });

  it("refuses an Open file past the cap before parsing it, and the form stays", async () => {
    const b = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    b.definition = form("keep") as unknown as FormDefinition;
    document.body.append(b);
    await until(() => b.controller);
    const parse = vi.spyOn(JSON, "parse");
    // Multi-byte characters count as bytes: this text is under the cap in UTF-16 units, past it in UTF-8.
    const base = JSON.stringify(form("big"));
    const text = base.replace(/}$/, `,"padding":"${"é".repeat(MAX_DEFINITION_BYTES / 2)}"}`);
    expect(text.length).toBeLessThan(MAX_DEFINITION_BYTES + base.length + 20);
    expect(() => b.fileActions.open!({ name: "big.json", text })).toThrow(/up to 2 MB is read/);
    expect(parse.mock.calls.some(([arg]) => arg === text)).toBe(false);
    expect(b.definition.id).toBe("keep");
  });

  it("takes the page's own cap from max-definition-bytes and maxDefinitionBytes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const text = padded(4000);
    vi.stubGlobal("fetch", async () => new Response(text, { status: 200, headers: { "content-type": "application/json" } }));
    const el = document.createElement("datum-form") as DatumFormElement;
    const heard = errorsOf(el);
    el.setAttribute("max-definition-bytes", "1000");
    expect(el.maxDefinitionBytes).toBe(1000);
    document.body.append(el);
    el.src = "/forms/big.json";
    await until(() => heard.length > 0);
    expect(heard[0]).toMatch(/up to 1,000 bytes is read/);
    el.src = undefined;
    el.maxDefinitionBytes = 3 * 1024 * 1024;
    el.src = "/forms/big.json";
    await until(() => el.definition?.id === "big");

    const b = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    b.maxDefinitionBytes = 1000;
    document.body.append(b);
    await until(() => b.controller);
    expect(() => b.fileActions.open!({ name: "big.json", text })).toThrow(/up to 1,000 bytes is read/);
    b.removeAttribute("max-definition-bytes");
    b.setAttribute("max-definition-bytes", "5000");
    expect(b.maxDefinitionBytes).toBe(5000);
    expect(() => (b.fileActions.open!({ name: "big.json", text }) as () => void)()).not.toThrow();
    await until(() => b.definition.id === "big");
  });

  it("reads max-definition-bytes when the response arrives, whichever attribute the markup gives first", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const text = padded(4000);
    vi.stubGlobal("fetch", async () => new Response(text, { status: 200, headers: { "content-type": "application/json" } }));
    // Upgraded with both attributes already there, `src` first: its callback runs before the cap's.
    const template = document.createElement("template");
    template.innerHTML = '<div><datum-form src="/forms/big.json" max-definition-bytes="1000"></datum-form><datum-form-builder src="/forms/big.json" max-definition-bytes="1000"></datum-form-builder></div>';
    const host = template.content.firstElementChild!;
    const el = host.querySelector("datum-form") as DatumFormElement;
    const b = host.querySelector("datum-form-builder") as DatumFormBuilderElement;
    const heard = errorsOf(el);
    const builderHeard = errorsOf(b);
    document.body.append(host);
    expect(el.maxDefinitionBytes).toBe(1000);
    await until(() => heard.length > 0 && builderHeard.length > 0);
    expect(heard[0]).toMatch(/up to 1,000 bytes is read/);
    expect(builderHeard[0]).toMatch(/up to 1,000 bytes is read/);
    expect(el.definition).toBeUndefined();
    expect(b.definition.id).not.toBe("big");
  }, 20000);

  it("hands the builder's cap to the bar's own Open, which measures the file before reading it", async () => {
    const b = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    b.setAttribute("max-definition-bytes", "5000");
    document.body.append(b);
    await until(() => b.builder);
    expect(b.builder!.maxDefinitionBytes).toBe(5000);
    b.maxDefinitionBytes = 9000;
    expect(b.builder!.maxDefinitionBytes).toBe(9000);
    b.removeAttribute("max-definition-bytes");
    expect(b.builder!.maxDefinitionBytes).toBe(MAX_DEFINITION_BYTES);
  }, 20000);

  it("reports an unusable max-definition-bytes and keeps the cap it had", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const el = document.createElement("datum-form") as DatumFormElement;
    const heard = errorsOf(el);
    el.setAttribute("max-definition-bytes", "lots");
    expect(heard[0]).toMatch(/max-definition-bytes/);
    expect(el.maxDefinitionBytes).toBe(MAX_DEFINITION_BYTES);
    el.setAttribute("max-definition-bytes", "1000");
    el.removeAttribute("max-definition-bytes");
    expect(el.maxDefinitionBytes).toBe(MAX_DEFINITION_BYTES);
  });
});

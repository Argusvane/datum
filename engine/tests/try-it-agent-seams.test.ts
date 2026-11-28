// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { BuilderPreviewRuntime } from "../form-engine/builder/preview/builder-preview-runtime.js";
import { checkAnswerErrors, createTryIt } from "../form-engine/builder/web-component/try-it.js";
import type { BuilderTrySession } from "../form-engine/builder/web-component/builder-modes.js";
import type { BuilderTrySubmitDetail, TryItController, TryItServerChecks } from "../form-engine/builder/web-component/try-it-types.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * Try it's agent seams in the chunk: `check()` is the panel's own Check,
 * drawing what the person's press draws and handing it back; `submitForAgent()` is the panel's
 * own Submit, answering with what `builder-try-submit` carries, moving no focus while the
 * person's focus is outside the canvas, and one at a time.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const tree: ComponentNode = {
  id: "root",
  type: "form",
  configuration: { title: "Contact" },
  children: {
    content: [
      { id: "fullName", type: "text", configuration: { label: "Full name", required: true } },
      { id: "email", type: "text", configuration: { label: "Email", required: true } },
      { id: "send", type: "button", configuration: { label: "Send", action: "submit" } }
    ]
  }
};

interface RendererStub {
  notice: unknown;
  submitting: boolean;
  submittingPlacement: unknown;
  texts: unknown;
  focusFirstError: ReturnType<typeof vi.fn>;
  focusNotice: ReturnType<typeof vi.fn>;
  revealComponent: ReturnType<typeof vi.fn>;
  quietNextPageFocus: ReturnType<typeof vi.fn>;
  released: number;
}

function rendererStub(): RendererStub {
  const stub: RendererStub = {
    notice: undefined,
    submitting: false,
    submittingPlacement: undefined,
    texts: undefined,
    focusFirstError: vi.fn(),
    focusNotice: vi.fn(),
    revealComponent: vi.fn(),
    quietNextPageFocus: vi.fn(() => () => {
      stub.released += 1;
    }),
    released: 0
  };
  return stub;
}

interface Made {
  tryIt: TryItController;
  canvas: HTMLElement;
  panel: HTMLElement;
  /** A box inside the canvas's shadow root: focus there is the person's in the canvas. */
  inside: HTMLInputElement;
  controller: BuilderController;
  preview: BuilderPreviewRuntime;
  renderer: RendererStub;
  submits: BuilderTrySubmitDetail[];
}

/** A canvas (a host with a shadow root holding the Try panel), the chunk made over it, and a chat box beside it on the page. */
function made(options: { answers?: Record<string, unknown>; session?: BuilderTrySession; serverChecks?: TryItServerChecks } = {}): Made {
  const canvas = document.createElement("div");
  const root = canvas.attachShadow({ mode: "open" });
  root.innerHTML = `<div data-try-panel></div><input data-inside>`;
  document.body.append(canvas);
  const chat = document.createElement("input");
  chat.setAttribute("data-chat", "");
  document.body.append(chat);
  const controller = new BuilderController({ initialRoot: tree });
  controller.setTrySubmission({ delayMs: 0 });
  const preview = new BuilderPreviewRuntime(tree, { locale: "en" });
  for (const [id, value] of Object.entries(options.answers ?? {})) {
    preview.setValue(id, value);
  }
  const renderer = rendererStub();
  const submits: BuilderTrySubmitDetail[] = [];
  canvas.addEventListener("builder-try-submit", (event) => submits.push((event as CustomEvent<BuilderTrySubmitDetail>).detail));
  const tryIt = createTryIt({
    canvas,
    root: () => root,
    controller: () => controller,
    preview: () => preview,
    renderer: () => renderer as never,
    trySettings: () => controller,
    serverChecks: () => options.serverChecks,
    pdf: () => undefined,
    mode: () => "interactive",
    setMode: () => undefined,
    ...(options.session ? { session: () => options.session } : {})
  });
  return {
    tryIt,
    canvas,
    panel: root.querySelector<HTMLElement>("[data-try-panel]")!,
    inside: root.querySelector<HTMLInputElement>("[data-inside]")!,
    controller,
    preview,
    renderer,
    submits
  };
}

/** The panel's Check now, pressed as the person presses it. */
async function pressCheck(made: Made): Promise<void> {
  made.tryIt.click([{ dataset: { tryCheck: "" } } as unknown as HTMLElement]);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The problems the panel draws, as the person reads them. */
function drawnProblems(panel: HTMLElement): string[] {
  return [...panel.querySelectorAll(".try-problems li")].map((item) => item.textContent?.replace(/\s+/g, " ").trim() ?? "");
}

/** Focus on the chat beside the builder: the person is not in the canvas. */
function focusOutside(): void {
  document.querySelector<HTMLInputElement>("[data-chat]")!.focus();
  expect(document.hasFocus()).toBe(true);
}

describe("check(): the panel's own Check, handed back", () => {
  it("draws what the person's Check draws and returns those problems", async () => {
    const agent = made({ answers: { email: "ana@example.org" } });
    const person = made({ answers: { email: "ana@example.org" } });
    agent.panel.innerHTML = "";
    person.panel.innerHTML = "";

    const outcome = await agent.tryIt.check();
    await pressCheck(person);

    expect(outcome.server).toBe("off");
    expect(outcome.problems).toEqual([{ componentId: "fullName", label: "Full name", message: expect.any(String) }]);
    // The same panel, drawn by the same body.
    expect(agent.panel.innerHTML).not.toBe("");
    expect(agent.panel.innerHTML).toBe(person.panel.innerHTML);
    expect(drawnProblems(agent.panel)).toHaveLength(1);
    expect(drawnProblems(agent.panel)[0]).toContain(outcome.problems[0]!.message);
  });

  it("answers no problems on answers the form takes, and the panel says so as the person's Check does", async () => {
    const agent = made({ answers: { fullName: "Ana", email: "ana@example.org" } });
    const person = made({ answers: { fullName: "Ana", email: "ana@example.org" } });
    const outcome = await agent.tryIt.check();
    await pressCheck(person);
    expect(outcome).toEqual({ problems: [], server: "off" });
    expect(agent.panel.innerHTML).toBe(person.panel.innerHTML);
  });

  it("adds the server's lines when the person turned its checks on, and reports that they ran", async () => {
    const serverChecks: TryItServerChecks = {
      label: "Sandbox",
      run: async () => ({ errors: [{ componentId: "email", code: "domain", message: "Use your work address.", path: "email" }] as never })
    };
    const agent = made({ answers: { fullName: "Ana", email: "ana@example.org" }, serverChecks });
    expect(agent.tryIt.serverChecksOn()).toBe(false);
    // The person's own switch: an agent never turns it on.
    agent.tryIt.click([{ dataset: { tryServer: "" }, type: "checkbox", checked: true } as unknown as HTMLElement]);
    await vi.waitFor(() => expect(agent.tryIt.serverChecksOn()).toBe(true));
    const outcome = await agent.tryIt.check();
    expect(outcome.server).toBe("ran");
    expect(outcome.problems).toEqual([{ componentId: "email", label: "Email", message: expect.any(String) }]);
  });

  it("says a problem the browser and the server both found once", async () => {
    // The server runs the same field rules the browser does over the answers, and one of its own.
    const serverChecks: TryItServerChecks = {
      run: async ({ root, answers, locale }) => ({
        errors: [
          ...checkAnswerErrors(root, answers, { locale, required: new Map([["fullName", true], ["email", true]]), hidden: () => false }),
          { componentId: "email", code: "domain", message: "Use your work address.", path: "email" }
        ] as never
      })
    };
    const agent = made({ answers: { email: "ana@example.org" }, serverChecks });
    agent.tryIt.click([{ dataset: { tryServer: "" }, type: "checkbox", checked: true } as unknown as HTMLElement]);
    await vi.waitFor(() => expect(agent.tryIt.serverChecksOn()).toBe(true));
    const outcome = await agent.tryIt.check();
    expect(outcome.server).toBe("ran");
    expect(outcome.problems.map((problem) => problem.componentId)).toEqual(["fullName", "email"]);
    expect(outcome.problems.filter((problem) => problem.componentId === "fullName")).toHaveLength(1);
  });

  it("reads the switch on while the validator the person turned on loads, and checks with it once it lands", async () => {
    let land!: () => void;
    const landed = new Promise<void>((resolve) => (land = resolve));
    const loaded: TryItServerChecks = {
      run: async () => ({ errors: [{ componentId: "email", code: "domain", message: "Use your work address.", path: "email" }] as never })
    };
    const agent = made({
      answers: { fullName: "Ana", email: "ana@example.org" },
      serverChecks: (async () => {
        await landed;
        return loaded;
      }) as never
    });
    expect(agent.tryIt.serverChecksOn()).toBe(false);
    agent.tryIt.click([{ dataset: { tryServer: "" }, type: "checkbox", checked: true } as unknown as HTMLElement]);
    // The panel draws the switch on (and busy) from the tick: so does what an agent reads.
    expect(agent.tryIt.serverChecksOn()).toBe(true);
    let settled = false;
    const checking = agent.tryIt.check().then((outcome) => {
      settled = true;
      return outcome;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    land();
    const outcome = await checking;
    expect(outcome.server).toBe("ran");
    expect(outcome.problems).toEqual([{ componentId: "email", label: "Email", message: expect.any(String) }]);
  });

  it("reports a validator the person turned on that failed to load while the check waited as failed", async () => {
    let refuse!: () => void;
    const refused = new Promise<void>((resolve) => (refuse = resolve));
    const agent = made({
      answers: { fullName: "Ana", email: "ana@example.org" },
      serverChecks: (async () => {
        await refused;
        throw new Error("sandbox missing");
      }) as never
    });
    agent.tryIt.click([{ dataset: { tryServer: "" }, type: "checkbox", checked: true } as unknown as HTMLElement]);
    const checking = agent.tryIt.check();
    refuse();
    expect(await checking).toEqual({ problems: [], server: "failed" });
    expect(agent.tryIt.serverChecksOn()).toBe(false);
    // Failed only for the check that waited on that load: the switch is drawn off since, so a
    // later check reads it off, as the panel shows it.
    expect(await agent.tryIt.check()).toEqual({ problems: [], server: "off" });
  });

  it("leaves the server's checks off when the person turns them off while a run is under way", async () => {
    let answer!: () => void;
    const serverChecks: TryItServerChecks = {
      run: () =>
        new Promise((resolve) => {
          answer = () => resolve({ errors: [{ componentId: "email", code: "domain", message: "Use your work address.", path: "email" }] as never });
        })
    };
    const agent = made({ answers: { fullName: "Ana", email: "ana@example.org" }, serverChecks });
    agent.tryIt.click([{ dataset: { tryServer: "" }, type: "checkbox", checked: true } as unknown as HTMLElement]);
    await vi.waitFor(() => expect(answer).toBeDefined());
    agent.tryIt.click([{ dataset: { tryServer: "" }, type: "checkbox", checked: false } as unknown as HTMLElement]);
    expect(agent.tryIt.serverChecksOn()).toBe(false);
    answer();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agent.tryIt.serverChecksOn()).toBe(false);
    expect(agent.panel.textContent).not.toContain("Use your work address.");
  });

  it("still hands an older check its own server answer when a newer run started while it waited", async () => {
    const answers: Array<() => void> = [];
    const serverChecks: TryItServerChecks = {
      run: () =>
        new Promise((resolve) => {
          answers.push(() => resolve({ errors: [{ componentId: "email", code: "domain", message: "Use your work address.", path: "email" }] as never }));
        })
    };
    const agent = made({ answers: { fullName: "Ana", email: "ana@example.org" }, serverChecks });
    agent.tryIt.click([{ dataset: { tryServer: "" }, type: "checkbox", checked: true } as unknown as HTMLElement]);
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    answers[0]!();
    await vi.waitFor(() => expect(agent.tryIt.serverChecksOn()).toBe(true));
    const older = agent.tryIt.check();
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    const newer = agent.tryIt.check();
    await vi.waitFor(() => expect(answers).toHaveLength(3));
    answers[1]!();
    const outcome = await older;
    expect(outcome.server).toBe("ran");
    expect(outcome.problems).toEqual([{ componentId: "email", label: "Email", message: expect.any(String) }]);
    answers[2]!();
    expect((await newer).server).toBe("ran");
  });

  it("reports a server check that was on and did not answer as failed", async () => {
    const serverChecks: TryItServerChecks = {
      run: async () => {
        throw new Error("sandbox down");
      }
    };
    const agent = made({ answers: { fullName: "Ana", email: "ana@example.org" }, serverChecks });
    agent.tryIt.click([{ dataset: { tryServer: "" }, type: "checkbox", checked: true } as unknown as HTMLElement]);
    await vi.waitFor(() => expect(agent.tryIt.serverChecksOn()).toBe(true));
    expect(await agent.tryIt.check()).toEqual({ problems: [], server: "failed" });
  });
});

describe("submitForAgent(): the panel's own Submit, quiet while the person is elsewhere", () => {
  it("moves no focus on answers the checks refuse, and builder-try-submit still fires", async () => {
    const agent = made({ answers: { email: "ana@example.org" } });
    focusOutside();
    const outcome = await agent.tryIt.submitForAgent();
    expect(outcome).toEqual({ outcome: "invalid", answers: expect.objectContaining({ email: "ana@example.org" }) });
    expect(agent.submits).toEqual([outcome]);
    expect(agent.renderer.focusFirstError).not.toHaveBeenCalled();
    expect(agent.renderer.focusNotice).not.toHaveBeenCalled();
    expect(agent.renderer.revealComponent).not.toHaveBeenCalled();
    expect(document.activeElement?.hasAttribute("data-chat")).toBe(true);
    // The errors are on the form all the same.
    expect(agent.preview.errors().map((error) => error.componentId)).toEqual(["fullName"]);
  });

  it("moves no focus to the receipt of an accepted Submit, nor to a refusal", async () => {
    const accepted = made({ answers: { fullName: "Ana", email: "ana@example.org" } });
    focusOutside();
    const outcome = await accepted.tryIt.submitForAgent();
    expect(outcome).toMatchObject({ outcome: "accepted" });
    expect(accepted.submits).toEqual([outcome]);
    expect(accepted.renderer.focusNotice).not.toHaveBeenCalled();

    const refused = made({ answers: { fullName: "Ana", email: "ana@example.org" } });
    refused.controller.setTrySubmission({ outcome: "refuse", refusalMessage: "Closed today." });
    focusOutside();
    expect(await refused.tryIt.submitForAgent()).toMatchObject({ outcome: "refused" });
    expect(refused.renderer.focusFirstError).not.toHaveBeenCalled();
    expect(refused.submits).toHaveLength(1);
  });

  it("moves focus as the person's Submit does while the person's focus is in the canvas", async () => {
    const agent = made({ answers: { email: "ana@example.org" } });
    agent.inside.focus();
    expect(document.activeElement).toBe(agent.canvas);
    expect(await agent.tryIt.submitForAgent()).toMatchObject({ outcome: "invalid" });
    expect(agent.renderer.focusFirstError).toHaveBeenCalledTimes(1);

    const accepted = made({ answers: { fullName: "Ana", email: "ana@example.org" } });
    accepted.inside.focus();
    expect(await accepted.tryIt.submitForAgent()).toMatchObject({ outcome: "accepted" });
    expect(accepted.renderer.focusNotice).toHaveBeenCalledTimes(1);
  });

  it("moves no focus while the page lacks focus, though it left focus in the canvas (the browser's assistant panel)", async () => {
    const agent = made({ answers: { email: "ana@example.org" } });
    agent.inside.focus();
    expect(document.activeElement).toBe(agent.canvas);
    const away = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    expect(await agent.tryIt.submitForAgent()).toMatchObject({ outcome: "invalid" });
    expect(agent.renderer.focusFirstError).not.toHaveBeenCalled();
    expect(agent.renderer.revealComponent).not.toHaveBeenCalled();
    expect(agent.submits).toHaveLength(1);

    const accepted = made({ answers: { fullName: "Ana", email: "ana@example.org" } });
    accepted.inside.focus();
    expect(await accepted.tryIt.submitForAgent()).toMatchObject({ outcome: "accepted" });
    expect(accepted.renderer.focusNotice).not.toHaveBeenCalled();
    away.mockRestore();
    // Back on the page with focus in the canvas: loud again.
    agent.inside.focus();
    expect(document.hasFocus()).toBe(true);
    expect(await agent.tryIt.submitForAgent()).toMatchObject({ outcome: "invalid" });
    expect(agent.renderer.focusFirstError).toHaveBeenCalledTimes(1);
  });

  it("leaves the person's own Submit as it was: it focuses the first error wherever focus is", async () => {
    const person = made({ answers: { email: "ana@example.org" } });
    focusOutside();
    await person.tryIt.submit();
    expect(person.renderer.focusFirstError).toHaveBeenCalledTimes(1);
    expect(person.submits.map((detail) => detail.outcome)).toEqual(["invalid"]);
    expect(person.renderer.quietNextPageFocus).not.toHaveBeenCalled();
  });

  it("quiets a mode session's page move, and reveals nothing the server alone found", async () => {
    const runtime = new BuilderPreviewRuntime(tree, { locale: "en" });
    runtime.setValue("fullName", "Ana");
    runtime.setValue("email", "ana@example.org");
    const session: BuilderTrySession = {
      runtime: runtime as never,
      answers: () => ({ fullName: "Ana", email: "ana@example.org" }),
      submit: async () => ({ problems: [] }),
      refresh: () => undefined,
      restart: () => undefined,
      dispose: () => undefined
    };
    const serverChecks: TryItServerChecks = {
      run: async () => ({ errors: [{ componentId: "email", code: "domain", message: "Use your work address.", path: "email" }] as never })
    };
    const agent = made({ session, serverChecks });
    // Whether a quiet is held at each call that can move a journey's page: the session's submit,
    // and the errors put on its runtime (a journey's `setErrors` moves to the earliest page
    // holding one, after the submit's own quiet was released).
    const held = (): boolean => agent.renderer.quietNextPageFocus.mock.calls.length > agent.renderer.released;
    const quietAt: Array<{ call: string; held: boolean }> = [];
    session.submit = async () => {
      quietAt.push({ call: "submit", held: held() });
      return { problems: [] };
    };
    const setErrors = runtime.setErrors.bind(runtime);
    vi.spyOn(runtime, "setErrors").mockImplementation((errors) => {
      if (errors.length > 0) {
        quietAt.push({ call: "setErrors", held: held() });
      }
      return setErrors(errors);
    });
    agent.tryIt.click([{ dataset: { tryServer: "" }, type: "checkbox", checked: true } as unknown as HTMLElement]);
    await vi.waitFor(() => expect(agent.tryIt.serverChecksOn()).toBe(true));
    focusOutside();
    expect(await agent.tryIt.submitForAgent()).toMatchObject({ outcome: "invalid" });
    expect(quietAt).toEqual([
      { call: "submit", held: true },
      { call: "setErrors", held: true }
    ]);
    // Twice, each released once its call settled: no quiet is left for a later page change.
    expect(agent.renderer.quietNextPageFocus).toHaveBeenCalledTimes(2);
    expect(agent.renderer.released).toBe(2);
    expect(agent.renderer.revealComponent).not.toHaveBeenCalled();
    expect(agent.renderer.focusFirstError).not.toHaveBeenCalled();

    // The person's Submit over the same session reveals the field the server named and focuses it.
    await agent.tryIt.submit();
    expect(agent.renderer.revealComponent).toHaveBeenCalledWith("email");
    expect(agent.renderer.focusFirstError).toHaveBeenCalledTimes(1);
  });

  it("answers busy at once while a Submit is in flight, the agent's or the person's", async () => {
    const agent = made({ answers: { fullName: "Ana", email: "ana@example.org" } });
    agent.controller.setTrySubmission({ delayMs: 40 });
    focusOutside();
    const first = agent.tryIt.submitForAgent();
    expect(await agent.tryIt.submitForAgent()).toEqual({ state: "busy" });
    expect(await first).toMatchObject({ outcome: "accepted" });
    expect(agent.submits).toHaveLength(1);

    const person = agent.tryIt.submit();
    expect(await agent.tryIt.submitForAgent()).toEqual({ state: "busy" });
    await person;
    expect(agent.submits).toHaveLength(2);
  });

  it("rejects a Submit dropped before the stand-in answered, and one with no form to submit", async () => {
    const agent = made({ answers: { fullName: "Ana", email: "ana@example.org" } });
    agent.controller.setTrySubmission({ delayMs: 40 });
    focusOutside();
    const dropped = agent.tryIt.submitForAgent();
    // Back to editing drops it, as for the person's.
    agent.tryIt.clearSubmit();
    await expect(dropped).rejects.toThrow(/dropped/);
    expect(agent.submits).toHaveLength(0);

    const bare = createTryIt({
      canvas: document.createElement("div"),
      root: () => document.createElement("div").attachShadow({ mode: "open" }),
      controller: () => undefined,
      preview: () => undefined,
      renderer: () => undefined,
      trySettings: () => undefined,
      serverChecks: () => undefined,
      pdf: () => undefined,
      mode: () => "interactive",
      setMode: () => undefined
    });
    await expect(bare.submitForAgent()).rejects.toThrow(/no form/);
    expect(await bare.check()).toEqual({ problems: [], server: "off" });
  });
});

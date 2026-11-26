// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { guardRemoteImages, isRemoteImage, newRemoteLoadToken } from "../form-engine/builder/web-component/remote-images.js";
import { sanitizeStaticHtml } from "../form-engine/core/schema/static-html.js";

const page = { href: "https://app.example/builder/", origin: "https://app.example" };
const words = () => ({ load: "Load", confirm: "Sure?" });

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("isRemoteImage", () => {
  it.each([
    ["/a.png", false],
    ["a.png", false],
    ["https://app.example/x.png", false],
    ["data:image/png;base64,AAA", false],
    ["blob:https://app.example/1", false],
    ["https://evil.example/x.png", true],
    ["//evil.example/x.png", true],
    ["HTTPS://EVIL.EXAMPLE/x.png", true],
    ["https://app.example:8443/x.png", true],
    ["http://app.example/x.png", true],
    ["javascript:alert(1)", true]
  ])("%s -> %s", (src, expected) => {
    expect(isRemoteImage(src, page)).toBe(expected);
  });
});

function mount(): ShadowRoot {
  const host = document.createElement("div");
  document.body.append(host);
  return host.attachShadow({ mode: "open" });
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("guardRemoteImages", () => {
  // the confirmation belongs to one load, not to the definition's id.
  it("asks again for a second load of the same definition id", async () => {
    vi.stubGlobal("confirm", () => true);
    const root = mount();
    let token = newRemoteLoadToken();
    guardRemoteImages(root, { documentId: () => token, words });
    root.innerHTML = '<img src="https://a.example/1.png">';
    await tick();
    (root.querySelector("[data-remote-load]") as HTMLElement).click();
    expect(root.querySelector("img")!.getAttribute("src")).toBe("https://a.example/1.png");
    token = newRemoteLoadToken();
    root.innerHTML = '<img src="https://evil.example/2.png">';
    await tick();
    expect(root.querySelector("img")!.hasAttribute("src")).toBe(false);
    expect(root.querySelector("img")!.dataset.remoteSrc).toBe("https://evil.example/2.png");
    expect(root.querySelector("[data-remote-load]")).not.toBeNull();
  });

  // The live renderer keeps the <img> and rewrites its src in place on the next load.
  it("holds a src rewritten in place on the same <img> after another load", async () => {
    vi.stubGlobal("confirm", () => true);
    const root = mount();
    let token = newRemoteLoadToken();
    guardRemoteImages(root, { documentId: () => token, words });
    root.innerHTML = '<img src="https://a.example/1.png">';
    await tick();
    (root.querySelector("[data-remote-load]") as HTMLElement).click();
    const image = root.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("https://a.example/1.png");
    token = newRemoteLoadToken();
    image.setAttribute("src", "https://evil.example/2.png");
    await tick();
    expect(root.querySelector("img")).toBe(image);
    expect(image.hasAttribute("src")).toBe(false);
    expect(image.dataset.remoteSrc).toBe("https://evil.example/2.png");
    expect(root.querySelector("[data-remote-load]")).not.toBeNull();
  });

  it("refreshes a held picture's parked address when its src is rewritten, and drops it for a local one", async () => {
    const root = mount();
    guardRemoteImages(root, { documentId: () => newRemoteLoadToken(), words });
    root.innerHTML = '<img src="https://a.example/1.png">';
    await tick();
    const image = root.querySelector("img")!;
    expect(image.dataset.remoteSrc).toBe("https://a.example/1.png");
    image.setAttribute("src", "https://evil.example/2.png");
    await tick();
    expect(image.hasAttribute("src")).toBe(false);
    expect(image.dataset.remoteSrc).toBe("https://evil.example/2.png");
    expect(root.querySelectorAll("[data-remote-load]")).toHaveLength(1);
    image.setAttribute("src", "/local.png");
    await tick();
    expect(image.getAttribute("src")).toBe("/local.png");
    expect(image.hasAttribute("data-remote-src")).toBe(false);
    expect(root.querySelector("[data-remote-load]")).toBeNull();
  });

  it("holds a style attribute rewritten in place", async () => {
    const root = mount();
    guardRemoteImages(root, { documentId: () => "t", words });
    root.innerHTML = '<div style="color:red"></div>';
    await tick();
    const node = root.querySelector("div")!;
    node.setAttribute("style", "background:url(https://evil.example/s.png)");
    await tick();
    expect(node.getAttribute("style")).not.toContain("evil.example");
    expect(node.getAttribute("data-remote-style")).toContain("evil.example/s.png");
  });

  // author css and theme tokens are held like pictures.
  it("holds remote css url() in style elements and style attributes until confirmed", async () => {
    vi.stubGlobal("confirm", () => true);
    const root = mount();
    guardRemoteImages(root, { documentId: () => "t", words });
    root.innerHTML =
      '<style>.a{background:url(https://evil.example/b.png)} .b{color:red}</style><img src="/x.png"><div style="--bg:url(&quot;//evil.example/c.png&quot;)"></div><button data-remote-load></button>';
    await tick();
    const style = root.querySelector("style")!;
    expect(style.textContent).not.toContain("evil.example");
    expect(style.textContent).toContain("color:red");
    expect(root.querySelector("div")!.getAttribute("style")).not.toContain("evil.example");
    (root.querySelector("[data-remote-load]") as HTMLElement).click();
    expect(style.textContent).toContain("https://evil.example/b.png");
    expect(root.querySelector("div")!.getAttribute("style")).toContain("evil.example/c.png");
  });

  it("leaves local css urls alone", async () => {
    const root = mount();
    guardRemoteImages(root, { documentId: () => "t", words });
    root.innerHTML = "<style>.a{background:url(/a.png)} .b{background:url(data:image/png;base64,AA)}</style>";
    await tick();
    expect(root.querySelector("style")!.textContent).toContain("url(/a.png)");
    expect(root.querySelector("style")!.hasAttribute("data-remote-css")).toBe(false);
  });

  it("stops watching when disposed", async () => {
    const root = mount();
    const dispose = guardRemoteImages(root, { documentId: () => "t", words });
    dispose();
    root.innerHTML = '<img src="https://a.example/1.png">';
    await tick();
    expect(root.querySelector("img")!.getAttribute("src")).toBe("https://a.example/1.png");
  });
});

describe("html component images", () => {
  it("carry referrerpolicy no-referrer", () => {
    expect(sanitizeStaticHtml('<img src="https://a.example/x.png" referrerpolicy="unsafe-url">')).toBe(
      '<img src="https://a.example/x.png" referrerpolicy="no-referrer" />'
    );
  });
});

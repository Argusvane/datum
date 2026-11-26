import { describe, expect, it } from "vitest";

import { phoneMenuButtonName, phoneMenuRowHtml, phoneMenuSectionsHtml } from "../form-engine/builder/web-component/phone-menu.js";

/** The phone tier's menu drawer: what its rows say to a screen reader and draw. */
describe("the phone's menu drawer rows", () => {
  it("names a row with its problems and marks the current one", () => {
    const row = phoneMenuRowHtml({ go: "workspace:data", label: "Data", count: 2, current: true });
    expect(row.startsWith("<button")).toBe(true);
    expect(row).toContain('data-menu-go="workspace:data"');
    expect(row).toContain('aria-label="Data, 2 problems"');
    expect(row).toContain('aria-current="true"');
    expect(row).toContain('<span class="menu-count" aria-hidden="true">2</span>');
    // No problems: the label is the name, and nothing is drawn after it.
    const quiet = phoneMenuRowHtml({ go: "workspace:logic", label: "Logic", count: 0 });
    expect(quiet).not.toContain("aria-label");
    expect(quiet).not.toContain("menu-count");
  });

  it("draws a switch as role switch with its state, and escapes what it is given", () => {
    const row = phoneMenuRowHtml({ go: "show-hidden", label: "Show <hidden>", checked: false, attributes: { "data-menu-document": 'a"b' } });
    expect(row).toContain('role="switch" aria-checked="false"');
    expect(row).toContain("Show &lt;hidden&gt;");
    expect(row).toContain('data-menu-document="a&quot;b"');
    expect(row).toContain('class="menu-switch"');
  });

  it("leaves out a section with no rows", () => {
    const html = phoneMenuSectionsHtml([
      { id: "file", heading: "File", rows: [] },
      { id: "tools", heading: "Tools", rows: [{ go: "search", label: "Search commands…", shortcut: "Ctrl+K" }] }
    ]);
    expect(html).not.toContain('data-menu-section="file"');
    expect(html).toContain('data-menu-section="tools"');
    expect(html).toContain('<h2 class="menu-heading" id="menu-heading-tools">Tools</h2>');
    expect(html).toContain('<kbd class="menu-row-key">Ctrl+K</kbd>');
  });

  it("names the Menu button by the workspace", () => {
    expect(phoneMenuButtonName("Form", 0)).toBe("Menu. Form workspace");
    expect(phoneMenuButtonName("PDF", 1)).toBe("Menu. PDF workspace, 1 problem");
  });
});

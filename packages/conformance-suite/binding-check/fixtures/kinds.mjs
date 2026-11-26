import { form } from "./_util.mjs";
// A design system's own (tier-2) types, read as engine types through the definition's `kinds`
// map: none of them is drawn by any binding, so each falls back to its base.
export default {
  id: "kinds", title: "Tier-2 types mapped to their engine base (kinds map)",
  definition: form([
    { id: "kxText", type: "kx-text", configuration: { label: "Mapped text", required: true } },
    { id: "kxArea", type: "kx-textarea", configuration: { label: "Mapped textarea" } },
    { id: "kxSelect", type: "kx-select", configuration: { label: "Mapped select", options: [{ value: "ON", label: "Ontario" }, { value: "QC", label: "Quebec" }] } },
    { id: "kxRadio", type: "kx-radio", configuration: { label: "Mapped radio", options: [{ value: "email", label: "Email" }, { value: "phone", label: "Phone" }] } },
    { id: "kxChecks", type: "kx-checkboxes", configuration: { label: "Mapped checkboxes", options: [{ value: "email", label: "Email" }, { value: "post", label: "Post" }] } },
    { id: "kxDate", type: "kx-date", configuration: { label: "Mapped date", required: true } },
    { id: "kxGroup", type: "kx-fieldset", configuration: { label: "Mapped group" }, children: { content: [
      { id: "kxInner", type: "text", configuration: { label: "Inside the mapped group" } }
    ] } },
    { id: "kxTabs", type: "kx-tabs", configuration: { label: "Mapped tabs", tabs: [{ id: "one", label: "One" }, { id: "two", label: "Two" }] }, children: {
      one: [{ id: "kxOneField", type: "text", configuration: { label: "In tab one" } }],
      two: [{ id: "kxTwoField", type: "text", configuration: { label: "In tab two" } }]
    } }
  ], { kinds: { "kx-text": "text", "kx-textarea": "textarea", "kx-select": "select", "kx-radio": "radio", "kx-checkboxes": "checkboxes", "kx-date": "date", "kx-fieldset": "fieldset", "kx-tabs": "tabs" } })
};

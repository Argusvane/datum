// A binding whose text fields draw a label and no control.
export const createBinding = (lit, datum) => {
  const entry = datum.components.text;
  const adapters = Array.isArray(entry) ? entry : [entry];
  const broken = adapters.map((adapter) => ({ ...adapter, template: (state) => lit.html`<p>${state.label ?? ""} (no control)</p>` }));
  return { ...datum, id: "broken", components: { ...datum.components, text: Array.isArray(entry) ? broken : broken[0] } };
};

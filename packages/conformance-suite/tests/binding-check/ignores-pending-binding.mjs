// A binding whose text fields answer pending "drawn" and then draw nothing for it: the renderer leaves the
// word out of the hint for a "drawn" answer, so no description of the control changes while its check runs.
export const createBinding = (lit, datum) => {
  const entry = datum.components.text;
  const adapters = Array.isArray(entry) ? entry : [entry];
  const ignoring = adapters.map((adapter) => ({
    ...adapter,
    capabilities: { ...adapter.capabilities, pending: "drawn" },
    template: (state, ...rest) => adapter.template({ ...state, pending: false }, ...rest)
  }));
  return { ...datum, id: "ignores-pending", components: { ...datum.components, text: Array.isArray(entry) ? ignoring : ignoring[0] } };
};

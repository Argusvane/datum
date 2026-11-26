import { form } from "./_util.mjs";
// Fields that exercise each state hook and the DOM contract: required and optional, a count limit,
// a choice, a date, a container around a field, and a data grid with rows.
export default {
  id: "hooks", title: "State hooks and the DOM contract (required, invalid, over the limit, container, grid rows)",
  definition: form([
    { id: "hReq", type: "text", configuration: { label: "Required answer", required: true } },
    { id: "hOpt", type: "text", configuration: { label: "Optional answer" } },
    { id: "hLimit", type: "text", configuration: { label: "Limited answer", maxLength: 10, characterCount: true } },
    { id: "hChoice", type: "radio", configuration: { label: "A choice", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] } },
    { id: "hDate", type: "date", configuration: { label: "A date" } },
    { id: "hBox", type: "fieldset", configuration: { label: "A group" }, children: { content: [
      { id: "hInner", type: "text", configuration: { label: "Inside the group" } }
    ] } },
    { id: "hGrid", type: "dataGrid", configuration: { label: "Rows", initialRows: 2, minRows: 1, maxRows: 3 }, children: { content: [
      { id: "cell", type: "text", configuration: { label: "Cell" } }
    ] } }
  ])
};

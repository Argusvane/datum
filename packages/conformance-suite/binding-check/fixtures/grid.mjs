import { form } from "./_util.mjs";
export default {
  id: "grid", title: "Data grid: two rows of three, add, move, remove",
  definition: form([
    { id: "lines", type: "dataGrid", configuration: { label: "Items requested", description: "Up to three.", initialRows: 2, minRows: 1, maxRows: 3, canReorder: true }, children: { content: [
      { id: "item", type: "text", configuration: { label: "Item" } },
      { id: "quantity", type: "text", configuration: { label: "Quantity", inputmode: "numeric" } }
    ] } }
  ])
};

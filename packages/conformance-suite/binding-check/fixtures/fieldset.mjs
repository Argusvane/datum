import { form } from "./_util.mjs";
export default {
  id: "fieldset", title: "Fieldset with a hint around a field",
  definition: form([
    { id: "more", type: "fieldset", configuration: { label: "About your request", description: "Anything we should know." }, children: { content: [
      { id: "detail", type: "text", configuration: { label: "Detail" } }
    ] } }
  ])
};

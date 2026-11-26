import { form } from "./_util.mjs";
export default {
  id: "textarea", title: "Textarea: rows, count",
  definition: form([
    { id: "bio", type: "textarea", configuration: { label: "About your request", description: "A few sentences.", rows: 4, maxLength: 120, characterCount: true } }
  ])
};

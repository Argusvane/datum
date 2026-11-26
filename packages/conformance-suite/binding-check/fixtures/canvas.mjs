import { form } from "./_util.mjs";
// CNV: the builder canvas draws this form with the binding under test. One field of each kind the
// builder selects, a group around a field, and a group with nothing in it (the canvas's drop zone).
export default {
  id: "canvas", title: "Fields, a group around a field and an empty group (builder canvas mode)",
  definition: form([
    { id: "name", type: "text", configuration: { label: "Full name" } },
    { id: "bio", type: "textarea", configuration: { label: "About your request" } },
    { id: "province", type: "select", configuration: { label: "Province", options: [{ value: "ON", label: "Ontario" }, { value: "QC", label: "Quebec" }] } },
    { id: "contact", type: "radio", configuration: { label: "Preferred contact method", options: [{ value: "email", label: "Email" }, { value: "phone", label: "Phone" }] } },
    { id: "channels", type: "checkboxes", configuration: { label: "Contact channels", options: [{ value: "email", label: "Email" }, { value: "post", label: "Post" }] } },
    { id: "start", type: "date", configuration: { label: "Start date" } },
    { id: "more", type: "fieldset", configuration: { label: "About your request", description: "Anything we should know." }, children: { content: [
      { id: "detail", type: "text", configuration: { label: "Detail" } }
    ] } },
    { id: "spare", type: "fieldset", configuration: { label: "Spare group" }, children: { content: [] } }
  ])
};

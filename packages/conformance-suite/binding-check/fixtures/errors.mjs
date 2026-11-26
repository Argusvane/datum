import { form } from "./_util.mjs";
// One required field of every bound kind: validate() makes six errors, one per field.
export default {
  id: "errors", title: "One required field of every kind (errors, summary, references)",
  definition: form([
    { id: "name", type: "text", configuration: { label: "Full name", required: true } },
    { id: "bio", type: "textarea", configuration: { label: "About your request", required: true } },
    { id: "province", type: "select", configuration: { label: "Province", required: true, options: [{ value: "ON", label: "Ontario" }, { value: "QC", label: "Quebec" }] } },
    { id: "contact", type: "radio", configuration: { label: "Preferred contact method", required: true, options: [{ value: "email", label: "Email" }, { value: "phone", label: "Phone" }] } },
    { id: "channels", type: "checkboxes", configuration: { label: "Contact channels", required: true, options: [{ value: "email", label: "Email" }, { value: "post", label: "Post" }] } },
    { id: "start", type: "date", configuration: { label: "Start date", required: true } }
  ])
};

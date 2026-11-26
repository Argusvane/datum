import { form } from "./_util.mjs";
export default {
  id: "modes", title: "Every kind with an answer (read-only and disabled modes)",
  preset: { name: "Ada Lovelace", bio: "Fixed", province: "ON", contact: "email", channels: { email: true, post: false }, start: "2026-05-14" },
  definition: form([
    { id: "name", type: "text", configuration: { label: "Full name" } },
    { id: "bio", type: "textarea", configuration: { label: "About your request" } },
    { id: "province", type: "select", configuration: { label: "Province", options: [{ value: "ON", label: "Ontario" }, { value: "QC", label: "Quebec" }] } },
    { id: "contact", type: "radio", configuration: { label: "Preferred contact method", options: [{ value: "email", label: "Email" }, { value: "phone", label: "Phone" }] } },
    { id: "channels", type: "checkboxes", configuration: { label: "Contact channels", options: [{ value: "email", label: "Email" }, { value: "post", label: "Post" }] } },
    { id: "start", type: "date", configuration: { label: "Start date" } }
  ])
};

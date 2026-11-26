import { form } from "./_util.mjs";
export default {
  id: "checkboxes", title: "Checkboxes: required, option hint",
  definition: form([
    { id: "channels", type: "checkboxes", configuration: { label: "Contact channels", description: "Choose any.", required: true, options: [{ value: "email", label: "Email" }, { value: "phone", label: "Phone", description: "Weekdays." }, { value: "post", label: "Post" }] } }
  ])
};

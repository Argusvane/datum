import { form } from "./_util.mjs";
export default {
  id: "radio", title: "Radios: required, group hint, option hint",
  definition: form([
    { id: "contact", type: "radio", configuration: { label: "Preferred contact method", description: "We use this for follow-up only.", required: true, options: [{ value: "email", label: "Email" }, { value: "phone", label: "Phone", description: "Weekdays, 9 to 5." }, { value: "mail", label: "Post" }] } }
  ])
};

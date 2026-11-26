import { form } from "./_util.mjs";
export default {
  id: "text", title: "Text fields: required, optional, hint, prefix and suffix, count, placeholder",
  definition: form([
    { id: "fullName", type: "text", configuration: { label: "Full name", description: "As it appears on your identification.", required: true } },
    { id: "nickname", type: "text", configuration: { label: "Nickname" } },
    { id: "amount", type: "text", configuration: { label: "Amount requested", prefix: "$", suffix: ".00", inputmode: "numeric" } },
    { id: "notes", type: "text", configuration: { label: "Notes", maxLength: 40, characterCount: true } },
    { id: "city", type: "text", configuration: { label: "City", placeholder: "Type a city" } }
  ])
};

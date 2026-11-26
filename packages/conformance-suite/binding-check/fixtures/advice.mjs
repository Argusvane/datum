import { form } from "./_util.mjs";
// A warning or an info on one field of every bound kind, raised by a stage of the fixture's own
// (`stages`, host/entry.ts: the code `advice`, worded by the field's `messages.advice`), and an
// async check on the text that a case makes pending (`remote:name`) until it is answered.
const advice = (id) => ({ messages: { advice: `NOTICE ${id} words` } });
export default {
  id: "advice", title: "Notices (warnings and info) on every kind, and a pending check",
  definition: form([
    { id: "name", type: "text", configuration: { label: "Full name", description: "As on your passport.", ...advice("name") } },
    { id: "bio", type: "textarea", configuration: { label: "About your request", ...advice("bio") } },
    { id: "province", type: "select", configuration: { label: "Province", options: [{ value: "ON", label: "Ontario" }, { value: "QC", label: "Quebec" }], ...advice("province") } },
    { id: "contact", type: "radio", configuration: { label: "Preferred contact method", options: [{ value: "email", label: "Email" }, { value: "phone", label: "Phone" }], ...advice("contact") } },
    { id: "channels", type: "checkboxes", configuration: { label: "Contact channels", options: [{ value: "email", label: "Email" }, { value: "post", label: "Post" }], ...advice("channels") } },
    { id: "start", type: "date", configuration: { label: "Start date", ...advice("start") } },
    { id: "agree", type: "checkbox", configuration: { label: "I agree to the terms", ...advice("agree") } }
  ]),
  stages: ["advice:warning:name", "advice:info:bio", "advice:warning:province", "advice:info:contact", "advice:warning:channels", "advice:info:start", "advice:warning:agree"]
};

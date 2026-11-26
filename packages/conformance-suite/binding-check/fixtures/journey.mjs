import { form } from "./_util.mjs";
export default {
  id: "journey", title: "Journey: two pages, an exit route",
  definition: form([
    { id: "fullName", type: "text", configuration: { label: "Full name", required: true } },
    { id: "email", type: "text", configuration: { label: "Email address", required: true } },
    { id: "contact", type: "radio", configuration: { label: "Preferred contact method", required: true, options: [{ value: "email", label: "Email" }, { value: "phone", label: "Phone" }] } },
    { id: "sorry", type: "text", configuration: { label: "Notes" } }
  ], { journey: { journeys: [{ id: "apply", name: "Apply", progress: "count", validation: { continue: "page" }, pages: [
    { id: "about", title: "About you", components: ["fullName", "email"] },
    { id: "reach", title: "How to reach you", components: ["contact"], routes: [{ when: 'contact = "phone"', to: "out" }, { to: "$end" }] },
    { id: "out", title: "Not by phone", kind: "exit", components: ["sorry"] }
  ] }] } })
};

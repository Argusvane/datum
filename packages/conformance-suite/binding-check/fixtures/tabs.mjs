import { form } from "./_util.mjs";
export default {
  id: "tabs", title: "Tabs: an error in the tab that is not shown",
  definition: form([
    { id: "sections", type: "tabs", configuration: { label: "Sections", tabs: [{ id: "applicant", label: "Applicant" }, { id: "items", label: "Items" }] }, children: {
      applicant: [{ id: "name", type: "text", configuration: { label: "Full name" } }],
      items: [{ id: "email", type: "text", configuration: { label: "Email address", required: true } }]
    } }
  ])
};

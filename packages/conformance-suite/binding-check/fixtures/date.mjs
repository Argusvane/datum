import { form } from "./_util.mjs";
export default {
  id: "date", title: "Date: required, hint",
  definition: form([
    { id: "start", type: "date", configuration: { label: "Start date", description: "For example 14 5 2026.", required: true } }
  ])
};

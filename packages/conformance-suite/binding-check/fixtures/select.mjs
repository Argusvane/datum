import { form } from "./_util.mjs";
export default {
  id: "select", title: "Select",
  definition: form([
    { id: "province", type: "select", configuration: { label: "Province", description: "Where you live.", required: true, options: [{ value: "ON", label: "Ontario" }, { value: "QC", label: "Quebec" }, { value: "BC", label: "British Columbia" }] } }
  ])
};

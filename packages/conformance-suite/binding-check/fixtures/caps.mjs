import { form } from "./_util.mjs";
// One field per capability a binding answers for, so each answer can be held to what is drawn.
export default {
  id: "caps", title: "One field per capability (honest answers)",
  definition: form([
    { id: "c_hint", type: "text", configuration: { label: "Hint field", description: "HINTWORDS for the field." } },
    { id: "c_placeholder", type: "text", configuration: { label: "Placeholder field", placeholder: "PLACEHOLDERWORDS" } },
    { id: "c_prefix", type: "text", configuration: { label: "Prefix field", prefix: "PFX" } },
    { id: "c_suffix", type: "text", configuration: { label: "Suffix field", suffix: "SFX" } },
    { id: "c_tooltip", type: "text", configuration: { label: "Tooltip field", tooltip: "TOOLTIPWORDS" } },
    { id: "c_count", type: "text", configuration: { label: "Count field", maxLength: 73, characterCount: true } },
    { id: "c_autocomplete", type: "text", configuration: { label: "Autocomplete field", autocomplete: "email" } },
    { id: "c_inputmode", type: "text", configuration: { label: "Inputmode field", inputmode: "numeric" } },
    { id: "c_spellcheck", type: "text", configuration: { label: "Spellcheck field", spellcheck: false } },
    { id: "c_rows", type: "textarea", configuration: { label: "Rows field", rows: 7 } },
    { id: "c_radio", type: "radio", configuration: { label: "Radio field", description: "RADIOHINT", options: [{ value: "a", label: "A", description: "OPTIONHINTWORDS" }, { value: "b", label: "B" }] } },
    { id: "c_checks", type: "checkboxes", configuration: { label: "Checkbox field", description: "CHECKSHINT", options: [{ value: "a", label: "A", description: "CHECKOPTIONHINT" }, { value: "b", label: "B" }] } },
    { id: "c_select", type: "select", configuration: { label: "Select field", description: "SELECTHINT", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] } },
    { id: "c_date", type: "date", configuration: { label: "Date field", description: "DATEHINT" } },
    { id: "c_group", type: "fieldset", configuration: { label: "Group legend", description: "GROUPHINT" }, children: { content: [{ id: "c_inner", type: "text", configuration: { label: "Inner" } }] } }
  ])
};

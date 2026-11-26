import {
  BUTTON_ACTION_OPTIONS,
  BUTTON_GROUP_CHILD_TYPES,
  BUTTON_GROUP_COMPONENT_TYPE,
  BUTTON_GROUP_SLOT_ID,
  BUTTON_SIGNATURE_OPTIONS,
  BUTTON_COMPONENT_TYPE,
  BUTTON_SIZE_OPTIONS,
  BUTTON_VARIANT_OPTIONS,
  DATA_GRID_COMPONENT_TYPE,
  DATA_GRID_LAYOUTS,
  DATA_GRID_ROWS_CAP,
  DATA_GRID_SLOT_ID,
  FILE_COMPONENT_TYPE,
  FILE_STORAGE_OPTIONS,
  HTML_BLOCK_TAGS,
  HTML_COMPONENT_TYPE,
  IMAGE_COMPONENT_TYPE,
  STEPS_COMPONENT_TYPE,
  STEP_COMPONENT_TYPE,
  createDataSourceCapability,
  createInlineOptionsCapability,
  cssClassCapability,
  emptyGridChildren,
  standardFieldCapabilities,
  printOptionsCapability,
  PRINT_OPTION_FIELDS,
  HIDDEN_VALUE_FIELD,
  type BuilderComponentType,
  type ComponentDefinition
} from "@argusvane/datum-engine";

/**
 * The standard component catalogue: every component type the engine itself draws, which is
 * what the builder offers and the renderer draws out of the box. One definition per type,
 * registered on both surfaces so a form authored here renders identically in the running
 * form.
 *
 * Definitions are what the builder seeds a newly-added component from (`createDefault`,
 * id aside) and what its inspector is composed from (the declared capabilities): a
 * `checkbox` gets no placeholder editor because a checkbox has nowhere to put ghost text.
 * A host adds types of its own beside these (`ComponentDefinition.adapter`) without
 * touching this list, and a component library — a design system's components as a package
 * of their own — is a plugin the host registers (`plugins.register`),
 * never part of this list or of the bundles.
 */

/**
 * What a new field is called until its author names it: not the type shouted back ("TEXT
 * field"), which reads as a label someone wrote. The same text is the
 * controller's fallback for a type with no definition.
 */
const UNTITLED_LABEL = "Untitled field";

/**
 * The two choices a new select, radio group or checkboxes starts with, so
 * the control draws something to pick and the author edits rather than creates. Only an add
 * seeds them (`createDefault`); a form read from JSON keeps exactly the options it declares,
 * none included. The keys are distinct and stay clear of the labels, which are the author's to
 * rewrite.
 */
function seededOptions(): Array<{ value: string; label: string }> {
  return [
    { value: "option_1", label: "Option 1" },
    { value: "option_2", label: "Option 2" }
  ];
}

/**
 * A leaf field. No ghost text where there is no box to put it in (checkbox) and where the
 * control ignores the attribute (radio group, native date input). A pattern and character
 * limits are offered only for the types a person types free text into; a date picker and a
 * radio group already constrain their own values, so a regex there could never fire.
 */
function leafDefinition(type: string): ComponentDefinition {
  return {
    type,
    version: "1.0.0",
    createDefault: () => ({
      id: type,
      type,
      configuration: { label: UNTITLED_LABEL }
    }),
    capabilities: standardFieldCapabilities({
      placeholder: !["checkbox", "radio", "date"].includes(type),
      pattern: ["text", "textarea"].includes(type),
      length: ["text", "textarea"].includes(type),
      // Only a multi-line control has rows to set.
      rows: type === "textarea",
      // Browser hints: what a box may be filled in with (a date takes `bday`), and which
      // keyboard a phone raises for the ones a person types into.
      autocomplete: ["text", "textarea", "number", "date"].includes(type),
      inputMode: ["text", "textarea", "number"].includes(type),
      // A currency sign or a unit flanks a single-line box.
      affix: ["text", "number"].includes(type)
    })
  };
}

/**
 * The `date` component: the engine's native date input. A design system that prescribes
 * another anatomy (a Month / Day / Year group) draws it in its binding's date adapter, so
 * nothing is wired here.
 */
function dateDefinition(): ComponentDefinition {
  return leafDefinition("date");
}

/**
 * Author-written content: an instruction block, a consent notice, a heading between
 * sections. It holds no value, so almost none of the field capabilities apply. The markup is
 * sanitized by the engine on render, on both surfaces.
 */
function htmlDefinition(): ComponentDefinition {
  return {
    type: HTML_COMPONENT_TYPE,
    version: "1.0.0",
    createDefault: () => ({
      id: HTML_COMPONENT_TYPE,
      type: HTML_COMPONENT_TYPE,
      configuration: { tag: "div", content: "<p>Add your content here.</p>" }
    }),
    capabilities: [cssClassCapability, printOptionsCapability],
    propertyEditor: {
      mode: "extend",
      fields: [
        {
          id: "tag",
          type: "select",
          propertyPath: "tag",
          label: "Tag",
          choices: HTML_BLOCK_TAGS.map((tag) => ({ value: tag, label: tag }))
        },
        {
          id: "content",
          type: "localized-text",
          propertyPath: "content",
          label: "Content",
          description: "HTML. Scripts, styles and event handlers are stripped when rendered."
        }
      ]
    }
  };
}

/** A picture from a URL. The URL is checked by the engine on render, so `javascript:` never reaches an `<img>`. */
function imageDefinition(): ComponentDefinition {
  return {
    type: IMAGE_COMPONENT_TYPE,
    version: "1.0.0",
    createDefault: () => ({
      id: IMAGE_COMPONENT_TYPE,
      type: IMAGE_COMPONENT_TYPE,
      configuration: { src: "", alt: "" }
    }),
    capabilities: [cssClassCapability, printOptionsCapability],
    propertyEditor: {
      mode: "extend",
      fields: [
        {
          id: "src",
          type: "text",
          propertyPath: "src",
          label: "Image URL",
          description: "http(s) or a relative path; data:image/… works for a small inline picture."
        },
        {
          id: "alt",
          type: "localized-text",
          propertyPath: "alt",
          label: "Alternative text",
          description: "What the picture says, for people who cannot see it. Empty means decorative."
        },
        { id: "width", type: "number", propertyPath: "width", label: "Width (px)" },
        { id: "height", type: "number", propertyPath: "height", label: "Height (px)" }
      ]
    }
  };
}

/**
 * A file upload. What happens to a picked file is the *storage* the component names
 * (`configuration.storage`); the engine's base64 storage (bytes embedded in the value) is the
 * default, and a host that keeps files elsewhere adds a storage of its own to the renderer
 * (`createFileStorageResolver`). A design system with a file uploader of its own
 * (GC Design System's) draws the control in its binding's file adapter; otherwise the
 * engine's native picker.
 */
function fileDefinition(): ComponentDefinition {
  return {
    type: FILE_COMPONENT_TYPE,
    version: "1.0.0",
    createDefault: () => ({
      id: FILE_COMPONENT_TYPE,
      type: FILE_COMPONENT_TYPE,
      configuration: { label: "File upload", storage: "base64" }
    }),
    capabilities: standardFieldCapabilities({ placeholder: false, attachFiles: true }),
    propertyEditor: {
      mode: "extend",
      fields: [
        {
          id: "storage",
          type: "select",
          propertyPath: "storage",
          label: "Storage",
          description: "Where a picked file's bytes go.",
          choices: FILE_STORAGE_OPTIONS.map((option) => ({ value: option.value, label: option.label }))
        },
        {
          id: "multiple",
          type: "boolean",
          propertyPath: "multiple",
          label: "Allow several files",
          description: "The value becomes a list; picking again adds to it."
        },
        {
          id: "accept",
          type: "text",
          propertyPath: "accept",
          label: "Accepted types",
          description:
            "Comma-separated, as the accept attribute is written: .pdf, image/*, application/zip. Empty accepts anything."
        },
        {
          id: "maxFileSizeMb",
          type: "number",
          propertyPath: "maxFileSizeMb",
          label: "Max file size (MB)",
          description: "Per file. Empty means no limit."
        }
      ]
    }
  };
}

/**
 * Where a select, radio or checkboxes gets its choices: a data source the host wired or
 * registered (the Data source picker), or options typed inline (the Options editor). A named
 * source takes precedence.
 */
function choiceCapabilities(): ComponentDefinition["capabilities"] {
  return [createDataSourceCapability(), createInlineOptionsCapability()];
}

function selectDefinition(): ComponentDefinition {
  const base = leafDefinition("select");
  return {
    ...base,
    createDefault: () => ({ id: "select", type: "select", configuration: { label: UNTITLED_LABEL, options: seededOptions() } }),
    capabilities: [...base.capabilities, ...choiceCapabilities()]
  };
}

/** A radio group: a real `fieldset`/`legend` over its options. A radio with no options renders as a bare legend. */
function radioDefinition(): ComponentDefinition {
  return {
    type: "radio",
    version: "1.0.0",
    createDefault: () => ({
      id: "radio",
      type: "radio",
      configuration: { label: UNTITLED_LABEL, options: seededOptions() }
    }),
    capabilities: [...standardFieldCapabilities({ placeholder: false }), ...choiceCapabilities()]
  };
}

/**
 * A checkboxes group: 0..n options picked, stored as one object of booleans keyed by option
 * value (`{ email: true, phone: false }`). A rule over one option reads into the object.
 */
function checkboxesDefinition(): ComponentDefinition {
  return {
    type: "checkboxes",
    version: "1.0.0",
    createDefault: () => ({
      id: "checkboxes",
      type: "checkboxes",
      configuration: { label: UNTITLED_LABEL, options: seededOptions() }
    }),
    capabilities: [...standardFieldCapabilities({ placeholder: false }), ...choiceCapabilities()]
  };
}

/**
 * The action button. `createDefault` seeds a ready-to-use submit button; a button holds no
 * value, so `required` is meaningless for it. Choices come from the engine's own vocabulary.
 */
function buttonDefinition(): ComponentDefinition {
  return {
    type: BUTTON_COMPONENT_TYPE,
    version: "1.0.0",
    createDefault: () => ({
      id: BUTTON_COMPONENT_TYPE,
      type: BUTTON_COMPONENT_TYPE,
      configuration: { label: "Submit", action: "submit" }
    }),
    capabilities: standardFieldCapabilities({
      placeholder: false,
      required: false,
      description: false,
      // No value, so no constraint can fail on it: nothing for a message to word.
      messages: false
    }),
    propertyEditor: {
      mode: "extend",
      fields: [
        {
          id: "variant",
          type: "select",
          propertyPath: "variant",
          label: "Style",
          description: "Emphasis. The theme decides what each one looks like.",
          choices: BUTTON_VARIANT_OPTIONS.map((option) => ({ value: option.value, label: option.label }))
        },
        {
          id: "size",
          type: "select",
          propertyPath: "size",
          label: "Size",
          choices: BUTTON_SIZE_OPTIONS.map((option) => ({ value: option.value, label: option.label }))
        },
        {
          id: "action",
          type: "select",
          propertyPath: "action",
          label: "Action",
          choices: BUTTON_ACTION_OPTIONS.map((option) => ({ value: option.value, label: option.label }))
        },
        {
          id: "signature",
          type: "select",
          propertyPath: "signature",
          label: "Signature",
          description: "For a submit: sign the submission with the person's passkey or security key through the host's WebAuthn signing provider.",
          choices: BUTTON_SIGNATURE_OPTIONS.map((option) => ({ value: option.value, label: option.label }))
        }
      ]
    }
  };
}

/**
 * The CSS-classes editor, restated by every container below: `replace` mode drops the
 * capability-supplied fields, so each of these editors has to ask for it by name.
 */
const CSS_CLASS_FIELD = {
  id: "cssClass",
  type: "text",
  propertyPath: "cssClass",
  label: "CSS classes"
} as const;

/**
 * A container holds components rather than a value, so `required` is meaningless for it.
 * These replace the defaults with the group heading and a switch to hide it visually while
 * keeping it as the group's accessible name.
 */
const CONTAINER_LEAD_FIELDS = [
  { id: "label", type: "localized-text", propertyPath: "label", label: "Label" },
  { id: "hideLabel", type: "boolean", propertyPath: "hideLabel", label: "Hide label" }
] as const;

const CONTAINER_TAIL_FIELDS = [
  { id: "disabled", type: "boolean", propertyPath: "disabled", label: "Disabled" },
  CSS_CLASS_FIELD,
  // How the group prints from the live form: a section a rule shows, printed with its note.
  ...PRINT_OPTION_FIELDS
] as const;

const CONTAINER_PROPERTY_EDITOR: NonNullable<ComponentDefinition["propertyEditor"]> = {
  mode: "replace",
  fields: [...CONTAINER_LEAD_FIELDS, ...CONTAINER_TAIL_FIELDS]
};

/**
 * A fieldset's inspector: the group's settings, and the mark its legend carries
 * (`configuration.legendMark`). Presentational only: it draws the
 * theme's "required" or "optional" mark after the legend and makes no field inside required.
 */
const FIELDSET_PROPERTY_EDITOR: NonNullable<ComponentDefinition["propertyEditor"]> = {
  mode: "replace",
  fields: [
    ...CONTAINER_LEAD_FIELDS,
    {
      id: "legendMark",
      type: "select",
      propertyPath: "legendMark",
      label: "Legend mark",
      description: "Marks the legend as required or optional, in the theme's words. It does not make any field inside required.",
      choices: [
        { value: "", label: "None" },
        { value: "required", label: "Required" },
        { value: "optional", label: "Optional" }
      ]
    },
    ...CONTAINER_TAIL_FIELDS
  ]
};

function containerDefinition(type: string): ComponentDefinition {
  const definition: ComponentDefinition = {
    type,
    version: "1.0.0",
    createDefault: () => ({ id: type, type, configuration: {}, children: { content: [] } }),
    // The form root prints whole; a group's print choices are in its editor below.
    capabilities: [],
    children: { slots: [{ id: "content", multiple: true }] }
  };
  // The form root is a container too, but it is not a group: its inspector shows form-level
  // settings, and a `replace` editor here would override them.
  if (type === "form") {
    return definition;
  }
  if (type === "fieldset") {
    return { ...definition, propertyEditor: FIELDSET_PROPERTY_EDITOR };
  }
  return { ...definition, propertyEditor: CONTAINER_PROPERTY_EDITOR };
}

/**
 * A multi-column layout container. Each column is a child slot (`column_1` … `column_N`), so
 * a field is dropped into a particular column. The slot list follows `configuration.columns`,
 * which the engine derives on both surfaces.
 */
function gridDefinition(): ComponentDefinition {
  const configuration = { columns: 2 };
  return {
    type: "grid",
    version: "1.0.0",
    createDefault: () => ({
      id: "grid",
      type: "grid",
      configuration: { ...configuration },
      children: emptyGridChildren(configuration)
    }),
    capabilities: [printOptionsCapability],
    children: { slots: [] },
    propertyEditor: {
      mode: "replace",
      fields: [
        { id: "label", type: "localized-text", propertyPath: "label", label: "Label" },
        { id: "hideLabel", type: "boolean", propertyPath: "hideLabel", label: "Hide label" },
        {
          id: "columns",
          type: "text",
          propertyPath: "columns",
          label: "Columns",
          description:
            "A count for equal columns (3), or one span per column on a 12-unit row for sized ones (8/4, 3/6/3). Each column is its own drop target and its fields stack top to bottom; removing a column moves its fields into the last one."
        },
        CSS_CLASS_FIELD
      ]
    }
  };
}

/**
 * A button group: buttons side by side along a row that wraps. Its slot takes
 * buttons alone — the link look is a button variant — so the builder refuses anything else
 * there, and an empty group asks for buttons. No label and no settings of its own: an id, its
 * CSS classes and its rules, like every component.
 */
function buttonGroupDefinition(): ComponentDefinition {
  return {
    type: BUTTON_GROUP_COMPONENT_TYPE,
    version: "1.0.0",
    createDefault: () => ({
      id: BUTTON_GROUP_COMPONENT_TYPE,
      type: BUTTON_GROUP_COMPONENT_TYPE,
      configuration: {},
      children: { [BUTTON_GROUP_SLOT_ID]: [] }
    }),
    capabilities: [printOptionsCapability],
    children: {
      slots: [{ id: BUTTON_GROUP_SLOT_ID, multiple: true, allowedTypes: [...BUTTON_GROUP_CHILD_TYPES], emptyHint: "Drop buttons here." }]
    },
    propertyEditor: { mode: "replace", fields: [CSS_CLASS_FIELD] }
  };
}

/**
 * A data grid: a container whose one slot holds the components of one row, bound as
 * a repeating collection. The slot names no allowed types: any component may sit in a row,
 * directly or inside a container (another grid, a button, a file, steps), and the form's checks
 * hold for each row's copy; only the form itself is refused, as in every slot. A new grid keeps
 * its rows at its own id (`collectionPath`), which the controller moves to the generated id on
 * add and the "Saved as" box edits afterwards. The Rows
 * section carries what is the grid's own; `collection.operations` is never authored for a grid
 * (the configuration is, `rowOperationsOf`), and `itemFields` is never written (the runtime
 * derives it from the children).
 */
function dataGridDefinition(): ComponentDefinition {
  return {
    type: DATA_GRID_COMPONENT_TYPE,
    version: "1.0.0",
    createDefault: () => ({
      id: DATA_GRID_COMPONENT_TYPE,
      type: DATA_GRID_COMPONENT_TYPE,
      configuration: { label: "Data grid" },
      collection: { collectionPath: DATA_GRID_COMPONENT_TYPE },
      children: { [DATA_GRID_SLOT_ID]: [] }
    }),
    capabilities: [printOptionsCapability],
    children: {
      slots: [{ id: DATA_GRID_SLOT_ID, multiple: true, emptyHint: "Drop the fields of one row here" }]
    },
    propertyEditor: {
      mode: "replace",
      fields: [
        { id: "label", type: "localized-text", propertyPath: "label", label: "Label" },
        { id: "hideLabel", type: "boolean", propertyPath: "hideLabel", label: "Hide label" },
        { id: "description", type: "localized-text", propertyPath: "description", label: "Description" },
        {
          id: "layout",
          type: "select",
          propertyPath: "layout",
          label: "Layout",
          description: "Automatic draws a table where the form is wide enough and a stack of rows where it is not.",
          defaultValue: "auto",
          choices: DATA_GRID_LAYOUTS.map((layout) => ({ value: layout, label: layout === "auto" ? "Automatic" : layout === "table" ? "Table" : "Stacked" }))
        },
        {
          id: "showHeader",
          type: "boolean",
          propertyPath: "showHeader",
          label: "Show column headings",
          description: "Off, the table has no heading row; each cell keeps its label for screen readers (shown when the rows stack).",
          defaultValue: true
        },
        {
          id: "showRowNumbers",
          type: "boolean",
          propertyPath: "showRowNumbers",
          label: "Show row numbers",
          description: "Off, rows carry no \"Row 1\" heading on screen; screen readers still hear it.",
          defaultValue: true
        },
        {
          id: "rowLabel",
          type: "localized-text",
          propertyPath: "rowLabel",
          label: "Row heading",
          description: "Blank: Row {{n}}. Write {{n}} where the row's number goes, as in Applicant {{n}}."
        },
        { id: "canAdd", type: "boolean", propertyPath: "canAdd", label: "Add rows", defaultValue: true },
        { id: "addLabel", type: "localized-text", propertyPath: "addLabel", label: "Add button label", description: "Blank: Add row." },
        { id: "canRemove", type: "boolean", propertyPath: "canRemove", label: "Remove rows", defaultValue: true },
        { id: "removeLabel", type: "localized-text", propertyPath: "removeLabel", label: "Remove button label", description: "Blank: Remove." },
        { id: "canReorder", type: "boolean", propertyPath: "canReorder", label: "Reorder rows", defaultValue: false },
        {
          id: "minRows",
          type: "number",
          propertyPath: "minRows",
          label: "Minimum rows",
          description: "Fewest rows a submission may carry. Blank: none required. A formula on the Rules tab (Minimum rows formula) can work it out from other answers.",
          min: 0,
          max: DATA_GRID_ROWS_CAP,
          step: 1
        },
        {
          id: "maxRows",
          type: "number",
          propertyPath: "maxRows",
          label: "Maximum rows",
          description: "Most rows a submission may carry. Blank: no limit. A formula on the Rules tab (Maximum rows formula) can work it out from other answers.",
          min: 0,
          max: DATA_GRID_ROWS_CAP,
          step: 1
        },
        {
          id: "initialRows",
          type: "number",
          propertyPath: "initialRows",
          label: "Rows to start with",
          description: "Empty rows the form opens with when nothing is filled in yet. Blank: one.",
          min: 0,
          max: DATA_GRID_ROWS_CAP,
          step: 1
        },
        { id: "emptyText", type: "localized-text", propertyPath: "emptyText", label: "Empty text", description: "Shown when there are no rows. Blank: No rows yet." },
        // Its rows are answers: what the submitted data holds for them while the grid is hidden.
        HIDDEN_VALUE_FIELD,
        { id: "disabled", type: "boolean", propertyPath: "disabled", label: "Disabled" },
        CSS_CLASS_FIELD,
        ...PRINT_OPTION_FIELDS
      ]
    }
  };
}

/** A card: a bordered box with its own header. Purely presentational; the data stays flat. */
function panelDefinition(): ComponentDefinition {
  return {
    type: "panel",
    version: "1.0.0",
    createDefault: () => ({
      id: "panel",
      type: "panel",
      configuration: { label: "Panel" },
      children: { content: [] }
    }),
    capabilities: [printOptionsCapability],
    children: { slots: [{ id: "content", multiple: true }] },
    propertyEditor: CONTAINER_PROPERTY_EDITOR
  };
}

/**
 * Tabbed sections. Each entry in `configuration.tabs` names a tab *and* the child slot its
 * content lives in, so renaming a caption never orphans what is inside it.
 */
function tabsDefinition(): ComponentDefinition {
  return {
    type: "tabs",
    version: "1.0.0",
    createDefault: () => ({
      id: "tabs",
      type: "tabs",
      configuration: {
        tabs: [
          { id: "tab_1", label: "First" },
          { id: "tab_2", label: "Second" }
        ]
      },
      children: { tab_1: [], tab_2: [] }
    }),
    capabilities: [printOptionsCapability],
    children: {
      slots: [
        { id: "tab_1", multiple: true },
        { id: "tab_2", multiple: true }
      ]
    },
    propertyEditor: {
      mode: "replace",
      fields: [
        { id: "tab1", type: "localized-text", propertyPath: "tabs.0.label", label: "Tab 1" },
        { id: "tab2", type: "localized-text", propertyPath: "tabs.1.label", label: "Tab 2" },
        CSS_CLASS_FIELD
      ]
    }
  };
}

/**
 * A multi-step form: a `steps` container holding `step` containers, shown one at
 * a time behind a step indicator with Back and Continue. Its content slot takes steps alone,
 * so a field dropped on it lands in a step rather than beside them; each step is an ordinary
 * labelled container, its label the step's name in the indicator.
 */
function stepsDefinition(): ComponentDefinition {
  return {
    type: STEPS_COMPONENT_TYPE,
    version: "1.0.0",
    createDefault: () => ({
      id: STEPS_COMPONENT_TYPE,
      type: STEPS_COMPONENT_TYPE,
      configuration: {},
      children: {
        content: [
          { id: "step_1", type: STEP_COMPONENT_TYPE, configuration: { label: "Step 1" }, children: { content: [] } },
          { id: "step_2", type: STEP_COMPONENT_TYPE, configuration: { label: "Step 2" }, children: { content: [] } }
        ]
      }
    }),
    capabilities: [printOptionsCapability],
    children: { slots: [{ id: "content", multiple: true, allowedTypes: [STEP_COMPONENT_TYPE] }] },
    propertyEditor: { mode: "replace", fields: [CSS_CLASS_FIELD] }
  };
}

function stepDefinition(): ComponentDefinition {
  return {
    type: STEP_COMPONENT_TYPE,
    version: "1.0.0",
    createDefault: () => ({ id: STEP_COMPONENT_TYPE, type: STEP_COMPONENT_TYPE, configuration: { label: "Step" }, children: { content: [] } }),
    capabilities: [printOptionsCapability],
    children: { slots: [{ id: "content", multiple: true }] },
    propertyEditor: CONTAINER_PROPERTY_EDITOR
  };
}

/**
 * A data-scoping container: its id — or its data key — becomes a level in the
 * submitted data, so a field `email` inside a container `applicant` is stored under the key
 * `"applicant.email"` (the submission's values are a flat map keyed by path, describing
 * `{ applicant: { email } }`). `scopeData` turns the nesting off, leaving a plain grouping box.
 */
function dataContainerDefinition(): ComponentDefinition {
  return {
    type: "container",
    version: "1.0.0",
    createDefault: () => ({
      id: "container",
      type: "container",
      configuration: { label: "Group" },
      children: { content: [] }
    }),
    capabilities: [printOptionsCapability],
    children: { slots: [{ id: "content", multiple: true }] },
    propertyEditor: {
      mode: "replace",
      fields: [
        { id: "label", type: "localized-text", propertyPath: "label", label: "Label" },
        { id: "hideLabel", type: "boolean", propertyPath: "hideLabel", label: "Hide label" },
        {
          id: "scopeData",
          type: "boolean",
          propertyPath: "scopeData",
          label: "Nest data under this id",
          description: "Off leaves the values flat, as any other grouping container does."
        },
        {
          id: "dataKey",
          type: "text",
          propertyPath: "dataKey",
          label: "Data key",
          description:
            "The name the nested object is stored under in the submitted data. Blank uses the ID. Letters, digits, _ and - only."
        },
        CSS_CLASS_FIELD
      ]
    }
  };
}

/**
 * Every standard component definition, in registration order. A fresh array (and fresh leaf
 * definitions) per call, so registering the result on several registries or extending it
 * never mutates a shared list.
 */
export function standardComponentDefinitions(): ComponentDefinition[] {
  return [
    containerDefinition("form"),
    containerDefinition("fieldset"),
    gridDefinition(),
    buttonGroupDefinition(),
    dataGridDefinition(),
    panelDefinition(),
    tabsDefinition(),
    stepsDefinition(),
    stepDefinition(),
    dataContainerDefinition(),
    leafDefinition("text"),
    leafDefinition("number"),
    leafDefinition("checkbox"),
    selectDefinition(),
    leafDefinition("textarea"),
    dateDefinition(),
    fileDefinition(),
    radioDefinition(),
    checkboxesDefinition(),
    htmlDefinition(),
    imageDefinition(),
    buttonDefinition()
  ];
}

/**
 * The builder palette for the standard catalogue. The palette groups these under headings
 * inferred from the type name (Fields / Choices / Layout / Content / Actions); a plugin's
 * types bring their own entries (`ComponentDefinition.palette`, `paletteEntriesOf`). The form
 * root has no entry: it is the tree, not something to add to it.
 */
export function standardComponentTypes(): BuilderComponentType[] {
  return [
    { type: "text", label: "Text" },
    { type: "number", label: "Number" },
    { type: "checkbox", label: "Checkbox" },
    { type: "select", label: "Select" },
    { type: "textarea", label: "Text area" },
    { type: "date", label: "Date" },
    { type: FILE_COMPONENT_TYPE, label: "File upload" },
    { type: "radio", label: "Radio" },
    { type: "checkboxes", label: "Checkboxes" },
    { type: HTML_COMPONENT_TYPE, label: "HTML" },
    { type: IMAGE_COMPONENT_TYPE, label: "Image" },
    { type: BUTTON_COMPONENT_TYPE, label: "Button" },
    { type: "fieldset", label: "Fieldset" },
    { type: "grid", label: "Grid" },
    { type: BUTTON_GROUP_COMPONENT_TYPE, label: "Button group" },
    { type: DATA_GRID_COMPONENT_TYPE, label: "Data grid" },
    { type: "panel", label: "Panel" },
    { type: "tabs", label: "Tabs" },
    { type: STEPS_COMPONENT_TYPE, label: "Steps" },
    { type: STEP_COMPONENT_TYPE, label: "Step" },
    { type: "container", label: "Container" }
  ];
}

/** `over` laid on `base`: a definition whose type is in `over` is replaced (the last one given wins), any other appended. */
function layered(base: readonly ComponentDefinition[], over: readonly ComponentDefinition[]): ComponentDefinition[] {
  const byType = new Map<string, ComponentDefinition>();
  for (const definition of over) {
    byType.set(definition.type, definition);
  }
  return [...base.filter((definition) => !byType.has(definition.type)), ...byType.values()];
}

/**
 * The standard definitions with the registered plugins' and a host's own laid over them, in
 * that order: a definition whose `type` matches one beneath it replaces it (so `date` can be
 * redrawn without a registry complaining about a duplicate), and any other is appended.
 * `registered` is what the page's plugins contribute (`pluginComponents`), `extra` the
 * element's own `componentDefinitions`, which win over both.
 */
export function mergeComponentDefinitions(
  extra: readonly ComponentDefinition[] = [],
  registered: readonly ComponentDefinition[] = []
): ComponentDefinition[] {
  return layered(layered(standardComponentDefinitions(), registered), extra);
}

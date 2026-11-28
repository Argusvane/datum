# React, Vue and Angular

The form and the builder are custom elements, so every framework can place them. The rules are the same in each:

- **Text goes in attributes**: `locale`, `draft`, `features`.
- **Objects and functions go in properties**: `definition`, `dataSources`, `messages`. Each framework has its own way to say "set the property".
- **What happened comes back as events**: `datum-submit`, `datum-change`.

The examples on this page are code to copy into an application. They are not run here: each needs its framework's own build.

## Loading the bundle

Copy the bundle folder into the application's static files and load the module from the page:

```html
<link rel="stylesheet" href="/datum/datum-form.css">
<script type="module" src="/datum/datum-form.js"></script>
<script type="module" src="/src/main.ts"></script>
```

Loading it from the page, not through the application's bundler, keeps the folder together: the element fetches its optional parts from beside the file it was loaded from. See [Files you host](/files).

The order does not matter. A property a component sets before the module has defined the element is kept and applied once it has. The engine's `<datum-form-renderer>` and `<datum-form-host>` keep such a property the same way.

## A form component

The same component three ways. It takes a definition, supplies a data source, delivers the submission and reports the confirmation number to its parent.

::: code-group

```tsx [React]
import { useEffect, useRef } from "react";

const sources = {
  countries: [{ value: "CA", label: "Canada" }, { value: "US", label: "United States" }]
};

export function IntakeForm({ definition, onSubmitted }) {
  const ref = useRef(null);

  // Objects are properties of the element, set through the ref.
  useEffect(() => {
    ref.current.definition = definition;
    ref.current.dataSources = sources;
  }, [definition]);

  useEffect(() => {
    const form = ref.current;
    const onSubmit = ({ detail }) => {
      if (!detail.accepted) return; // the form shows its own errors
      detail.waitUntil(deliver(form, detail).then(onSubmitted));
    };
    form.addEventListener("datum-submit", onSubmit);
    return () => form.removeEventListener("datum-submit", onSubmit);
  }, [onSubmitted]);

  return <datum-form ref={ref} locale="auto" language-switcher="" />;
}

async function deliver(form, detail) {
  const response = await fetch("/api/submissions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ document: detail.submission, submissionKey: detail.submissionKey })
  });
  if (!response.ok) {
    const { errors } = await response.json();
    form.setErrors(errors.map((e) => ({ componentId: e.field, code: e.code, message: e.message })));
    throw new Error("rejected");
  }
  const { reference } = await response.json();
  form.setNotice({ kind: "success", title: "Received", details: [{ label: "Confirmation", value: reference }] });
  return reference;
}
```

```vue [Vue]
<script setup>
import { ref } from "vue";

defineProps({ definition: { type: Object, required: true } });
const emit = defineEmits(["submitted"]);
const form = ref(null);

const sources = {
  countries: [{ value: "CA", label: "Canada" }, { value: "US", label: "United States" }]
};

function onSubmit({ detail }) {
  if (!detail.accepted) return; // the form shows its own errors
  detail.waitUntil(deliver(detail));
}

async function deliver(detail) {
  const response = await fetch("/api/submissions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ document: detail.submission, submissionKey: detail.submissionKey })
  });
  if (!response.ok) {
    const { errors } = await response.json();
    form.value.setErrors(errors.map((e) => ({ componentId: e.field, code: e.code, message: e.message })));
    throw new Error("rejected");
  }
  const { reference } = await response.json();
  form.value.setNotice({ kind: "success", title: "Received", details: [{ label: "Confirmation", value: reference }] });
  emit("submitted", reference);
}
</script>

<template>
  <!-- .prop sets the property; a plain attribute carries text. -->
  <datum-form
    ref="form"
    :definition.prop="definition"
    :dataSources.prop="sources"
    locale="auto"
    language-switcher
    @datum-submit="onSubmit"
  />
</template>
```

```ts [Angular]
import { Component, CUSTOM_ELEMENTS_SCHEMA, ElementRef, input, output, viewChild } from "@angular/core";

@Component({
  selector: "app-intake-form",
  // Lets the template use an element Angular does not know.
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  // [name] sets the property; a plain attribute carries text.
  template: `
    <datum-form
      #form
      [definition]="definition()"
      [dataSources]="sources"
      locale="auto"
      language-switcher
      (datum-submit)="onSubmit($event)"
    ></datum-form>
  `
})
export class IntakeFormComponent {
  definition = input.required<object>();
  submitted = output<string>();
  form = viewChild.required<ElementRef>("form");

  sources = {
    countries: [{ value: "CA", label: "Canada" }, { value: "US", label: "United States" }]
  };

  onSubmit(event: Event) {
    const detail = (event as CustomEvent).detail;
    if (!detail.accepted) return; // the form shows its own errors
    detail.waitUntil(this.deliver(detail));
  }

  private async deliver(detail: any) {
    const form = this.form().nativeElement;
    const response = await fetch("/api/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ document: detail.submission, submissionKey: detail.submissionKey })
    });
    if (!response.ok) {
      const { errors } = await response.json();
      form.setErrors(errors.map((e: any) => ({ componentId: e.field, code: e.code, message: e.message })));
      throw new Error("rejected");
    }
    const { reference } = await response.json();
    form.setNotice({ kind: "success", title: "Received", details: [{ label: "Confirmation", value: reference }] });
    this.submitted.emit(reference);
  }
}
```

:::

`detail.waitUntil(promise)` keeps the form locked, and saying it is submitting, until the delivery settles.

## What each framework needs

**React.**

- Set objects through a ref, as above, and add listeners with `addEventListener`. That works in every version of React.
- A boolean attribute is written with an empty string: `language-switcher=""`.

**Vue.** Tell the template compiler that `datum-` tags are custom elements, or Vue warns that it cannot resolve them:

```js
// vite.config.js
import vue from "@vitejs/plugin-vue";

export default {
  plugins: [vue({
    template: { compilerOptions: { isCustomElement: (tag) => tag.startsWith("datum-") } }
  })]
};
```

**Angular.**

- Add `CUSTOM_ELEMENTS_SCHEMA` to each component whose template places the element.
- Serve the bundle folder by listing it under `assets` in `angular.json`, and put the script tag in `src/index.html`.

## The builder

The builder follows the same rules. Give it a height, set `definition` as a property and store what `datum-builder-change` reports:

::: code-group

```tsx [React]
import { useEffect, useRef } from "react";

export function FormEditor({ definition, onChange }) {
  const ref = useRef(null);

  useEffect(() => {
    ref.current.definition = definition;
  }, []); // once: the builder owns the form from here on

  useEffect(() => {
    const builder = ref.current;
    const onEdit = ({ detail }) => onChange(detail.definition);
    builder.addEventListener("datum-builder-change", onEdit);
    return () => builder.removeEventListener("datum-builder-change", onEdit);
  }, [onChange]);

  return <datum-form-builder ref={ref} layout="contained" style={{ height: 640 }} />;
}
```

```vue [Vue]
<script setup>
import { onMounted, ref } from "vue";

const props = defineProps({ definition: { type: Object, required: true } });
const emit = defineEmits(["change"]);
const builder = ref(null);

// Once: the builder owns the form from here on.
onMounted(() => { builder.value.definition = props.definition; });
</script>

<template>
  <datum-form-builder
    ref="builder"
    layout="contained"
    style="height: 640px"
    @datum-builder-change="emit('change', $event.detail.definition)"
  />
</template>
```

```ts [Angular]
import { AfterViewInit, Component, CUSTOM_ELEMENTS_SCHEMA, ElementRef, input, output, viewChild } from "@angular/core";

@Component({
  selector: "app-form-editor",
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <datum-form-builder
      #builder
      layout="contained"
      style="height: 640px"
      (datum-builder-change)="changed.emit($any($event).detail.definition)"
    ></datum-form-builder>
  `
})
export class FormEditorComponent implements AfterViewInit {
  definition = input.required<object>();
  changed = output<object>();
  builder = viewChild.required<ElementRef>("builder");

  // Once: the builder owns the form from here on.
  ngAfterViewInit() {
    this.builder().nativeElement.definition = this.definition();
  }
}
```

:::

Hand the builder its definition once. It reports every edit, and setting `definition` again from that report on each change would replace the form the author is working on.

The stylesheet and module are `datum-builder.css` and `datum-builder.js`. That one module defines the form element as well, so a page with both loads it alone.

## TypeScript

The bundle folder has a `types/` directory of declaration files:

- `types/form.d.ts` describes everything `datum-form.js` exports.
- `types/builder.d.ts` describes everything `datum-builder.js` exports, which includes the form's.
- The element classes are in `form-element.d.ts` and `builder-element.d.ts`, with the detail type of each event beside them.

Nothing installs them: copy the folder with the bundle, or leave it where it is, and import from it by relative path. A TypeScript project needs nothing else in `tsconfig.json` than the usual `"skipLibCheck": true`.

```ts
import type {
  DatumFormElement,
  DatumFormSubmitDetail,
  DatumFormChangeDetail
} from "../public/datum/types/form";
import type { DatumFormBuilderElement } from "../public/datum/types/builder";
```

Type a ref with the element class:

```tsx
const ref = useRef<DatumFormElement>(null);

useEffect(() => {
  ref.current!.dataSources = { countries: [{ value: "CA", label: "Canada" }] };
}, []);
```

Type an event's `detail` with `CustomEvent`, since an element's events reach a listener as plain `Event`:

```ts
form.addEventListener("datum-submit", (event) => {
  const { detail } = event as CustomEvent<DatumFormSubmitDetail>;
  if (detail.accepted) detail.waitUntil(deliver(detail.submission));
});
```

Once the file is part of the program, `document.querySelector("datum-form")` is already a `DatumFormElement | null`, and `"datum-form-builder"` a `DatumFormBuilderElement | null`.

Detail types:

- **Form.** `DatumFormSubmitDetail`, `DatumFormChangeDetail`, `DatumFormValidatedDetail`, `DatumFormReadyDetail`, `DatumFormPageChangeDetail`, `DatumFormWasmValidatedDetail` and `DatumFormWasmReadyDetail`.
- **Builder.** `DatumFormBuilderChangeDetail`, `DatumFormBuilderSaveDetail`, `DatumFormBuilderWorkspaceChangeDetail` and their siblings.

The declarations take some of their types, such as `FormDefinition`, `FormError` and `HostError`, from a package named `@argusvane/datum-engine`. That package is not in the folder.

- With `skipLibCheck` the compiler stays quiet, and a type that comes from it reads as `any`: the element, its methods and the event details above are typed, but a `FormDefinition` is not checked.
- Without `skipLibCheck` each reference is reported as a missing module.

React 19 looks up JSX elements on its own namespace. Declare the tags once so that a ref and the element's properties type-check in JSX:

```ts
// datum-elements.d.ts
import type { DatumFormElement } from "../public/datum/types/form";
import type { DatumFormBuilderElement } from "../public/datum/types/builder";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "datum-form": React.DetailedHTMLProps<React.HTMLAttributes<DatumFormElement>, DatumFormElement>;
      "datum-form-builder": React.DetailedHTMLProps<React.HTMLAttributes<DatumFormBuilderElement>, DatumFormBuilderElement>;
    }
  }
}
```

## Next

- What the form takes and reports: [The form on your page](/form-on-your-page).
- Sizing and saving the builder: [Embedding the builder](/embedding-the-builder).
- Every attribute, property, event and method: [The form element](/form-element), [The builder element](/builder-element).

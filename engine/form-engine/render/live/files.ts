/**
 * File fields for the live renderer: what an adapter's `on.files`, `on.remove` and
 * `on.download` do, and the drag-and-drop the field's wrapper owns.
 *
 * - `on.files(picked)` hands each file to the storage the component names and writes what comes
 *   back (a single-file field stores the first file alone, a multi-file field appends), then says
 *   which files were picked in the field's status region (cleared FILE_STATUS_CLEAR_MS later, so
 *   no stale line is left). A storage that is not registered, or
 *   that rejects, leaves the field as it was and is reported (`datum-binding-error`).
 * - `on.remove(id)` drops one attachment (a single-file field goes back to holding nothing),
 *   says which one went, and keeps focus in the field: the pressed Remove button leaves with its
 *   row, so once that draw lands the field's focus target takes focus.
 * - `on.download(id)` hands an embedded (base64) attachment back as a download. It writes nothing,
 *   so a read-only field allows it.
 * - Drag-and-drop belongs to the wrapper, not to the adapter: a file dragged over a file field
 *   marks the wrapper `data-file-drag` until it leaves or lands, and a drop outside the adapter's
 *   own file input is stored like a pick. A native drop onto the input is left to the input.
 *   Entering and leaving are said in the region the adapter marks (`data-file-drop-status`), worded
 *   by the `fileDropEntered` and `fileDropLeft` texts; nothing is said where no text words them.
 *
 * The adapter draws the list (`FileFieldState.files`), the pick control, and the regions the
 * contract names (contract.ts `FILE_*_ATTRIBUTE`); the behaviour here finds them by those marks.
 * Writes pass through the renderer's write guard like every other, so none lands while the form
 * is read-only or disabled. A pick is stored before it is written, so the guard is asked again
 * when the storage answers: a submission that started meanwhile, or a field made read-only or
 * disabled, refuses the write (reported, `datum-binding-error`). A file field in a row writes to
 * that row wherever it has moved by then, and nowhere once the row is gone.
 *
 * An attachment's id (`FileItem.id`) is made from the attachment, not its place in the list, so
 * a Remove bound to it removes that file or, once it is gone, nothing.
 */
import type { PresentationField } from "../core/presentation-tree.js";
import {
  DEFAULT_FILE_STORAGE_RESOLVER,
  decodeBase64,
  type FileStorageResolver
} from "../core/file-storage.js";
import { isBase64FileAttachment, readFileAttachments, type FileAttachment, type FileUploadConfiguration } from "../../core/schema/file-upload.js";
import { ownValue } from "../../core/state/form-state.js";
import {
  FILE_ANNOUNCE_ATTRIBUTE,
  FILE_BUTTON_ATTRIBUTE,
  FILE_DRAG_ATTRIBUTE,
  FILE_DROP_STATUS_ATTRIBUTE,
  FILE_PRESS_ATTRIBUTE,
  FILE_STATUS_ATTRIBUTE,
  INSTANCE_ATTRIBUTE,
  type FieldEvents,
  type FieldState,
  type FileFieldState,
  type FileItem,
  type Words
} from "./contract.js";
import type { LiveContext, LiveFeature } from "./mount.js";

/** What the files feature takes from the host. */
export interface FilesOptions {
  /**
   * The storages picked files go through (`createFileStorageResolver`), or a function returning
   * them, read at each pick so a host that swaps the storage is heard. The engine's base64
   * storage when left out.
   */
  storage?: FileStorageResolver | (() => FileStorageResolver | undefined);
}

/** How long a pick or removal stays in the field's status region before it is cleared. */
export const FILE_STATUS_CLEAR_MS = 5000;

/** The wrapper of a file field, from any node inside it. */
const FILE_WRAPPER = '.datum-live-field[data-kind="file"]';

/** Each attachment's mark, worked out once per stored object. */
const marks = new WeakMap<object, string>();

/** A short mark of everything an attachment holds (FNV-1a over its JSON): equal attachments share it. */
function markOf(attachment: FileAttachment): string {
  let mark = marks.get(attachment);
  if (mark === undefined) {
    const text = JSON.stringify(attachment);
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    mark = hash.toString(36);
    marks.set(attachment, mark);
  }
  return mark;
}

/**
 * An attachment's id as the adapter sees it (`FileItem.id`): the field's id and a mark of the
 * attachment itself (with `occurrence`, the count of equal ones before it), never its place in
 * the list, so an id names the same file however the files around it come and go.
 */
export function fileItemId(fieldId: string, attachment: FileAttachment, occurrence = 0): string {
  return `${fieldId}__file_${markOf(attachment)}${occurrence > 0 ? `_${occurrence}` : ""}`;
}

/** The ids of `attachments`, in order. */
function fileItemIds(fieldId: string, attachments: readonly FileAttachment[]): string[] {
  const seen = new Map<string, number>();
  return attachments.map((attachment) => {
    const mark = markOf(attachment);
    const occurrence = seen.get(mark) ?? 0;
    seen.set(mark, occurrence + 1);
    return fileItemId(fieldId, attachment, occurrence);
  });
}

function indexOfItem(fieldId: string, id: string, attachments: readonly FileAttachment[]): number {
  return fileItemIds(fieldId, attachments).indexOf(id);
}

/** The attachments a file field shows, as the list an adapter draws. */
export function fileItemsOf(fieldId: string, attachments: readonly FileAttachment[]): FileItem[] {
  const ids = fileItemIds(fieldId, attachments);
  return attachments.map((attachment, index) => ({
    id: ids[index] as string,
    name: attachment.name,
    size: attachment.size,
    ...(attachment.type !== "" ? { type: attachment.type } : {}),
    ...(isBase64FileAttachment(attachment) ? { downloadable: true } : {})
  }));
}

export function createFilesFeature(options: FilesOptions = {}): LiveFeature {
  const resolver = (): FileStorageResolver => {
    const given = typeof options.storage === "function" ? options.storage() : options.storage;
    return given ?? DEFAULT_FILE_STORAGE_RESOLVER;
  };
  /** What a drop on each file field stores, by instance key; the latest draw's. */
  const stores = new Map<string, (files: readonly File[]) => void>();
  /** The status regions holding words to clear, with the timer that clears them. */
  const clearing = new Map<HTMLElement, ReturnType<typeof setTimeout>>();

  /**
   * Once the draw that follows has landed, writes `words` into the field's status region. A pick
   * is written only where the field's face asks for it (`data-file-announce`).
   */
  function announce(live: LiveContext, key: string, fallback: Words, words: (text: Words) => string, pick: boolean): void {
    void live.updated().then(
      () => {
        if (!live.mounted()) {
          return;
        }
        const status = live.wrapperOf(key)?.querySelector<HTMLElement>(`[${FILE_STATUS_ATTRIBUTE}]`);
        if (!status || (pick && !status.hasAttribute(FILE_ANNOUNCE_ATTRIBUTE))) {
          return;
        }
        const said = words(live.tree()?.text ?? fallback);
        status.textContent = said;
        // Said once, then cleared: a line left standing would be read again on the way past, in
        // the words (and the language) of a pick or removal long gone.
        const previous = clearing.get(status);
        if (previous !== undefined) {
          clearTimeout(previous);
        }
        clearing.set(
          status,
          setTimeout(() => {
            clearing.delete(status);
            if (status.textContent === said) {
              status.textContent = "";
            }
          }, FILE_STATUS_CLEAR_MS)
        );
      },
      () => undefined
    );
  }

  /**
   * Once the draw that removed a row has landed, gives focus back to the field when the pressed
   * Remove button took it away: the field's focus target (the picker, or its first control).
   */
  function keepFocus(live: LiveContext, key: string): void {
    void live.updated().then(
      () => {
        const wrapper = live.wrapperOf(key);
        const active = live.root.activeElement;
        if (live.mounted() && wrapper && !(active !== null && wrapper.contains(active))) {
          live.focusField(key);
        }
      },
      () => undefined
    );
  }

  function announceDrop(live: LiveContext, wrapper: HTMLElement, key: "fileDropEntered" | "fileDropLeft"): void {
    const region = wrapper.querySelector<HTMLElement>(`[${FILE_DROP_STATUS_ATTRIBUTE}]`);
    const text = live.tree()?.text;
    if (!region || !text) {
      return;
    }
    const said = text(key);
    // A key nobody worded resolves to itself: say nothing.
    if (said !== key) {
      region.textContent = said;
    }
  }

  return {
    id: "files",

    fieldState(state: FieldState, node: PresentationField): FieldState | void {
      const file = node.model.file;
      if (file === undefined || (state as Partial<FileFieldState>).files !== undefined) {
        return;
      }
      const next: FileFieldState = {
        ...state,
        files: fileItemsOf(state.id, file.attachments),
        multiple: file.multiple,
        ...(file.accept.length > 0 ? { accept: file.accept.join(",") } : {})
      };
      return next;
    },

    fieldEvents(on: FieldEvents, state: FieldState, node: PresentationField, draw): FieldEvents | void {
      const file = node.model.file;
      if (file === undefined) {
        return;
      }
      const live = draw.live;
      const runtime = live.runtime;
      const path = state.valuePath;
      const key = state.key;
      const row = node.model.row;
      const configuration: FileUploadConfiguration = { storage: file.storage, multiple: file.multiple, accept: file.accept, maxFileSize: file.maxFileSize };
      /**
       * Where the field's answer is now: in a row, the row this field belongs to (found by its
       * stable key) wherever it has moved since the draw; `undefined` once that row is gone.
       */
      const target = (): string | undefined => {
        const keys = row?.rowKey !== undefined ? (runtime as { entryKeys?(collectionPath: string): readonly string[] }).entryKeys?.(row.collectionPath) : undefined;
        if (row === undefined || row.rowKey === undefined || keys === undefined) {
          return path;
        }
        const at = keys.indexOf(row.rowKey);
        const drawnAt = `${row.collectionPath}[${row.index}]`;
        if (at < 0 || !path.startsWith(drawnAt)) {
          return undefined;
        }
        return `${row.collectionPath}[${at}]${path.slice(drawnAt.length)}`;
      };
      const current = (at: string): FileAttachment[] => readFileAttachments(ownValue(runtime.state().values, at));
      /** The renderer's write guard, asked again when the write lands: live, not submitting, the field neither read-only nor disabled. */
      const writable = (): boolean => {
        const drawn = live.field(key)?.state;
        return live.mounted() && live.mode === "interactive" && live.busy() !== "submitting" && drawn !== undefined && !drawn.readOnly && !drawn.disabled;
      };

      const files = async (picked: readonly File[]): Promise<void> => {
        const list = [...picked];
        if (list.length === 0 || !live.mounted()) {
          return;
        }
        const storage = resolver().resolve(configuration.storage);
        if (!storage) {
          // An authoring or host mismatch, not something the person can fix: storing through some
          // other kind would put the file somewhere the form did not say.
          live.error({ hook: "files", id: key, message: `No file storage of kind "${configuration.storage}" is registered (component "${state.componentId}"); the file was not stored.` });
          return;
        }
        const taken = configuration.multiple ? list : list.slice(0, 1);
        let stored: FileAttachment[];
        try {
          stored = await Promise.all(taken.map((item) => storage.store(item, { componentId: state.componentId, valuePath: path, configuration })));
        } catch (thrown) {
          live.error({ hook: "files", id: key, message: `Storing a file failed; the field is unchanged. ${thrown instanceof Error ? thrown.message : String(thrown)}` });
          return;
        }
        // The runtime a host swapped while a large file was being read is not this one, and a
        // row removed meanwhile takes its answer with it: nothing to write.
        const at = target();
        if (!live.mounted() || live.runtime !== runtime || at === undefined) {
          return;
        }
        // What the field took when the pick was made may not hold now: a submission started, or
        // the field became read-only or disabled while the file was being stored.
        if (!writable()) {
          live.error({ hook: "files", id: key, message: `The field stopped taking answers while the file was being stored (component "${state.componentId}"); the field is unchanged.` });
          return;
        }
        runtime.setValue(at, configuration.multiple ? [...current(at), ...stored] : stored[0]);
        const names = stored.map((attachment) => attachment.name);
        announce(live, key, state.words, (text) => text.plural("fileAnnounced", names.length, { names: names.join(", "), count: names.length }), true);
        // A pick is final as made: the leave-field check runs on it.
        on.commit();
      };

      const remove = (id: string): void => {
        const at = target();
        const attachments = at === undefined ? [] : current(at);
        const index = indexOfItem(state.id, id, attachments);
        const removed = attachments[index];
        if (at === undefined || removed === undefined) {
          return;
        }
        // The Remove button goes with its row: focus that was in the field stays in it.
        const wrapper = live.wrapperOf(key);
        const hadFocus = wrapper !== undefined && live.root.activeElement !== null && wrapper.contains(live.root.activeElement);
        const remaining = attachments.filter((_, at) => at !== index);
        runtime.setValue(at, configuration.multiple ? remaining : remaining[0]);
        announce(live, key, state.words, (text) => text("fileRemoved", { name: removed.name }), false);
        on.commit();
        if (hadFocus) {
          keepFocus(live, key);
        }
      };

      const download = (id: string): void => {
        const at = target();
        const attachments = at === undefined ? [] : current(at);
        const attachment = attachments[indexOfItem(state.id, id, attachments)];
        const doc = live.root.ownerDocument;
        if (!attachment || !isBase64FileAttachment(attachment) || typeof URL.createObjectURL !== "function") {
          return;
        }
        const bytes = decodeBase64(attachment.data);
        if (!bytes) {
          return;
        }
        const url = URL.createObjectURL(new Blob([bytes], { type: attachment.type || "application/octet-stream" }));
        const link = doc.createElement("a");
        link.href = url;
        link.download = attachment.name;
        doc.body.append(link);
        link.click();
        link.remove();
        // Revoked after the browser has had a moment to start the download, not before.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };

      stores.set(key, (dropped) => {
        void files(dropped);
      });
      return {
        ...on,
        files: (picked) => {
          void files(picked);
        },
        remove,
        download
      };
    },

    start(live: LiveContext) {
      const root = live.root;
      const wrapperOf = (event: Event): HTMLElement | null => {
        const target = event.target;
        return target instanceof Element ? target.closest<HTMLElement>(FILE_WRAPPER) : null;
      };
      /** Whether a drop here would be taken: the form is live, not submitting, and the field neither read-only nor disabled. */
      const takes = (wrapper: HTMLElement): boolean =>
        live.mode === "interactive" && live.busy() !== "submitting" && !wrapper.hasAttribute("data-readonly") && !wrapper.hasAttribute("data-disabled");
      const carriesFiles = (event: Event): boolean => {
        const types = (event as DragEvent).dataTransfer?.types;
        // A drag of text or a link is no file; an environment that says nothing is let through.
        return types === undefined || types.length === 0 || Array.from(types).includes("Files");
      };

      const onEnterOrOver = (event: Event): void => {
        const wrapper = wrapperOf(event);
        if (!wrapper || !takes(wrapper) || !carriesFiles(event)) {
          return;
        }
        if (!(event.target instanceof HTMLInputElement && event.target.type === "file")) {
          // Without this the browser refuses the drop, and a drop outside the input would open the file.
          event.preventDefault();
        }
        if (!wrapper.hasAttribute(FILE_DRAG_ATTRIBUTE)) {
          wrapper.setAttribute(FILE_DRAG_ATTRIBUTE, "");
          announceDrop(live, wrapper, "fileDropEntered");
        }
      };
      const onLeave = (event: Event): void => {
        const wrapper = wrapperOf(event);
        const into = (event as DragEvent).relatedTarget;
        if (wrapper && !(into instanceof Node && wrapper.contains(into)) && wrapper.hasAttribute(FILE_DRAG_ATTRIBUTE)) {
          wrapper.removeAttribute(FILE_DRAG_ATTRIBUTE);
          announceDrop(live, wrapper, "fileDropLeft");
        }
      };
      const onDrop = (event: Event): void => {
        const wrapper = wrapperOf(event);
        if (!wrapper) {
          return;
        }
        wrapper.removeAttribute(FILE_DRAG_ATTRIBUTE);
        const native = event.target instanceof HTMLInputElement && event.target.type === "file";
        const dropped = Array.from((event as DragEvent).dataTransfer?.files ?? []);
        if (native || !takes(wrapper) || !carriesFiles(event)) {
          return;
        }
        event.preventDefault();
        const key = wrapper.getAttribute(INSTANCE_ATTRIBUTE);
        if (key !== null && dropped.length > 0) {
          stores.get(key)?.(dropped);
        }
      };

      // A press on a face's pseudo-button lands on the invisible input laid over the face, so the
      // button never matches :active. A press that starts inside the button's box marks the field
      // until it ends, for the binding's CSS to sink the button as a real one sinks.
      const view = root.ownerDocument.defaultView;
      const onPress = (event: Event): void => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || input.type !== "file" || input.disabled) {
          return;
        }
        const wrapper = input.closest<HTMLElement>(FILE_WRAPPER);
        const button = wrapper?.querySelector<HTMLElement>(`[${FILE_BUTTON_ATTRIBUTE}]`);
        if (!wrapper || !button || !view) {
          return;
        }
        const box = button.getBoundingClientRect();
        const { clientX: x, clientY: y } = event as PointerEvent;
        if (x < box.left || x > box.right || y < box.top || y > box.bottom) {
          return;
        }
        wrapper.setAttribute(FILE_PRESS_ATTRIBUTE, "");
        const release = (): void => {
          wrapper.removeAttribute(FILE_PRESS_ATTRIBUTE);
          view.removeEventListener("pointerup", release, true);
          view.removeEventListener("pointercancel", release, true);
        };
        view.addEventListener("pointerup", release, true);
        view.addEventListener("pointercancel", release, true);
      };

      root.addEventListener("dragenter", onEnterOrOver);
      root.addEventListener("dragover", onEnterOrOver);
      root.addEventListener("dragleave", onLeave);
      root.addEventListener("drop", onDrop);
      root.addEventListener("pointerdown", onPress);
      return () => {
        root.removeEventListener("dragenter", onEnterOrOver);
        root.removeEventListener("dragover", onEnterOrOver);
        root.removeEventListener("dragleave", onLeave);
        root.removeEventListener("drop", onDrop);
        root.removeEventListener("pointerdown", onPress);
        stores.clear();
        for (const timer of clearing.values()) {
          clearTimeout(timer);
        }
        clearing.clear();
      };
    },

    afterDraw(_report, live) {
      // A field that left the form takes its drop target with it.
      const present = new Set(live.fields().map((field) => field.key));
      for (const key of [...stores.keys()]) {
        if (!present.has(key)) {
          stores.delete(key);
        }
      }
    }
  };
}

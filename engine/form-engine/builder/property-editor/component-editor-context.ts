import type {
  ComponentEditorContext,
  ComponentUpdater
} from "../../core/schema/contracts.js";
import type { ComponentNode } from "../../core/schema/types.js";
import { ComponentTree } from "../../core/tree/component-tree.js";
import { TreeEditor } from "../tree-editor/tree-editor.js";

function isTreeEditor(value: ComponentTree | TreeEditor): value is TreeEditor {
  return value instanceof TreeEditor;
}

export function createComponentEditorContext(
  treeOrEditor: ComponentTree | TreeEditor,
  componentId: string
): ComponentEditorContext {
  const tree = isTreeEditor(treeOrEditor) ? treeOrEditor.componentTree() : treeOrEditor;
  const component = tree.find(componentId);
  if (!component) {
    throw new Error(`Component not found: ${componentId}`);
  }

  return {
    component,
    get<T>(path: string): T | undefined {
      return tree.getConfigurationValue(componentId, path) as T | undefined;
    },
    set<T>(path: string, value: T): void {
      if (isTreeEditor(treeOrEditor)) {
        treeOrEditor.setProperty(componentId, path, value);
        return;
      }
      tree.setConfigurationValue(componentId, path, value);
    },
    remove(path: string): void {
      if (isTreeEditor(treeOrEditor)) {
        treeOrEditor.removeProperty(componentId, path);
        return;
      }
      tree.removeConfigurationValue(componentId, path);
    },
    update(updater: ComponentUpdater): void {
      const snapshot = tree.getConfiguration(componentId);
      const base =
        snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
          ? (snapshot as Record<string, unknown>)
          : {};

      const next = { ...base };
      updater(next);

      if (isTreeEditor(treeOrEditor)) {
        treeOrEditor.replaceConfiguration(componentId, next);
        return;
      }
      tree.replaceConfiguration(componentId, next);
    }
  };
}

export function createPropertyEditorContext(component: ComponentNode) {
  return { component };
}

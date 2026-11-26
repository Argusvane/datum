import type { ComponentPath } from "../schema/types.js";

export type EventSource = "runtime" | "renderer" | "builder" | "validation" | "plugin";

export interface FormEvent {
  id: string;
  type: string;
  timestamp: number;
  source: EventSource;
  formId: string;
  componentId?: string;
  path?: ComponentPath;
  data?: unknown;
}

export type FormEventListener = (event: FormEvent) => void;

export class EventBus {
  private readonly listeners = new Map<string, Set<FormEventListener>>();

  public subscribe(eventType: string, listener: FormEventListener): () => void {
    const group = this.listeners.get(eventType) ?? new Set<FormEventListener>();
    group.add(listener);
    this.listeners.set(eventType, group);

    return () => {
      group.delete(listener);
      if (group.size === 0) {
        this.listeners.delete(eventType);
      }
    };
  }

  public publish(event: FormEvent): void {
    const exactListeners = this.listeners.get(event.type) ?? new Set<FormEventListener>();
    const wildcardListeners = this.listeners.get("*") ?? new Set<FormEventListener>();

    for (const listener of [...exactListeners, ...wildcardListeners]) {
      listener(event);
    }
  }
}

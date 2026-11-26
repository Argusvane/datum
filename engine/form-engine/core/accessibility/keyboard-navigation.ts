export interface KeyboardNavigationState {
  mode: "standard" | "wizard";
  activeStepId?: string;
  orderedFocusableIds: string[];
  currentFocusIndex: number;
}

export function nextFocusableId(state: KeyboardNavigationState): string | undefined {
  if (state.orderedFocusableIds.length === 0) {
    return undefined;
  }

  const nextIndex = Math.min(
    state.currentFocusIndex + 1,
    state.orderedFocusableIds.length - 1
  );

  return state.orderedFocusableIds[nextIndex];
}

export function previousFocusableId(state: KeyboardNavigationState): string | undefined {
  if (state.orderedFocusableIds.length === 0) {
    return undefined;
  }

  const previousIndex = Math.max(state.currentFocusIndex - 1, 0);
  return state.orderedFocusableIds[previousIndex];
}

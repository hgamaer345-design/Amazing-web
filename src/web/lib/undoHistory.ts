// Undo/redo history as a reducer. `present` is the live value; `past` and `future` hold snapshots.
// Values are immutable, so snapshots are just references.

export const MAX_HISTORY = 200;

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

export type HistoryAction<T> =
  /** Applies a pure update to `present`. An update returning the same object is not recorded. */
  | { type: 'apply'; update: (present: T) => T }
  | { type: 'undo' }
  | { type: 'redo' }
  /** Replaces everything (e.g. after loading the server's version on a conflict). */
  | { type: 'reset'; present: T };

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

export function canUndo<T>(state: History<T>): boolean {
  return state.past.length > 0;
}

export function canRedo<T>(state: History<T>): boolean {
  return state.future.length > 0;
}

export function historyReducer<T>(state: History<T>, action: HistoryAction<T>): History<T> {
  switch (action.type) {
    case 'apply': {
      const next = action.update(state.present);
      if (next === state.present) return state;
      const past = [...state.past, state.present];
      if (past.length > MAX_HISTORY) past.splice(0, past.length - MAX_HISTORY);
      return { past, present: next, future: [] };
    }
    case 'undo': {
      if (state.past.length === 0) return state;
      const previous = state.past[state.past.length - 1] as T;
      return { past: state.past.slice(0, -1), present: previous, future: [state.present, ...state.future] };
    }
    case 'redo': {
      if (state.future.length === 0) return state;
      const [next, ...future] = state.future as [T, ...T[]];
      return { past: [...state.past, state.present], present: next, future };
    }
    case 'reset':
      return createHistory(action.present);
  }
}

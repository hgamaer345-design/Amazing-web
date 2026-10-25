import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react';

export interface PopoverControls {
  open: boolean;
  /** Id of the popup element (for aria-controls). */
  id: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  popupRef: RefObject<HTMLDivElement | null>;
  show(): void;
  toggle(): void;
  /** Closes the popup; focus returns to the trigger unless `returnFocus` is false. */
  close(options?: { returnFocus?: boolean }): void;
}

/**
 * Open state and dismissal for a menu or small dialog anchored to a trigger button: Escape closes and
 * returns focus to the trigger; a pointer press or focus move outside closes without stealing focus.
 */
export function usePopover(): PopoverControls {
  const [open, setOpen] = useState(false);
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback((options?: { returnFocus?: boolean }) => {
    setOpen(false);
    if (options?.returnFocus !== false) triggerRef.current?.focus();
  }, []);
  const show = useCallback(() => setOpen(true), []);
  const toggle = useCallback(() => setOpen((o) => !o), []);

  useEffect(() => {
    if (!open) return undefined;
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (popupRef.current?.contains(target) || triggerRef.current?.contains(target));
    const onPointerDown = (e: PointerEvent) => {
      if (!inside(e.target)) close({ returnFocus: false });
    };
    const onFocusIn = (e: FocusEvent) => {
      if (!inside(e.target)) close({ returnFocus: false });
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  return { open, id, triggerRef, popupRef, show, toggle, close };
}

import { useLayoutEffect, type KeyboardEvent, type ReactNode } from 'react';
import type { PopoverControls } from '../../hooks/usePopover';

const MENU_ITEM_SELECTOR = '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)';
const VIEWPORT_MARGIN = 8;

export interface PopoverProps {
  controls: PopoverControls;
  /** "menu" adds arrow-key navigation between menu items; "dialog" is for small inline forms. */
  role: 'menu' | 'dialog';
  label: string;
  align?: 'start' | 'end';
  className?: string;
  children: ReactNode;
}

function menuItems(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR));
}

/** Popup panel anchored below its trigger (the parent must be `position: relative`). */
export function Popover({ controls, role, label, align = 'start', className, children }: PopoverProps) {
  const { open, popupRef, id, close } = controls;

  useLayoutEffect(() => {
    const el = popupRef.current;
    if (!open || !el) return;
    // Keep the panel on screen: on a phone a right-aligned menu can otherwise overflow the left edge.
    el.style.transform = '';
    const rect = el.getBoundingClientRect();
    const viewport = document.documentElement.clientWidth || window.innerWidth;
    let shift = 0;
    if (rect.right > viewport - VIEWPORT_MARGIN) shift = viewport - VIEWPORT_MARGIN - rect.right;
    if (rect.left + shift < VIEWPORT_MARGIN) shift = VIEWPORT_MARGIN - rect.left;
    if (shift) el.style.transform = `translateX(${Math.round(shift)}px)`;
    if (role === 'menu') menuItems(el)[0]?.focus();
  }, [open, role, popupRef]);

  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (role !== 'menu') return;
    const items = menuItems(e.currentTarget);
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    switch (e.key) {
      case 'ArrowDown':
        next = current < 0 ? 0 : (current + 1) % items.length;
        break;
      case 'ArrowUp':
        next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      case 'Tab':
        // Focus the trigger first so the browser's own Tab move continues from there.
        close();
        return;
      default:
        return;
    }
    e.preventDefault();
    items[next]?.focus();
  };

  return (
    <div
      ref={popupRef}
      id={id}
      role={role}
      aria-label={label}
      className={`popover popover-${align}${className ? ` ${className}` : ''}`}
      onKeyDown={onKeyDown}
      data-no-seek=""
    >
      {children}
    </div>
  );
}

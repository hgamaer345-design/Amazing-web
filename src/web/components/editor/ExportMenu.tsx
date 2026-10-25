import type { ExportFormat } from '../../../shared/types';
import { usePopover } from '../../hooks/usePopover';
import { ChevronDownIcon, DownloadIcon } from './icons';
import { Popover } from './Popover';

export const EXPORT_OPTIONS: readonly { format: ExportFormat; label: string }[] = [
  { format: 'csv', label: 'CSV (.csv)' },
  { format: 'xlsx', label: 'Excel (.xlsx)' },
  { format: 'txt', label: 'Text (.txt)' },
  { format: 'srt', label: 'Subtitles (.srt)' },
  { format: 'docx', label: 'Word (.docx)' },
];

export interface ExportMenuProps {
  /** True while pending edits are being saved before a download starts. */
  busy: boolean;
  onExport: (format: ExportFormat) => void;
}

export function ExportMenu({ busy, onExport }: ExportMenuProps) {
  const popover = usePopover();
  return (
    <div className="menu-anchor">
      <button
        ref={popover.triggerRef}
        type="button"
        className="btn btn-primary"
        aria-haspopup="menu"
        aria-expanded={popover.open}
        aria-controls={popover.open ? popover.id : undefined}
        // aria-disabled rather than disabled, so focus stays on the button while the download is prepared.
        aria-disabled={busy || undefined}
        onClick={() => {
          if (!busy) popover.toggle();
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !popover.open && !busy) {
            e.preventDefault();
            popover.show();
          }
        }}
      >
        {busy ? <span className="spinner" aria-hidden="true" /> : <DownloadIcon />}
        {busy ? 'Preparing…' : 'Export'}
        <ChevronDownIcon />
      </button>
      <Popover controls={popover} role="menu" label="Export format" align="end">
        {EXPORT_OPTIONS.map((o) => (
          <button
            key={o.format}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="menu-item"
            onClick={() => {
              popover.close();
              onExport(o.format);
            }}
          >
            {o.label}
          </button>
        ))}
      </Popover>
    </div>
  );
}

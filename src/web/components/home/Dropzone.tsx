import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { formatBytes } from '../../../shared/time';
import { FORMAT_LABELS } from '../../lib/fileValidation';

export interface DropzoneProps {
  acceptedExtensions: readonly string[];
  maxBytes: number;
  disabled?: boolean;
  /** Smaller variant shown once a file is chosen ("Choose a different file"). */
  compact?: boolean;
  onFile: (file: File) => void;
}

function UploadCloudIcon() {
  return (
    <svg viewBox="0 0 48 48" width="44" height="44" aria-hidden="true">
      <path
        d="M15 34h-2a9 9 0 0 1-1.4-17.9A12 12 0 0 1 35 14a8 8 0 0 1 1 20h-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M24 40V24m0 0-6 6m6-6 6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Drag-and-drop target that is also a button opening the file picker (Enter/Space). */
export function Dropzone({ acceptedExtensions, maxBytes, disabled, compact, onFile }: DropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave fire for every child element; count them so the highlight doesn't flicker.
  const depth = useRef(0);
  const accept = [...acceptedExtensions.map((e) => `.${e}`), 'audio/*'].join(',');

  const browse = () => {
    if (!disabled) inputRef.current?.click();
  };
  const onDragEnter = (e: DragEvent) => {
    e.preventDefault();
    if (disabled) return;
    depth.current += 1;
    setDragging(true);
  };
  const onDragLeave = (e: DragEvent) => {
    e.preventDefault();
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    if (disabled) return;
    const file = e.dataTransfer.files?.[0];
    if (file) onFile(file);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      browse();
    }
  };

  return (
    <div
      className={`dropzone${dragging ? ' is-dragging' : ''}${compact ? ' dropzone-compact' : ''}${disabled ? ' is-disabled' : ''}`}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      aria-label={
        compact ? 'Choose a different audio file' : 'Choose an audio file to upload, or drop it here'
      }
      onClick={browse}
      onKeyDown={onKeyDown}
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      data-testid="dropzone"
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        hidden
        aria-label="Audio file"
        data-testid="file-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) onFile(file);
        }}
      />
      {compact ? (
        <span className="dropzone-compact-text">
          <UploadCloudIcon />
          Drop another file here or <span className="dropzone-link">browse</span>
        </span>
      ) : (
        <>
          <span className="dropzone-icon">
            <UploadCloudIcon />
          </span>
          <span className="dropzone-title">{dragging ? 'Drop it!' : 'Drop your audio here'}</span>
          <span className="dropzone-sub">
            or <span className="dropzone-link">browse your files</span> · up to {formatBytes(maxBytes)}
          </span>
          <span className="dropzone-formats" aria-label="Supported formats">
            {FORMAT_LABELS.map((f) => (
              <span key={f} className="format-chip">
                {f}
              </span>
            ))}
          </span>
        </>
      )}
    </div>
  );
}

import { useState } from 'react';
import type { Speaker } from '../../../shared/types';
import { usePopover } from '../../hooks/usePopover';
import { nextSpeakerName } from '../../lib/docOps';
import { speakerStyleVars } from '../../lib/speakerStyle';
import { CheckIcon, ChevronDownIcon } from './icons';
import { Popover } from './Popover';
import { SpeakerNameForm } from './SpeakerNameForm';

export interface SpeakerMenuProps {
  rowId: string;
  rowNumber: number;
  speaker: Speaker;
  speakers: readonly Speaker[];
  onRenameSpeaker: (speakerId: string, name: string) => void;
  onReassign: (rowId: string, speakerId: string) => void;
  onReassignNew: (rowId: string, name: string) => void;
}

type View = 'menu' | 'rename' | 'new';

/** The row's speaker chip; opens a menu to rename the speaker or move the row to another/new speaker. */
export function SpeakerMenu({
  rowId,
  rowNumber,
  speaker,
  speakers,
  onRenameSpeaker,
  onReassign,
  onReassignNew,
}: SpeakerMenuProps) {
  const popover = usePopover();
  const [view, setView] = useState<View>('menu');

  const openMenu = () => {
    setView('menu');
    popover.show();
  };

  return (
    <div className="spk-menu">
      <button
        ref={popover.triggerRef}
        type="button"
        className="spk-chip spk-chip-button"
        style={speakerStyleVars(speaker.colorIndex)}
        aria-haspopup="menu"
        aria-expanded={popover.open}
        aria-controls={popover.open ? popover.id : undefined}
        aria-label={`${speaker.name}: change speaker of row ${rowNumber}`}
        onClick={() => (popover.open ? popover.close() : openMenu())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !popover.open) {
            e.preventDefault();
            openMenu();
          }
        }}
      >
        <span className="spk-dot" aria-hidden="true" />
        <span className="spk-chip-name">{speaker.name}</span>
        <ChevronDownIcon />
      </button>

      {view === 'menu' ? (
        <Popover controls={popover} role="menu" label={`Speaker of row ${rowNumber}`} className="spk-menu-popover">
          <button type="button" role="menuitem" tabIndex={-1} className="menu-item" onClick={() => setView('rename')}>
            Rename speaker…
          </button>
          <div role="separator" className="menu-separator" />
          <div role="group" aria-label="Move row to">
            <div className="menu-group-label" aria-hidden="true">
              Move row to
            </div>
            {speakers.map((s) => {
              const current = s.id === speaker.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={current}
                  tabIndex={-1}
                  className="menu-item"
                  style={speakerStyleVars(s.colorIndex)}
                  onClick={() => {
                    if (!current) onReassign(rowId, s.id);
                    popover.close();
                  }}
                >
                  <span className="spk-dot" aria-hidden="true" />
                  <span className="menu-item-label">{s.name}</span>
                  {current && <CheckIcon />}
                </button>
              );
            })}
          </div>
          <div role="separator" className="menu-separator" />
          <button type="button" role="menuitem" tabIndex={-1} className="menu-item" onClick={() => setView('new')}>
            New speaker…
          </button>
        </Popover>
      ) : (
        <Popover
          controls={popover}
          role="dialog"
          label={view === 'rename' ? 'Rename speaker' : 'Move row to a new speaker'}
          className="spk-menu-popover"
        >
          {view === 'rename' ? (
            <SpeakerNameForm
              key="rename"
              initialName={speaker.name}
              label="Speaker name"
              showLabel
              onSubmit={(name) => {
                onRenameSpeaker(speaker.id, name);
                popover.close();
              }}
              onCancel={() => popover.close()}
            />
          ) : (
            <SpeakerNameForm
              key="new"
              initialName={nextSpeakerName(speakers)}
              label="New speaker name"
              submitLabel="Move row"
              showLabel
              onSubmit={(name) => {
                onReassignNew(rowId, name);
                popover.close();
              }}
              onCancel={() => popover.close()}
            />
          )}
        </Popover>
      )}
    </div>
  );
}

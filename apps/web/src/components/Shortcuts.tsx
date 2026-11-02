import { useEffect, useState } from 'react';
import { Modal } from './Modal';

export const SHORTCUTS: Array<[string, string]> = [
  ['Space', 'Play or pause'],
  ['K', 'Play or pause'],
  ['← → J L', 'Back or forward 5 seconds'],
  ['Shift+← Shift+→', 'Previous or next track'],
  ['↑ ↓', 'Volume up or down'],
  ['M', 'Mute'],
  ['R', 'Repeat this track'],
  ['A B', 'Switch versions while comparing'],
  ['?', 'Show these shortcuts'],
];

/** Press ? anywhere (outside text fields) to see the keyboard shortcuts. */
export function ShortcutsDialog() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== '?' || e.metaKey || e.ctrlKey || t?.closest('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  return (
    <Modal open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts">
      <dl className="shortcut-list">
        {SHORTCUTS.map(([keys, what]) => (
          <div key={keys}>
            <dt>{keys.split(' ').map((k) => <kbd key={k}>{k}</kbd>)}</dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}

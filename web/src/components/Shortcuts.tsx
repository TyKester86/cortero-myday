import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

export const SHORTCUTS: Array<[keys: string, label: string, to?: string]> = [
  ['g t', 'Today', '/'],
  ['g d', 'My day', '/day'],
  ['g c', 'Command center', '/command'],
  ['g m', 'Meals', '/meals'],
  ['g g', 'Grocery list', '/meals/grocery'],
  ['g h', 'Ask Hana', '/hana'],
  ['g s', 'School', '/school'],
  ['g b', 'Bills', '/bills'],
  ['g r', 'Records', '/records'],
  ['g w', 'Family wins', '/wins'],
  ['n', 'Quick note (focus the box)'],
  ['?', 'Show / hide this help'],
  ['Esc', 'Close'],
];

function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

/** Keyboard shortcuts (desktop) + the "?" help overlay. */
export default function Shortcuts({ enabled }: { enabled: boolean }) {
  const nav = useNavigate();
  const [help, setHelp] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let pendingG = 0;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setHelp(false);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (e.key === '?') {
        e.preventDefault();
        setHelp((h) => !h);
        return;
      }
      if (e.key === 'n') {
        const box = document.getElementById('quick-note');
        if (box) {
          e.preventDefault();
          box.focus();
        } else {
          nav('/command');
        }
        return;
      }
      if (e.key === 'g') {
        pendingG = Date.now();
        return;
      }
      if (Date.now() - pendingG < 1200) {
        const hit = SHORTCUTS.find(([k]) => k === `g ${e.key}`);
        pendingG = 0;
        if (hit?.[2]) {
          e.preventDefault();
          nav(hit[2]);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, nav]);

  if (!help) return null;
  return (
    <div className="overlay" onClick={() => setHelp(false)} role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" data-testid="shortcut-help">
      <div className="firstrun" onClick={(e) => e.stopPropagation()}>
        <h2>Keyboard shortcuts</h2>
        <table className="keys">
          <tbody>
            {SHORTCUTS.map(([k, label]) => (
              <tr key={k}>
                <td>
                  {k.split(' ').map((x) => (
                    <kbd key={x} style={{ marginRight: 4 }}>
                      {x}
                    </kbd>
                  ))}
                </td>
                <td>{label}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="btn small" onClick={() => setHelp(false)}>
          Close
        </button>
      </div>
    </div>
  );
}

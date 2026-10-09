/**
 * The MyDay nav icon set: outlined line icons on a 24px grid, 1.8 stroke,
 * round caps and joins, drawn in currentColor so active/inactive colors come
 * from the link. The first block is the designed set (myday-nav-icons);
 * the second fills in pages that set didn't cover, in the same style.
 */
const P: Record<string, string> = {
  today: '<circle cx="12" cy="12" r="8.5"/><path d="m8.7 12.3 2.4 2.4 4.2-4.8"/>',
  'weekly-plan': '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17"/><path d="M8 2.8v3.6M16 2.8v3.6"/>',
  family: '<path d="M12 20.5C7 16.5 3.5 13.3 3.5 9.6 3.5 7 5.5 5 8 5c1.6 0 3.1.8 4 2.1C12.9 5.8 14.4 5 16 5c2.5 0 4.5 2 4.5 4.6 0 3.7-3.5 6.9-8.5 10.9z"/>',
  money: '<rect x="2.8" y="6.5" width="18.4" height="11" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6.2 9.6h.01M17.8 14.4h.01"/>',
  everything: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.8"/>',
  'my-progress': '<path d="m3.5 17 5.5-5.5 3.5 3.5 7.5-7.5"/><path d="M15 7.5h5v5"/>',
  'my-day': '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7"/>',
  health: '<path d="M3.5 12h3.5l2-5.5 4 11 2-5.5h5.5"/>',
  meals: '<path d="M4.5 3v4a2.5 2.5 0 0 0 5 0V3"/><path d="M7 3v7"/><path d="M7 10v11"/><path d="M17.5 3c-2 1.8-3 4.5-3 7.5h3V21"/><path d="M17.5 3v7.5"/>',
  'grocery-list': '<path d="M3 4.5h2.2l2.3 11h10.6l2.4-7.5H7"/><circle cx="9.6" cy="19.6" r="1.3"/><circle cx="16.8" cy="19.6" r="1.3"/>',
  'brain-dump': '<path d="M9.5 18h5"/><path d="M10.5 21h3"/><path d="M12 3a6 6 0 0 0-3.3 11c.7.5 1.3 1.2 1.3 2h4c0-.8.6-1.5 1.3-2A6 6 0 0 0 12 3z"/>',
  challenges: '<path d="M8 4h8v5.5a4 4 0 0 1-8 0z"/><path d="M8 5.5H4.8A3.2 3.2 0 0 0 8 11M16 5.5h3.2A3.2 3.2 0 0 1 16 11"/><path d="M12 13.5V17"/><path d="M8.5 20.5h7M10 17.5h4"/>',
  chores: '<path d="M10.5 4.5 12 8.7l4.2 1.5-4.2 1.5-1.5 4.2-1.5-4.2-4.2-1.5L9 8.7z"/><path d="M18 3.5v3M16.5 5h3"/><path d="m18.6 15.4.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7z"/>',
  household: '<path d="m4 11 8-6.5L20 11"/><path d="M6.2 9.3V19a1 1 0 0 0 1 1h9.6a1 1 0 0 0 1-1V9.3"/>',
  school: '<path d="m2.5 9 9.5-4.8L21.5 9 12 13.8z"/><path d="M6.5 11.2v4.6c0 1.6 2.5 2.9 5.5 2.9s5.5-1.3 5.5-2.9v-4.6"/><path d="M21.5 9v4.5"/>',
  lectures: '<rect x="9" y="2.8" width="6" height="10" rx="3"/><path d="M6.5 11a5.5 5.5 0 0 0 11 0"/><path d="M12 16.5V21"/><path d="M9 21h6"/>',
  'family-wins': '<circle cx="12" cy="14.5" r="4.5"/><path d="m9 10.8-2.8-6.3L9.5 6l2.5-2.5L14.5 6l3.3-1.5L15 10.8"/><path d="m10.8 14.3 1.2 1.2 2.2-2.4"/>',
  'focus-timer': '<circle cx="12" cy="13.5" r="7"/><path d="M12 10v3.8l2.6 1.7"/><path d="M9.8 3h4.4M12 3v3.6"/>',
  'bills-income': '<path d="M6 3.5h12V21l-2-1.4-2 1.4-2-1.4L10 21l-2-1.4L6 21z"/><path d="M9.3 8.5h5.4M9.3 12h5.4"/>',
  identity: '<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20c1.4-3.6 4-5.4 7.2-5.4s5.8 1.8 7.2 5.4"/>',
  records: '<rect x="3" y="4" width="18" height="4.5" rx="1"/><path d="M4.5 8.5V19a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1V8.5"/><path d="M10 12.5h4"/>',
  investments: '<path d="M4 4v16h16"/><path d="m8.5 15.5 3-4 2.8 2 4.2-5.5"/>',

  // Same style, for pages the designed set didn't cover.
  homework: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z"/><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z"/>',
  helper: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3.5V17A2.5 2.5 0 0 1 4 14.5z"/><path d="M10 8.8a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2"/><path d="M12 14h.01"/>',
  rewards: '<rect x="3.5" y="8" width="17" height="4" rx="1"/><path d="M5.5 12v7.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V12"/><path d="M12 8v12.5"/><path d="M12 8C10.8 5 7.5 4.3 7.5 6.3 7.5 8 12 8 12 8zM12 8c1.2-3 4.5-3.7 4.5-1.7C16.5 8 12 8 12 8z"/>',
  chat: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3.5V17A2.5 2.5 0 0 1 4 14.5z"/><path d="M8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><path d="M12 14.5v2"/>',
  piggy: '<path d="M5 11.5a6.5 5.5 0 0 1 12.2-2.6H19v3.6l1.5.8v2.4l-1.8.6a6.6 6.6 0 0 1-2.2 2.2V20h-2.5v-1a8 8 0 0 1-3.6 0v1H7.9v-2.2A5.4 5.4 0 0 1 5 11.5z"/><path d="M10 7.5c.5-1.3 2.2-2 3.7-1.5"/><path d="M15.5 11h.01"/>',
  circles: '<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19c1-3 3-4.5 5.5-4.5s4.5 1.5 5.5 4.5"/><circle cx="16.5" cy="9.5" r="2.4"/><path d="M15.8 14.6c2.2-.2 3.9 1.1 4.7 3.6"/>',
  care: '<path d="M6.5 3.5v5a4 4 0 0 0 8 0v-5"/><path d="M10.5 12.5v2.5a4.5 4.5 0 0 0 9 0v-1.5"/><circle cx="19.5" cy="12" r="1.6"/>',
  card: '<rect x="2.8" y="5.5" width="18.4" height="13" rx="2"/><path d="M2.8 10h18.4"/><path d="M6.5 15h3"/>',
  admin: '<path d="M14.5 5.2a4 4 0 0 0-5 5.2l-5.8 5.8a1.6 1.6 0 0 0 2.3 2.3l5.8-5.8a4 4 0 0 0 5.2-5l-2.4 2.4-2.3-.5-.5-2.3z"/>',
  meetings: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>',
  errands: '<path d="M6 8h12l-1 11.2A2 2 0 0 1 15 21H9a2 2 0 0 1-2-1.8z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/><path d="M9.5 14.5l1.8 1.8 3.4-3.6"/>',
  inbox: '<path d="M3.5 13.5l2.6-7.2A2 2 0 0 1 8 5h8a2 2 0 0 1 1.9 1.3l2.6 7.2V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M3.5 13.5h4.6l1.4 2.5h5l1.4-2.5h4.6"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 2.8v3.6M16 2.8v3.6"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01"/>',
  village: '<path d="M3.5 5.5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H9l-3.5 3v-3a2 2 0 0 1-2-2z"/><path d="M18 8.5h.5a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2v3l-3.5-3h-4a2 2 0 0 1-1.9-1.4"/>',
  feed: '<rect x="4" y="3.5" width="16" height="17" rx="2.5"/><circle cx="8.5" cy="8.3" r="1.6"/><path d="M11.5 7.5h5M11.5 9.5h3M7.5 13.5h9M7.5 16.5h6"/>',
  library: '<path d="M4 4.5h3.2v15H4z"/><path d="M8.6 4.5h3.2v15H8.6z"/><path d="m13.6 5.6 3-.8 3.6 13.9-3 .8z"/><path d="M4 8h3.2M8.6 8h3.2M4 16h3.2M8.6 16h3.2"/>',
  // Row and card icons for the hybrid layouts (same style).
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2H4.5z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  chevron: '<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>',
  back: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  flame: '<path d="M12 21c-3.6 0-6.5-2.6-6.5-6.2 0-3.4 2.6-5.6 3.8-8.8.4 1.8 1.4 3 2.7 3.6-.2-2.8 1-5.2 3.2-6.6-.4 3.2 3.3 5.4 3.3 10 0 4.6-3 8-6.5 8z"/><path d="M12 21c-1.6 0-2.8-1.2-2.8-2.8 0-1.8 1.6-2.6 2.2-4.4 1.6 1.2 3.4 2.2 3.4 4.4 0 1.6-1.2 2.8-2.8 2.8z"/>',
  house: '<path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5.5h4V20"/>',
  bolt: '<path d="M13 2.8 5 13.5h6l-1 7.7 8-10.7h-6z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8 7.5 9.5 4.3-1.5 7.5-4.9 7.5-9.5V6z"/><path d="m8.8 12 2.3 2.3 4.3-4.6"/>',
  star: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 17l-5.2 2.7 1-5.9-4.3-4.1 5.9-.8z"/>',
  camera: '<path d="M4 8h3l1.8-2.5h6.4L17 8h3v11H4z"/><circle cx="12" cy="13.2" r="3.4"/>',
  'heart-hands': '<path d="M12 20.3 5.4 13.9a4 4 0 0 1 5.7-5.7l.9.9.9-.9a4 4 0 0 1 5.7 5.7z"/><path d="M4 18.5c2-1 4 0 5.5 1.5M20 18.5c-2-1-4 0-5.5 1.5"/>',
  dumbbell: '<path d="M3.5 9.5v5M6.5 7.5v9M17.5 7.5v9M20.5 9.5v5M6.5 12h11"/>',
  plate: '<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="3.5"/><path d="M2.8 5v4.5a1.6 1.6 0 0 0 3 0V5M4.3 10.5V19M20.5 5c-1.5 1.2-2 3-2 5h2v9"/>',
  receipt: '<path d="M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z"/><path d="M9 8h6M9 11.5h6M9 15h3.5"/>',
  sparkle: '<path d="M12 3.5 13.8 10l6.7 2-6.7 2L12 20.5 10.2 14l-6.7-2 6.7-2z"/>',
  message: '<path d="M4 5.5h16v10.5H9l-5 4z"/><path d="M8.5 10.8h.01M12 10.8h.01M15.5 10.8h.01"/>',
  share: '<path d="M12 3.5v11"/><path d="M8 7.5 12 3.5l4 4"/><path d="M5.5 12.5V20h13v-7.5"/>',
  more: '<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>',
  license: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M6 15.5c.6-1.4 1.7-2 3-2s2.4.6 3 2M14 10h3.5M14 13h3.5"/>',
  'calendar-check': '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M8 2.8v3.6M16 2.8v3.6"/><path d="m8.8 13.5 2.2 2.2 4.2-4.2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8"/><circle cx="12" cy="12" r="6.3"/>',
};

export const NAV_ICON_KEYS = [...Object.keys(P), 'hana'];

/** Hana's portrait (web/public/images/hana-face.webp) — wherever Hana appears. */
export const HANA_FACE = '/images/hana-face.webp';

export function HanaFace({ size = 20, className = '' }: { size?: number; className?: string }) {
  return <img className={`hana-face ${className}`.trim()} src={HANA_FACE} width={size} height={size} alt="" aria-hidden="true" decoding="async" />;
}

/**
 * The Feed's mark: the vintage bulb horn ("ah-ooo-ga"). With `tile`, amber on its dark tile (hero, headers —
 * same drawing as /icons/feed-horn.svg); without, a currentColor glyph that sits with the line icons.
 * The Feed never uses the MyDay mark.
 */
export function FeedHorn({ size = 20, tile = false, className = '' }: { size?: number; tile?: boolean; className?: string }) {
  const ink = tile ? '#e38a4a' : 'currentColor';
  return (
    <svg
      className={`feed-horn ${className}`.trim()}
      width={size}
      height={size}
      viewBox={tile ? '0 0 64 64' : '4 2 54 60'}
      aria-hidden="true"
      focusable="false"
    >
      {tile && <rect width="64" height="64" rx="14" fill="#1f1714" />}
      <g fill={ink}>
        <path d="M17 19.4C32 19.4 42.6 14.8 48.4 6.2L48.4 37.8C42.6 29.6 32 24.6 17 24.6Z" />
        <rect x="49.6" y="3.2" width="4.9" height="37.6" rx="2.45" />
        <path fill="none" stroke={ink} strokeWidth={5.2} strokeLinecap="round" d="M20 22C13 22 11 23.8 11 27C11 30.2 13 32 20 32L27 32C38.5 32 40 51 28.5 52.5L24.5 52.5" />
        <rect x="20.2" y="48.4" width="4.6" height="8.2" rx="1.2" />
        <ellipse cx="13.6" cy="52.5" rx="7.6" ry="8.2" />
      </g>
      {tile && (
        <g fill="none" stroke="#1f1714" strokeWidth={1.15} strokeLinecap="round">
          <path d="M9.4 46.5C12.5 49.5 12.5 55.5 9.4 58.5" />
          <path d="M13.6 45C15.8 48.6 15.8 56.4 13.6 60" />
          <path d="M17.6 46.3C19.6 49.5 19.6 55.5 17.6 58.7" />
        </g>
      )}
    </svg>
  );
}

export function NavIcon({ name, size = 20 }: { name: string; size?: number }) {
  if (name === 'hana') return <HanaFace size={size} className="navicon" />;
  if (name === 'feed') return <FeedHorn size={size} className="navicon" />;
  const body = P[name] ?? P.everything ?? '';
  return (
    <svg
      className="navicon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: body }}
    />
  );
}

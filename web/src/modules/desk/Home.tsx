import { useEffect, useState } from 'react';
import { useSession } from '../../session';
import HomeChores from '../chores/HomeChores';
import CommandCenter from './CommandCenter';

export const WIDE = '(min-width: 1100px)';

export function useWide(): boolean {
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia(WIDE).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const on = (): void => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

/** Today. Phones (and kids) get the checklist exactly as before; a grown-up on a desktop gets the command center. */
export default function Home() {
  const { isAdult, viewing, me } = useSession();
  const wide = useWide();
  if (wide && isAdult && viewing?.key === me.member?.key) return <CommandCenter />;
  return <HomeChores />;
}

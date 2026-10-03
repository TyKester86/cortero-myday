import { useEffect, useState } from 'react';
import { useSession } from '../../session';
import HomeChores from '../chores/HomeChores';
import Today from './Today';

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

/** Today. Kids (and a parent looking at a kid) get the chore board; a grown-up gets their own Today. */
export default function Home() {
  const { isAdult, viewing, me } = useSession();
  if (isAdult && viewing?.key === me.member?.key) return <Today />;
  return <HomeChores />;
}

import { useState } from 'react';
import { api } from '../api';
import { useSession } from '../session';

type Role = 'kid' | 'teen' | 'student' | 'solo' | 'adult';

const COPY: Record<Role, { title: string; steps: string[]; cta: string }> = {
  kid: {
    title: 'Hey! This is your MyDay 👋',
    steps: [
      'Today shows your chores. Check one off and you get points right away.',
      'Points buy rewards your parents set up in the Rewards tab.',
      'Every week there are 3 new quests — finish them for bonus points.',
      'Stuck on homework? The Helper helps you figure it out (it won’t just give answers).',
    ],
    cta: 'Let’s go',
  },
  teen: {
    title: 'Welcome to MyDay',
    steps: [
      'Today: your chores and homework. Points turn into rewards.',
      'My money: what you can spend, your savings goals, where it went.',
      'My space: private notes only you can read — not parents, not Hana.',
      'Settings: dark mode and your own color.',
    ],
    cta: 'Got it',
  },
  student: {
    title: 'Welcome — your semester, handled',
    steps: [
      'School: add classes (or connect Google Classroom), assignments, exams, campus support.',
      'Record a lecture → real study notes, flashcards and any homework the professor mentioned.',
      'My day: a morning check-in orders your tasks by the energy you actually have.',
      'The tutor quizzes you from your own lectures — it never does the work for you.',
    ],
    cta: 'Start',
  },
  solo: {
    title: 'Welcome to MyDay',
    steps: [
      'My day: check in each morning; tasks re-order by your energy.',
      'Health: pick a build and get a 52-week plan with meals and protein math.',
      'Money: track bills by hand or link a bank read-only.',
      'Ask Hana to add tasks, groceries or notes for you.',
    ],
    cta: 'Start',
  },
  adult: {
    title: 'Welcome to MyDay',
    steps: [
      'The day loop: morning check-in → do the next thing → evening close-out.',
      'Family: chores, homework and rewards for the kids; wins we celebrate together.',
      'Meals: pick from 120 recipes, build the grocery list, open your store in one tap.',
      'Ask Hana to do things — she’ll ask before deleting anything.',
    ],
    cta: 'Start',
  },
};

export function roleFor(kind: string, age: number | null, track: string | null, householdType: string | undefined): Role {
  if (kind === 'kid') return (age ?? 0) >= 13 ? 'teen' : 'kid';
  if (track === 'student') return 'student';
  if (householdType === 'solo') return 'solo';
  return 'adult';
}

/** Age/role-specific first run, shown once per person. */
export default function FirstRun() {
  const { me } = useSession();
  const [open, setOpen] = useState(me.prefs ? !me.prefs.firstRunDone : false);
  if (!open || !me.member) return null;
  const role = roleFor(me.member.kind, me.member.age, me.xpTrack, me.household?.type);
  const c = COPY[role];
  const done = (): void => {
    setOpen(false);
    void api('/api/me/prefs', 'PATCH', { firstRunDone: true }).catch(() => undefined);
  };
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="firstrun-title" data-testid={`first-run-${role}`}>
      <div className="firstrun">
        <h2 id="firstrun-title">{c.title}</h2>
        <ol>
          {c.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <button className="btn block" onClick={done}>
          {c.cta}
        </button>
      </div>
    </div>
  );
}

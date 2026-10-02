import { useState, type FormEvent } from 'react';
import {
  HOMEWORK_POINTS,
  type HomeworkEntry,
  type HomeworkListResponse,
  type NewHomework,
  type ToggleHomeworkResponse,
} from '@myday/shared';
import { api, useLoad, withMember } from '../../api';
import { useToast } from '../../components/useToast';
import { useConfirm } from '../../components/Confirm';
import { useSession } from '../../session';

/** Kids log their homework; checking it off pays HOMEWORK_POINTS. */
export default function Homework() {
  const { viewing, isAdult } = useSession();
  const key = viewing?.key ?? null;
  const { data, error, setData } = useLoad<HomeworkListResponse>(key ? withMember('/api/homework', key) : null);
  const [assignment, setAssignment] = useState('');
  const [subject, setSubject] = useState('');
  const [due, setDue] = useState('');
  const { toast, show, earned } = useToast();
  const confirm = useConfirm();

  if (error) return <p className="error">{error}</p>;
  if (!data || !key) return <p className="muted">Loading…</p>;

  const add = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const body: NewHomework = { assignment, subject, due: due || null };
    try {
      setData(await api<HomeworkListResponse>(withMember('/api/homework', key), 'POST', body));
      setAssignment('');
      setSubject('');
      setDue('');
    } catch (err) {
      show(err instanceof Error ? err.message : 'Could not save');
    }
  };

  const toggle = async (h: HomeworkEntry, done: boolean): Promise<void> => {
    const r = await api<ToggleHomeworkResponse>(`/api/homework/${h.id}/toggle`, 'POST', { done });
    setData(r.homework);
    if (done) earned(r, h.points);
  };

  const remove = async (h: HomeworkEntry): Promise<void> => {
    if (!(await confirm({ title: `Delete "${h.assignment}"?`, body: 'It comes off the homework list.', confirmLabel: 'Delete', danger: true }))) return;
    setData(await api<HomeworkListResponse>(`/api/homework/${h.id}`, 'DELETE'));
  };

  return (
    <section>
      <h1>{data.member.name}'s homework</h1>
      <p className="muted">Each one is worth {HOMEWORK_POINTS} points when it's done. Nothing hanging = Perfect Week stays alive.</p>

      <form className="card form" onSubmit={(e) => void add(e)}>
        <label>
          Assignment
          <input value={assignment} onChange={(e) => setAssignment(e.target.value)} placeholder="Math worksheet p.42" required />
        </label>
        <label>
          Subject
          <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Math" />
        </label>
        <label>
          Due
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
        <button className="btn">Add homework</button>
      </form>

      {data.open.length === 0 ? (
        <p className="muted">Nothing hanging. 🎉</p>
      ) : (
        <ul className="checklist" data-testid="homework-open">
          {data.open.map((h) => (
            <li key={h.id}>
              <label>
                <input type="checkbox" checked={false} onChange={() => void toggle(h, true)} />
                <span className="name">
                  {h.assignment}
                  {h.subject && <span className="muted"> · {h.subject}</span>}
                  {h.due && <span className={h.overdue ? 'warn' : 'muted'}> · due {h.due}</span>}
                </span>
                <span className="pts">{h.points} pts</span>
                {isAdult && (
                  <button type="button" className="link danger" onClick={() => void remove(h)}>
                    ✕
                  </button>
                )}
              </label>
            </li>
          ))}
        </ul>
      )}

      {data.doneRecently.length > 0 && (
        <>
          <h2>Done lately</h2>
          <ul className="checklist">
            {data.doneRecently.map((h) => (
              <li key={h.id} className="done">
                <label>
                  <input type="checkbox" checked onChange={() => void toggle(h, false)} />
                  <span className="name">{h.assignment}</span>
                  <span className="pts">+{h.points}</span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
      {toast}
    </section>
  );
}

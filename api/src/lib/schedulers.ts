/** Background jobs (push digests, allowance payouts). Registered at server start. */
type Job = { name: string; everyMs: number; run: () => Promise<void> };

const jobs: Job[] = [];

export function registerJob(job: Job): void {
  jobs.push(job);
}

export function startSchedulers(): void {
  if (process.env.SCHEDULERS === 'off') return;
  for (const j of jobs) {
    const tick = (): void => {
      j.run().catch((e: unknown) => console.error(`job ${j.name} failed`, e instanceof Error ? e.message : e));
    };
    setTimeout(tick, 5_000);
    setInterval(tick, j.everyMs).unref();
  }
}

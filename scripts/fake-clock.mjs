// TEST-ONLY preload (node --import): when FAKE_NOW is set, the process clock
// starts at that instant and ticks forward normally. Used by scripts/e2e.mjs
// to walk the server through a week. Never loaded by the production image.
const fake = process.env.FAKE_NOW;
if (fake) {
  const Real = Date;
  const base = Real.parse(fake);
  const start = Real.now();
  const now = () => base + (Real.now() - start);
  globalThis.Date = class extends Real {
    constructor(...args) {
      if (args.length === 0) super(now());
      else super(...args);
    }
    static now() {
      return now();
    }
  };
}

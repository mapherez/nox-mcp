/** Shared by all request-scoped servers belonging to one HTTP endpoint. */
export class ExecutionLimiter {
  #active = 0;
  constructor(readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new TypeError('Invalid execution limit.');
  }
  acquire(): (() => void) | undefined {
    if (this.#active >= this.maximum) return;
    this.#active++;
    let released = false;
    return () => { if (!released) { released = true; this.#active--; } };
  }
}

import {fail, ok} from "./io.js";

export class ForegroundClock {
  #last = null;
  #visible = true;
  #speed = 1;
  setForeground(visible) { this.#visible = visible; this.#last = null; }
  sample(now) {
    if (!Number.isFinite(now) || now < 0) return fail("invalid animation timestamp");
    if (!this.#visible) { this.#last = null; return ok(0); }
    if (this.#last === null) { this.#last = now; return ok(0); }
    if (now < this.#last) return fail("animation clock moved backwards");
    // Simulation seconds = foreground milliseconds / 1000 * current speed.
    const seconds = (now - this.#last) / 1000 * this.#speed;
    this.#last = now;
    return ok(seconds);
  }
  changeSpeed(now, speed) {
    if (![1, 2, 4].includes(speed)) return fail("invalid quest speed");
    const elapsed = this.sample(now);
    if (elapsed.ok) this.#speed = speed;
    return elapsed;
  }
  get speed() { return this.#speed; }
}

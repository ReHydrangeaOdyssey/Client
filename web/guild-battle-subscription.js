import {ok, apiFailure} from "./api-result.js";
import {uint64} from "./api-session.js";

const INITIAL_RETRY_MS = 1000;
const MAX_RETRY_MS = 30000;

function pause(milliseconds, signal) {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, {once: true});
  });
}

export class GuildBattleSubscription {
  #generation = 0;
  #controller = null;
  #listeners = new Set();
  #state = null;

  constructor(api) {
    this.api = api;
    this.unsubscribe = api.session.onChange(() => this.stop());
  }

  get state() { return structuredClone(this.#state); }

  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #publish(value) {
    this.#state = value;
    for (const listener of this.#listeners) listener(this.state);
  }

  start(battleId, {maxFrameBytes}) {
    const id = uint64(battleId, {nonzero: true});
    if (!id.ok) return id;
    const principal = this.api.session.capture();
    if (!principal.ok) return principal;
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
      return apiFailure("stream_memory_budget_required");
    }
    this.stop();
    const controller = new AbortController();
    const generation = this.#generation;
    this.#controller = controller;
    const current = () => !controller.signal.aborted
      && generation === this.#generation && this.api.session.isCurrent(principal.value);
    return ok(this.#run(id.value, maxFrameBytes, controller.signal, current, principal.value));
  }

  async #subscribe(id, maxFrameBytes, signal, current) {
    for await (const result of this.api.subscribe({guild_battle_id: id}, {signal, maxFrameBytes})) {
      if (!current()) return apiFailure("cancelled");
      if (!result.ok) return result;
      if (result.value.guild_battle_id !== id) return apiFailure("stream_battle_mismatch", {sent: true});
      this.#publish({...this.#state, phase: "subscribed", update: result.value});
    }
    return apiFailure("stream_disconnected", {sent: true});
  }

  async #run(id, maxFrameBytes, signal, current, principal) {
    let delay = INITIAL_RETRY_MS;
    let subscriptionEpoch = 0;
    while (current()) {
      subscriptionEpoch++;
      this.#publish({
        phase: "resynchronizing",
        guild_battle_id: id,
        principal_epoch: principal.principal_epoch,
        subscription_epoch: subscriptionEpoch,
        snapshot: null,
        update: null,
      });
      const result = await this.api.call("GetGuildBattleStatus", {guild_battle_id: id}, {signal});
      if (!current()) return;
      let failure = result;
      if (result.ok) {
        this.#publish({...this.#state, phase: "subscribing", snapshot: result.value});
        failure = await this.#subscribe(id, maxFrameBytes, signal, current);
        if (!current()) return;
        if (this.#state.phase === "subscribed") delay = INITIAL_RETRY_MS;
      }
      this.#publish({...this.#state, phase: "disconnected", error: failure.kind, retry_ms: delay});
      await pause(delay, signal);
      // Specified backoff: next delay = min(previous delay * 2, 30 seconds).
      delay = Math.min(delay * 2, MAX_RETRY_MS);
    }
  }

  stop() {
    this.#generation++;
    this.#controller?.abort();
    this.#controller = null;
    this.#publish(null);
  }

  complete() { this.stop(); }

  destroy() {
    this.stop();
    this.unsubscribe();
    this.#listeners.clear();
  }
}

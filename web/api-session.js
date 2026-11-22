import {ok, apiFailure} from "./api-result.js";

const MAX_U64 = (1n << 64n) - 1n;

export function uint64(value, {player = false, nonzero = false} = {}) {
  if (typeof value === "bigint") value = value.toString();
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    return apiFailure("invalid_decimal_id");
  }
  const number = BigInt(value);
  if (number > MAX_U64 || ((player || nonzero) && number === 0n)
      || (player && number === MAX_U64)) {
    return apiFailure("id_out_of_range");
  }
  return ok(value);
}

export class ApiSession {
  #token = null;
  #player = null;
  #epoch = 0;
  #state = "guest";
  #requests = new Set();
  #listeners = new Set();

  get state() {
    return Object.freeze({
      kind: this.#state,
      player_id: this.#player,
      principal_epoch: this.#epoch,
    });
  }

  get connected() { return this.#state === "player"; }

  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #replace(kind, player = null, token = null) {
    // Invalidate before abort: synchronous abort callbacks must see the old epoch as stale.
    this.#epoch++;
    this.#token = null;
    this.#player = null;
    this.#state = "guest";
    for (const controller of this.#requests) controller.abort();
    this.#requests.clear();
    this.#state = kind;
    this.#player = player;
    this.#token = token;
    for (const listener of this.#listeners) listener(this.state);
    return this.#epoch;
  }

  beginAuthentication() { return this.#replace("authenticating"); }

  completeAuthentication(epoch, {access_token, player_id}) {
    if (epoch !== this.#epoch || this.#state !== "authenticating") {
      return apiFailure("stale_authentication");
    }
    const player = uint64(player_id, {player: true});
    if (!player.ok) return player;
    if (typeof access_token !== "string" || !access_token || /[\r\n]/.test(access_token)) {
      return apiFailure("invalid_authentication_response");
    }
    return ok(this.#replace("player", player.value, access_token));
  }

  disconnect() { this.#replace("guest"); }

  capture() {
    if (!this.connected) return apiFailure("server_connection_required");
    return ok(Object.freeze({...this.state, access_token: this.#token}));
  }

  isCurrent(snapshot) {
    return snapshot.principal_epoch === this.#epoch && snapshot.player_id === this.#player;
  }

  request(controller, snapshot) {
    if (!this.isCurrent(snapshot)) return apiFailure("stale_request");
    this.#requests.add(controller);
    return ok(() => this.#requests.delete(controller));
  }
}

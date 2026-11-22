import {ok, apiFailure} from "./api-result.js";

const BLOCKING_OUTCOMES = new Set(["pending", "unknown_outcome", "resynchronizing"]);
const FRIEND_CHANGES = new Set(["SendFriendRequest", "RespondFriendRequest", "RemoveFriend"]);
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_SERVER_ERROR_MIN = 500;

function reconciliationTarget(operation, method, input) {
  const original = operation.input;
  let allowed = [];
  if (original.guild_battle_id !== undefined) {
    allowed = ["GetGuildBattleStatus", "GetGuildBattleResult"];
    if (input.guild_battle_id !== original.guild_battle_id) return apiFailure("battle_target_mismatch");
  } else if (operation.method === "UpdateArenaParty") {
    allowed = ["GetArenaParty"];
  } else if (operation.method === "UpdateGuildBattleParty") {
    allowed = ["GetGuildBattleParty"];
  } else if (FRIEND_CHANGES.has(operation.method)) {
    allowed = ["ListFriends", "ListNotifications"];
  } else if (original.guild_id !== undefined) {
    allowed = ["GetGuildDetail"];
    if (input.guild_id !== original.guild_id) return apiFailure("guild_target_mismatch");
  } else if (operation.method === "CreateGuild") {
    allowed = ["GetInitialGuildStatus"];
  }
  return allowed.includes(method) ? ok(null) : apiFailure("result_query_contract_pending");
}

export class ServerController {
  #cache = new Map();
  #reads = new Map();
  #operations = new Map();
  #history = new Map();
  #listeners = new Set();
  #serial = 0;

  constructor(api) {
    this.api = api;
    this.session = api.session;
    this.unsubscribe = this.session.onChange(() => this.#invalidate());
  }

  #invalidate() {
    for (const request of this.#reads.values()) request.abort();
    this.#reads.clear();
    this.#cache.clear();
    this.#operations.clear();
    this.#history.clear();
    this.#notify();
  }

  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify() { for (const listener of this.#listeners) listener(); }

  cached(key) { return structuredClone(this.#cache.get(key) ?? null); }

  operation(key) { return structuredClone(this.#operations.get(key) ?? null); }

  history() { return structuredClone([...this.#history.values()]); }

  #contract(method, mutating) {
    const found = this.api.codec.method(method);
    if (!found.ok) return found;
    const contract = found.value;
    if (contract.mutating !== mutating || contract.stream || contract.auth !== "bearer") {
      return apiFailure("wrong_rpc_kind");
    }
    return found;
  }

  async read(key, method, input = {}) {
    const contract = this.#contract(method, false);
    if (!contract.ok) return contract;
    const principal = this.session.state;
    const request = new AbortController();
    const epoch = ++this.#serial;
    this.#reads.get(key)?.abort();
    this.#reads.set(key, request);
    try {
      const result = await this.api.call(method, input, {signal: request.signal});
      if (!this.session.isCurrent(principal) || this.#reads.get(key) !== request) {
        return apiFailure("stale_response", {sent: result.sent ?? result.ok});
      }
      if (!result.ok) return result;
      this.#cache.set(key, {
        principal_epoch: principal.principal_epoch,
        player_id: principal.player_id,
        request_epoch: epoch,
        method,
        input: structuredClone(input),
        value: structuredClone(result.value),
      });
      this.#notify();
      return result;
    } finally {
      if (this.#reads.get(key) === request) this.#reads.delete(key);
    }
  }

  async change(key, method, input = {}, options = {}) {
    const contract = this.#contract(method, true);
    if (!contract.ok) return contract;
    const prior = this.#operations.get(key);
    if (prior && BLOCKING_OUTCOMES.has(prior.outcome) && !prior.screen_resynchronized) {
      return apiFailure("operation_blocked");
    }
    const prepared = this.api.prepare(method, input);
    if (!prepared.ok) return prepared;
    const principal = this.session.state;
    const operation = {
      method,
      input: structuredClone(input),
      principal_epoch: principal.principal_epoch,
      player_id: principal.player_id,
      request_epoch: ++this.#serial,
      request_sequence: input.request_sequence ?? null,
      snapshot_epoch: this.#cache.get(key)?.request_epoch ?? null,
      outcome: "pending",
      screen_resynchronized: false,
    };
    if (prior) this.#history.set(prior.request_epoch, structuredClone(prior));
    this.#operations.set(key, operation);
    this.#notify();
    const result = await this.api.call(method, input, options);
    if (!this.session.isCurrent(principal) || this.#operations.get(key) !== operation) {
      return apiFailure("stale_response", {sent: result.sent ?? result.ok});
    }
    if (result.ok) {
      operation.outcome = "confirmed_success";
      operation.value = structuredClone(result.value);
    } else if (!result.sent) {
      this.#operations.delete(key);
    } else {
      // Network/5xx/malformed responses can follow a committed mutation.
      const rejected = result.kind === "http_error"
        && result.status >= HTTP_CLIENT_ERROR_MIN && result.status < HTTP_SERVER_ERROR_MIN;
      operation.outcome = rejected ? "confirmed_rejected" : "unknown_outcome";
      operation.error = {kind: result.kind, status: result.status, detail: result.detail};
    }
    this.#notify();
    return result;
  }

  async resynchronize(key, method, input = {}) {
    const operation = this.#operations.get(key);
    if (!operation || operation.outcome !== "unknown_outcome") return apiFailure("no_uncertain_operation");
    const target = reconciliationTarget(operation, method, input);
    if (!target.ok) return target;
    operation.outcome = "resynchronizing";
    this.#notify();
    const result = await this.read(key, method, input);
    if (this.#operations.get(key) !== operation) return apiFailure("stale_response");
    // A current snapshot restores the screen, not proof that this mutation succeeded.
    operation.outcome = "unknown_outcome";
    operation.screen_resynchronized = result.ok;
    this.#notify();
    return result;
  }

  bindSceneAction(runtime, scene, reference, {method, key, request, onSuccess = () => {}, allowTransition = false}) {
    const found = this.api.codec.method(method);
    if (!found.ok) return found;
    if (found.value.auth !== "bearer" || found.value.stream) return apiFailure("wrong_rpc_kind");
    return runtime.registerBinding(scene, reference, async context => {
      if (!this.session.connected) return apiFailure("server_connection_required");
      const principal = this.session.state;
      const input = request(context);
      const resource = typeof key === "function" ? key(input) : key;
      if (typeof resource !== "string" || !resource) return apiFailure("resource_key_required");
      const result = found.value.mutating
        ? await this.change(resource, method, input)
        : await this.read(resource, method, input);
      if (!result.ok) return result;
      if (!this.session.isCurrent(principal)) return apiFailure("stale_response");
      await onSuccess(result.value);
      if (!this.session.isCurrent(principal)) return apiFailure("stale_response");
      return {...result, allowTransition};
    });
  }

  destroy() {
    this.unsubscribe();
    this.#invalidate();
    this.#listeners.clear();
  }
}

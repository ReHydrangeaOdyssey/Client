import {ok, apiFailure} from "./api-result.js";
import {protobufFrames} from "./protobuf-stream.js";

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const PROTOBUF_CONTENT_TYPE = "application/x-protobuf";

export function httpsOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password
        || url.search || url.hash || url.pathname !== "/") {
      return apiFailure("invalid_api_origin");
    }
    return ok(url.origin);
  } catch {
    return apiFailure("invalid_api_origin");
  }
}

export class PublicApi {
  constructor({origin, session, codec, fetchRpc, timeoutMs, maxResponseBytes}) {
    this.configuration = httpsOrigin(origin);
    this.origin = this.configuration.value;
    this.session = session;
    this.codec = codec;
    this.fetchRpc = fetchRpc;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
      this.configuration = apiFailure("api_limits_required");
    }
  }

  prepare(method, input = {}) {
    if (!this.configuration.ok) return this.configuration;
    const found = this.codec.method(method);
    if (!found.ok) return found;
    const contract = found.value;
    if (contract.auth === "origin") return apiFailure("authentication_origin_required");
    // TODO: enable after the success-response discriminator is specified.
    if (method === "GuildBattleSortie") return apiFailure("response_contract_pending");
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return apiFailure("invalid_request");
    }
    if (Object.hasOwn(input, "access_token") || Object.hasOwn(input, "player_id")) {
      return apiFailure("identity_is_session_owned");
    }
    const captured = contract.auth === "bearer" ? this.session.capture() : ok(this.session.state);
    if (!captured.ok) return captured;
    const snapshot = captured.value;
    if (snapshot.kind === "guest") return apiFailure("explicit_connection_required");
    const payload = {...input};
    if (contract.auth === "bearer") {
      payload.access_token = snapshot.access_token;
      payload.player_id = snapshot.player_id;
    }
    const encoded = this.codec.encode(contract.request, payload);
    if (!encoded.ok) return encoded;
    return ok({method, contract, snapshot, bytes: encoded.value});
  }

  #lifetime(snapshot, signal) {
    const controller = new AbortController();
    const registered = this.session.request(controller, snapshot);
    if (!registered.ok) return registered;
    const abort = () => controller.abort();
    const timer = setTimeout(abort, this.timeoutMs);
    signal?.addEventListener("abort", abort, {once: true});
    if (signal?.aborted) controller.abort();
    return ok({
      controller,
      clearHeaderTimeout: () => clearTimeout(timer),
      dispose: () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        registered.value();
        controller.abort();
      },
    });
  }

  async #open(prepared, lifetime) {
    const {snapshot, method, bytes} = prepared;
    const signal = lifetime.controller.signal;
    if (signal.aborted) return apiFailure("cancelled");
    let response;
    try {
      response = await this.fetchRpc(this.origin, method, bytes, snapshot.access_token ?? null, signal);
    } catch {
      const kind = this.session.isCurrent(snapshot) ? "transport_failed" : "stale_response";
      return apiFailure(kind, {sent: true});
    }
    if (!this.session.isCurrent(snapshot)) return apiFailure("stale_response", {sent: true});
    if (response.status === HTTP_UNAUTHORIZED) {
      this.session.disconnect();
      return apiFailure("unauthenticated", {sent: true, status: response.status});
    }
    const contentType = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
    if (contentType !== PROTOBUF_CONTENT_TYPE) {
      return apiFailure("invalid_response_format", {sent: true, status: response.status});
    }
    if (response.status === HTTP_OK) return ok(response);
    const body = await this.#readBody(response, signal);
    if (!body.ok) return body;
    if (!this.session.isCurrent(snapshot)) return apiFailure("stale_response", {sent: true});
    // Arena errors share protobuf field numbers with common errors; keep their semantics unclassified.
    const decoded = method === "StartArenaBattle" ? null : this.codec.decode("ApiErrorResponse", body.value);
    return apiFailure("http_error", {
      sent: true,
      status: response.status,
      detail: decoded?.ok ? decoded.value : null,
    });
  }

  async #readBody(response, signal) {
    if (!response.body) return apiFailure("missing_response_body", {sent: true, status: response.status});
    const reader = response.body.getReader();
    const parts = [];
    let size = 0;
    try {
      while (true) {
        const {value, done} = await reader.read();
        if (signal.aborted) return apiFailure("cancelled", {sent: true});
        if (done) break;
        size += value.byteLength;
        if (size > this.maxResponseBytes) return apiFailure("response_memory_budget_exceeded", {sent: true});
        parts.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
      return ok(bytes);
    } catch {
      return apiFailure("response_read_failed", {sent: true, status: response.status});
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async call(method, input = {}, {signal} = {}) {
    const prepared = this.prepare(method, input);
    if (!prepared.ok) return prepared;
    if (prepared.value.contract.stream) return apiFailure("stream_method_requires_subscription");
    const lifetime = this.#lifetime(prepared.value.snapshot, signal);
    if (!lifetime.ok) return lifetime;
    try {
      const opened = await this.#open(prepared.value, lifetime.value);
      if (!opened.ok) return opened;
      const body = await this.#readBody(opened.value, lifetime.value.controller.signal);
      if (!body.ok) return body;
      if (!this.session.isCurrent(prepared.value.snapshot)) return apiFailure("stale_response", {sent: true});
      const decoded = this.codec.decode(prepared.value.contract.response, body.value);
      return decoded.ok ? decoded : apiFailure("invalid_response", {sent: true, status: HTTP_OK});
    } finally {
      lifetime.value.dispose();
    }
  }

  async *subscribe(input, {signal, maxFrameBytes}) {
    const prepared = this.prepare("SubscribeGuildBattleUpdates", input);
    if (!prepared.ok) { yield prepared; return; }
    const lifetime = this.#lifetime(prepared.value.snapshot, signal);
    if (!lifetime.ok) { yield lifetime; return; }
    try {
      const opened = await this.#open(prepared.value, lifetime.value);
      if (!opened.ok) { yield opened; return; }
      lifetime.value.clearHeaderTimeout();
      const options = {signal: lifetime.value.controller.signal, maxFrameBytes};
      for await (const frame of protobufFrames(opened.value.body, options)) {
        if (!frame.ok) { yield frame; return; }
        if (!this.session.isCurrent(prepared.value.snapshot)) {
          yield apiFailure("stale_response", {sent: true});
          return;
        }
        const decoded = this.codec.decode("GuildBattleScoreUpdate", frame.value);
        if (!decoded.ok) {
          yield apiFailure("invalid_stream_message", {sent: true});
          return;
        }
        yield decoded;
      }
    } finally {
      lifetime.value.dispose();
    }
  }
}

import {ok, apiFailure} from "./api-result.js";
import {httpsOrigin} from "./public-api.js";

const AUTH_STATE_KEY = "reorsg.authorization.pending";
const AUTH_LIFETIME_MS = 5 * 60 * 1000;
const AUTH_RANDOM_BYTES = 32;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export class AuthorizationFlow {
  constructor(api, {
    clientOrigin,
    storage = {
      getItem: key => sessionStorage.getItem(key),
      setItem: (key, value) => sessionStorage.setItem(key, value),
      removeItem: key => sessionStorage.removeItem(key),
    },
    cryptoProvider = crypto,
    createAuthorizationUrl,
    decodeAuthorizationCode,
    navigate = url => location.assign(url),
    replaceUrl = url => history.replaceState(null, "", url),
    now = () => Date.now(),
  }) {
    this.api = api;
    this.configuration = httpsOrigin(clientOrigin);
    this.clientOrigin = this.configuration.value;
    this.storage = storage;
    this.crypto = cryptoProvider;
    this.createAuthorizationUrl = createAuthorizationUrl;
    this.decodeAuthorizationCode = decodeAuthorizationCode;
    this.navigate = navigate;
    this.replaceUrl = replaceUrl;
    this.now = now;
    this.busy = false;
  }

  async #createPending() {
    const state = base64url(this.crypto.getRandomValues(new Uint8Array(AUTH_RANDOM_BYTES)));
    const verifier = base64url(this.crypto.getRandomValues(new Uint8Array(AUTH_RANDOM_BYTES)));
    // PKCE S256 = base64url(SHA-256(ASCII(verifier))), without padding.
    const hash = await this.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = base64url(new Uint8Array(hash));
    return {state, verifier, challenge};
  }

  #authorizationUrl(pending) {
    const href = this.createAuthorizationUrl({
      authorization_endpoint: this.api.origin + "/auth/authorize",
      redirect_uri: this.clientOrigin + "/auth/callback/",
      state: pending.state,
      code_challenge: pending.challenge,
      code_challenge_method: "S256",
    });
    const url = new URL(href);
    if (url.origin !== this.api.origin || url.pathname !== "/auth/authorize"
        || url.username || url.password || url.hash) {
      return apiFailure("invalid_authorization_destination");
    }
    return ok(url.href);
  }

  async #prepareNavigation(epoch) {
    const pending = await this.#createPending();
    const url = this.#authorizationUrl(pending);
    if (!url.ok) return url;
    if (this.api.session.state.principal_epoch !== epoch) return apiFailure("stale_authentication");
    this.storage.setItem(AUTH_STATE_KEY, JSON.stringify({
      state: pending.state,
      verifier: pending.verifier,
      created_at: this.now(),
      client_origin: this.clientOrigin,
      public_api_origin: this.api.origin,
    }));
    this.navigate(url.value);
    return ok(null);
  }

  async begin() {
    if (!this.configuration.ok) return this.configuration;
    if (this.busy) return apiFailure("authentication_pending");
    // URL serialization belongs to the authorization page's confirmed contract.
    if (typeof this.createAuthorizationUrl !== "function") return apiFailure("authorization_url_contract_pending");
    this.busy = true;
    const epoch = this.api.session.beginAuthentication();
    let result;
    try {
      result = await this.#prepareNavigation(epoch);
    } catch {
      result = apiFailure("authentication_preparation_failed");
    }
    if (!result.ok) {
      try { this.storage.removeItem(AUTH_STATE_KEY); }
      catch { result = apiFailure("authentication_storage_failed"); }
      if (this.api.session.state.principal_epoch === epoch) this.api.session.disconnect();
    }
    this.busy = false;
    return result;
  }

  #consumePending(href) {
    const url = new URL(href);
    if (url.origin !== this.clientOrigin || url.pathname !== "/auth/callback/") return ok(null);
    const codes = url.searchParams.getAll("code");
    const states = url.searchParams.getAll("state");
    this.replaceUrl(this.clientOrigin + "/auth/callback/");
    const saved = this.storage.getItem(AUTH_STATE_KEY);
    this.storage.removeItem(AUTH_STATE_KEY);
    if (!saved || codes.length !== 1 || states.length !== 1) return apiFailure("invalid_authentication_callback");
    if (typeof this.decodeAuthorizationCode !== "function") return apiFailure("authorization_code_contract_pending");
    const pending = JSON.parse(saved);
    const age = this.now() - pending.created_at;
    if (!Number.isFinite(age) || age < 0 || age >= AUTH_LIFETIME_MS || pending.state !== states[0]
        || pending.client_origin !== this.clientOrigin || pending.public_api_origin !== this.api.origin
        || typeof pending.verifier !== "string" || !PKCE_VERIFIER_PATTERN.test(pending.verifier)) {
      return apiFailure("expired_or_mismatched_authentication_state");
    }
    const code = this.decodeAuthorizationCode(codes[0]);
    if (!(code instanceof Uint8Array) || code.length !== AUTH_RANDOM_BYTES) return apiFailure("invalid_authorization_code");
    return ok({
      authorization_code: Array.from(code),
      redirect_uri: this.clientOrigin + "/auth/callback/",
      code_verifier: pending.verifier,
    });
  }

  async consumeCallback(href) {
    if (!this.configuration.ok) return this.configuration;
    if (this.busy) return apiFailure("authentication_pending");
    let request;
    try { request = this.#consumePending(href); }
    catch { return apiFailure("invalid_authentication_callback"); }
    if (!request.ok || request.value === null) return request;
    this.busy = true;
    const epoch = this.api.session.beginAuthentication();
    try {
      const result = await this.api.call("ExchangeAuthorizationCode", request.value);
      if (!result.ok) {
        if (this.api.session.state.principal_epoch === epoch) this.api.session.disconnect();
        return result;
      }
      const accepted = this.api.session.completeAuthentication(epoch, result.value);
      if (!accepted.ok && this.api.session.state.principal_epoch === epoch) this.api.session.disconnect();
      return accepted.ok ? ok(true) : accepted;
    } finally {
      this.busy = false;
    }
  }

  cancel() {
    try { this.storage.removeItem(AUTH_STATE_KEY); }
    catch { return apiFailure("authentication_storage_failed"); }
    finally { this.api.session.disconnect(); }
    return ok(null);
  }
}

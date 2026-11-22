import {ApiSession} from "./api-session.js";
import {PublicApi} from "./public-api.js";
import {ProtobufCodec} from "./protobuf-codec.js";
import {ServerController} from "./server-controller.js";
import {GuildBattleSubscription} from "./guild-battle-subscription.js";
import {AuthorizationFlow} from "./api-authorization.js";

// Construction leaves the session in Guest and never starts a network request.
export class ServerRuntime {
  constructor(wasm, config = {}, authorization = {}) {
    this.session = new ApiSession();
    this.api = new PublicApi({
      origin: config.public_api_origin,
      session: this.session,
      codec: new ProtobufCodec(wasm),
      fetchRpc: (origin, method, bytes, token, signal) =>
        wasm.fetch_public_rpc(origin, method, bytes, token, signal),
      timeoutMs: config.api_timeout_ms,
      maxResponseBytes: config.api_max_response_bytes,
    });
    this.controller = new ServerController(this.api);
    this.subscription = new GuildBattleSubscription(this.api);
    this.maxFrameBytes = config.api_max_frame_bytes;
    this.authorization = new AuthorizationFlow(this.api, {
      ...authorization, clientOrigin: config.client_origin,
    });
  }

  subscribe(battleId) {
    return this.subscription.start(battleId, {maxFrameBytes: this.maxFrameBytes});
  }

  disconnect() { return this.authorization.cancel(); }

  destroy() {
    this.session.disconnect();
    this.subscription.destroy();
    this.controller.destroy();
  }
}

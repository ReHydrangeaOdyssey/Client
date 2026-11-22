import {ok, apiFailure} from "./api-result.js";

// Explicit allowlists keep a newly added RPC disabled until its policy is reviewed.
const READ_METHODS = new Set([
  "GetAdditionalAuthorizationConfig", "GetGuildBattleStatus", "GetGuildFacilityUpgradeCost",
  "SearchGuilds", "SearchPlayers", "ListGuildJoinApplications", "ListGuildInvitations",
  "GetGuildDetail", "GetMyGuildBattle", "GetGuildBattleResult", "GetArenaParty",
  "GetGuildBattleParty", "ListMyGuildBattleReplays", "GetMyGuildBattleReplay",
  "GetInitialGuildStatus", "GetPlayerProfile", "ListNotifications", "ListFriends",
]);
const CHANGE_METHODS = new Set([
  "CreateGuild", "UpdateGuildLeadership", "ApplyGuildJoin", "ApproveGuildJoinApplication",
  "SendGuildInvitation", "AcceptGuildInvitation", "LeaveGuild", "UpdateArenaParty",
  "StartArenaBattle", "UpdateGuildBattleParty", "JoinGuildBattle", "GuildBattleSortie",
  "UseTactics", "UseItem", "UseTavernRecovery", "StartHeal", "CancelHeal", "CompleteHeal",
  "StartRevive", "CancelRevive", "CompleteRevive", "ExchangeAuthorizationCode",
  "UpgradeGuildFacility", "UpdateGuildBattleStartTimes", "SendFriendRequest",
  "RespondFriendRequest", "RemoveFriend",
]);
const ORIGIN_METHODS = new Set([
  "CreateAccount", "Login", "RefreshAccessToken", "Logout", "IssueAuthorizationCode",
]);
const MESSAGE_ALIASES = {
  StartArenaBattle: ["ArenaBattleRequest", "ArenaBattleResponse"],
  JoinGuildBattle: ["JoinGuildBattleRequest", "GuildBattleJoinResponse"],
  SubscribeGuildBattleUpdates: ["SubscribeGuildBattleUpdatesRequest", "GuildBattleScoreUpdate"],
  GuildBattleSortie: ["GuildBattleSortieRequest", null],
};

export function publicMethod(method) {
  const stream = method === "SubscribeGuildBattleUpdates";
  if (!READ_METHODS.has(method) && !CHANGE_METHODS.has(method)
      && !ORIGIN_METHODS.has(method) && !stream) return apiFailure("unknown_public_method");
  const [request, response] = Object.hasOwn(MESSAGE_ALIASES, method)
    ? MESSAGE_ALIASES[method] : [method + "Request", method + "Response"];
  const auth = ORIGIN_METHODS.has(method) ? "origin"
    : method === "GetAdditionalAuthorizationConfig" || method === "ExchangeAuthorizationCode"
      ? "public" : "bearer";
  return ok({request, response, auth, mutating: CHANGE_METHODS.has(method), stream});
}

export class ProtobufCodec {
  constructor(wasm) { this.wasm = wasm; }
  method(name) { return publicMethod(name); }
  encode(name, value) {
    try {
      const input = JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);
      const result = JSON.parse(this.wasm.encode_public_request(name, input));
      return result.ok ? ok(Uint8Array.from(result.value)) : apiFailure("invalid_api_request");
    } catch {
      return apiFailure("invalid_api_request");
    }
  }
  decode(name, bytes) {
    try {
      const result = JSON.parse(this.wasm.decode_public_response(name, bytes));
      return result.ok ? result : apiFailure("invalid_protobuf");
    } catch {
      return apiFailure("invalid_protobuf");
    }
  }
}

export {ok} from "./io.js";

export function apiFailure(kind, {sent = false, status = null, detail = null} = {}) {
  return {ok: false, error: kind, kind, sent, status, detail};
}

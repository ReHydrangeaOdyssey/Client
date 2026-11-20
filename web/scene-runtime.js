import {boundary, digest, fail, fetchBytes, ok} from "./io.js";

const NAME = /^[a-z][a-z0-9_]*$/;
export class SceneRuntime {
  #wasm;
  #adapters;
  #index = new Map();
  #serial = 0;
  #pending = null;
  #active = null;
  #activating = false;
  #lastActivation = 0;
  #bindings = new Map();
  #conditions = new Map();
  constructor(wasm, adapters) { this.#wasm = wasm; this.#adapters = adapters; }
  get loading() { return this.#pending !== null; }
  get active() { return this.#active; }
  async setIndex(index) {
    if (this.loading) return fail("Scene transition pending");
    if (!Array.isArray(index.scenes)) return fail("invalid Scene index");
    const names = new Set();
    const ids = new Set();
    const staged = new Map();
    for (const entry of index.scenes) {
      if (!NAME.test(entry.scene_name) || names.has(entry.scene_name)) return fail("invalid Scene name");
      const hashed = await boundary(() => digest(new TextEncoder().encode(entry.scene_name)));
      if (!hashed.ok) return hashed;
      // SceneID = the first 48 bits of the name SHA-256, interpreted big endian.
      const id = Number.parseInt(hashed.value.slice(0, 12), 16);
      if (!id || id !== entry.scene_id || ids.has(id)) return fail("invalid SceneID");
      names.add(entry.scene_name);
      ids.add(id);
      staged.set(entry.scene_name, id);
    }
    this.#index = staged;
    return ok(null);
  }
  registerBinding(scene, reference, handler) {
    if (!scene.assets.ui.button[reference.replace(/^ui\.button\./, "")]
        || !reference.startsWith("ui.button.") || typeof handler !== "function")
      return fail("実Sceneに存在するButtonだけを登録できます");
    this.#bindings.set(scene.scene + "/" + reference, handler);
    return ok(null);
  }
  registerCondition(name, evaluate) {
    if (!/^[A-Za-z_]{1,128}$/.test(name) || typeof evaluate !== "function")
      return fail("invalid condition binding");
    this.#conditions.set(name, evaluate);
    return ok(null);
  }
  async transition(name, version, generation) {
    if (this.loading) return fail("画面の読み込み中です");
    if (!this.#index.has(name)) return fail("遷移先のSceneが登録されていません");
    if (!Number.isSafeInteger(generation) || generation < 0 || !Number.isSafeInteger(this.#serial + 1))
      return fail("invalid Scene generation");
    const ticket = {request: ++this.#serial, version, generation, name};
    this.#pending = ticket;
    this.#adapters.setLoading(true);
    const prepared = await boundary(() => this.#prepare(ticket));
    if (this.#pending !== ticket) return fail("stale Scene completion");
    const result = prepared.ok ? prepared.value : prepared;
    this.#pending = null;
    this.#adapters.setLoading(false);
    return result;
  }
  async #prepare(ticket) {
    const ready = await this.#adapters.checkEntry(ticket.name);
    if (!ready.ok) return ready;
    const bytes = await fetchBytes("scene_assets/" + ticket.name + ".json");
    if (!bytes.ok) return bytes;
    const result = JSON.parse(this.#wasm.validate_scene(new TextDecoder().decode(bytes.value), ticket.name));
    if (!result.ok) return result;
    const scene = result.value;
    const prepared = await this.#adapters.prepare(scene, ticket);
    if (!prepared.ok) return prepared;
    if (this.#pending !== ticket || !this.#adapters.isCurrent(ticket)) {
      await this.#adapters.dispose(prepared.value);
      return fail("Scene準備中に配布データが変更されました");
    }
    if (!scene.critical.every(reference => prepared.value.ready.has(reference))) {
      await this.#adapters.dispose(prepared.value);
      return fail("Sceneの必須素材が準備できていません");
    }
    // commit is a synchronous display/audio swap; all I/O belongs to prepare.
    const committed = this.#adapters.commit(prepared.value, this.#active);
    if (typeof committed?.ok !== "boolean") return fail("invalid Scene commit adapter");
    if (!committed.ok) { await this.#adapters.dispose(prepared.value); return committed; }
    this.#active = scene;
    return ok(scene);
  }
  async activate(reference, context) {
    if (this.#activating || !Number.isSafeInteger(context.activationId)
        || context.activationId <= this.#lastActivation) return fail("重複したScene操作です");
    this.#lastActivation = context.activationId;
    this.#activating = true;
    try {
      const result = await boundary(() => this.#activate(reference, context));
      return result.ok ? result.value : result;
    } finally { this.#activating = false; }
  }
  async #activate(reference, context) {
    if (this.loading || !this.#active) return fail("Scene入力を受け付けられません");
    const scene = this.#active;
    const name = reference.startsWith("ui.button.") ? reference.slice("ui.button.".length) : null;
    const button = scene.assets.ui.button[name];
    if (!button) return fail("unknown Scene button");
    const events = await this.#adapters.applyEvents(button.events ?? []);
    if (!events.ok) return events;
    const binding = this.#bindings.get(scene.scene + "/" + reference);
    if (binding) {
      const action = await boundary(() => binding(context));
      if (!action.ok) return action;
      if (!action.value.ok) return action.value;
      if (button.transition && action.value.allowTransition !== true)
        return fail("Controllerが画面遷移を許可していません");
    }
    if (!button.transition) return ok(null);
    const values = {};
    for (const route of button.transition.routes ?? []) {
      const evaluate = this.#conditions.get(route.condition);
      if (!evaluate) return fail("未結線の遷移条件: " + route.condition);
      const evaluated = await boundary(() => evaluate(context));
      if (!evaluated.ok) return evaluated;
      if (typeof evaluated.value !== "boolean") return fail("遷移条件がbool値ではありません");
      values[route.condition] = evaluated.value;
    }
    const destination = JSON.parse(this.#wasm.resolve_transition(JSON.stringify(button.transition), JSON.stringify(values)));
    if (!destination.ok || destination.value === null) return destination;
    return this.transition(destination.value, context.version, context.generation);
  }
}

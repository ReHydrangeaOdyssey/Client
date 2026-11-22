import {SceneRuntime} from "./scene-runtime.js";
import {fail, ok} from "./io.js";

export function corruptData(type, path, diagnostic) {
  const error = type === "quest"
    ? "クエストデータが破損しています。データを再ダウンロードしてください。"
    : "ゲームデータが破損しています。データを再ダウンロードしてください。";
  return {...fail(error), kind: "corrupt", dataType: type, path, diagnostic};
}

export function validateQuest(wasm, text, enemyIds, itemIds, path) {
  const result = JSON.parse(wasm.validate_quest(text, JSON.stringify(enemyIds), JSON.stringify(itemIds)));
  return result.ok ? result : corruptData("quest", path, result.error);
}

export function validateSkills(wasm, text, path) {
  const result = JSON.parse(wasm.validate_skill_sources(text));
  return result.ok ? result : corruptData("skill", path, result.error);
}

export async function validateStaticSources(wasm, files) {
  const decoded = new Map();
  for (const [path, bytes] of files) {
    if (!path.endsWith(".json") && !path.endsWith(".webmanifest")) continue;
    let text;
    try {
      text = new TextDecoder("utf-8", {fatal: true}).decode(bytes);
      decoded.set(path, JSON.parse(text));
    } catch {
      return corruptData("static", path, "invalid_json_or_encoding");
    }
    if (path.startsWith("assets/scene/") && path !== "assets/scene/scene_index.json") {
      const name = path.slice("assets/scene/".length, -".json".length);
      const scene = JSON.parse(wasm.validate_scene(text, name));
      if (!scene.ok) return corruptData("scene", path, scene.error);
    }
  }
  const config = decoded.get("runtime_config.json");
  const index = decoded.get("assets/scene/scene_index.json");
  if (!config || !index || !Array.isArray(index.scenes)
      || index.scenes.some(entry => !entry || typeof entry.scene_name !== "string"))
    return corruptData("static", "runtime_config.json", "missing_config_or_index");
  const validated = await new SceneRuntime(wasm, {}).setIndex(index);
  if (!validated.ok) return corruptData("scene", "assets/scene/scene_index.json", validated.error);
  const sceneFiles = [...files.keys()].filter(path =>
    path.startsWith("assets/scene/") && path !== "assets/scene/scene_index.json");
  if (sceneFiles.length !== index.scenes.length
      || index.scenes.some(entry => !files.has("assets/scene/" + entry.scene_name + ".json"))
      || (config.entry_scene !== null && !index.scenes.some(entry => entry.scene_name === config.entry_scene)))
    return corruptData("scene", "runtime_config.json", "unresolved_scene");
  return ok(null);
}

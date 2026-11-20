import {boundary, fetchBytes, fail} from "./io.js";
import {prepareDistribution} from "./distribution.js";

const message = document.querySelector("#message");
const retry = document.querySelector("#retry");
let starting = false;

async function initialize() {
  if (starting) return;
  starting = true;
  retry.hidden = true;
  message.textContent = "起動用データを確認しています…";
  const result = await boundary(start);
  const outcome = result.ok ? result.value : result;
  if (!outcome.ok) {
    message.textContent = outcome.error;
    retry.hidden = false;
  }
  starting = false;
}

async function start() {
  if (!window.isSecureContext || !navigator.storage?.getDirectory || !navigator.serviceWorker)
    return fail("HTTPSとオフライン保存に対応したブラウザーで開いてください。");
  const distribution = await prepareDistribution();
  if (!distribution.ok) return distribution;
  const configBytes = await fetchBytes("runtime_config.json");
  if (!configBytes.ok) return configBytes;
  const config = JSON.parse(new TextDecoder().decode(configBytes.value));
  const wasm = await import("./pkg/reorsg_client.js");
  await wasm.default();
  if (!config.entry_scene)
    return fail("シーンデータが未設定です。現仕様のシーン・素材データが揃うまでゲームを開始できません。");
  const bytes = await fetchBytes("scene_assets/" + config.entry_scene + ".json");
  if (!bytes.ok) return bytes;
  const scene = JSON.parse(wasm.validate_scene(new TextDecoder().decode(bytes.value), config.entry_scene));
  if (!scene.ok) return fail("シーンデータを読み込めません: " + scene.error);
  return fail("シーンの読込みは完了しました。素材辞書・描画Adapter・業務ボタンの接続が未準備のため、ゲーム開始を保留しています。");
}

retry.addEventListener("click", initialize);
initialize();

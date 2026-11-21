import {AudioSystem} from "./audio-system.js";
import {SceneRuntime} from "./scene-runtime.js";
import {SceneView} from "./scene-view.js";
import {SceneAssets} from "./scene-assets.js";
import {WebGLRenderer} from "./webgl-renderer.js";
import {validateStaticSources} from "./data-validation.js";
import {boundary, fetchBytes, fail, ok} from "./io.js";
import {prepareDistribution} from "./distribution.js";

const message = document.querySelector("#message");
const retry = document.querySelector("#retry");
let starting = false;
let activeView = null;
let activeAudio = null;

async function initialize(networkOnly = false) {
  if (starting) return;
  starting = true;
  retry.hidden = true;
  message.textContent = "起動用データを確認しています…";
  const result = await boundary(() => start(networkOnly));
  const outcome = result.ok ? result.value : result;
  if (!outcome.ok) {
    message.textContent = outcome.error;
    retry.textContent = outcome.kind === "corrupt"
      ? "データを再ダウンロード" : "再試行";
    retry.hidden = false;
  }
  starting = false;
}

async function start(networkOnly) {
  if (!window.isSecureContext || !navigator.storage?.getDirectory || !navigator.serviceWorker)
    return fail("HTTPSとオフライン保存に対応したブラウザーで開いてください。");
  const wasm = await import("./pkg/reorsg_client.js");
  await wasm.default();
  const distribution = await prepareDistribution({networkOnly,
    validateCandidate: files => validateStaticSources(wasm, files)});
  if (!distribution.ok) return distribution;
  const configBytes = await fetchBytes("runtime_config.json");
  if (!configBytes.ok) return configBytes;
  const config = JSON.parse(new TextDecoder().decode(configBytes.value));
  if (!config.entry_scene)
    return fail("シーンデータが未設定です。現仕様のシーン・素材データが揃うまでゲームを開始できません。");
  const indexBytes = await fetchBytes("assets/scene/scene_index.json");
  if (!indexBytes.ok) return indexBytes;
  activeView?.destroy();
  activeAudio?.destroy();
  const showError = text => {
    const error = document.querySelector("#error");
    error.textContent = text; error.hidden = false;
  };
  const renderer = new WebGLRenderer(document.querySelector("#scene"), showError);
  const audio = new AudioSystem(showError);
  activeAudio = audio;
  const view = new SceneView(renderer, new SceneAssets({audioDecoder:(data,assets)=>audio.prepare(data,assets)}), {
    audio,
    setLoading: value => { document.querySelector("#loading").hidden = !value; },
    onError: showError,
    isCurrent: ticket => ticket.version === distribution.value.version,
  });
  activeView = view;
  const runtime = new SceneRuntime(wasm, view);
  view.activate = (reference, activationId) => runtime.activate(reference, {
    activationId, version: distribution.value.version, generation: 0,
  });
  const indexed = await runtime.setIndex(JSON.parse(new TextDecoder().decode(indexBytes.value)));
  if (!indexed.ok) { view.destroy(); activeView = null; return indexed; }
  const entered = await runtime.transition(config.entry_scene, distribution.value.version, 0);
  if (!entered.ok) { view.destroy(); activeView = null; return entered; }
  document.querySelector("#startup").hidden = true;
  return ok(runtime);

}

retry.addEventListener("click", () => initialize(true));
initialize();

import {corruptData} from "./data-validation.js";
import {boundary, digest, fail, fetchBytes, localPath, ok, opfsDirectory, writeFile} from "./io.js";

export async function prepareDistribution({networkOnly = false, validateCandidate} = {}) {
  const downloaded = await fetchBytes("distribution.json", {networkOnly});
  if (!downloaded.ok) return downloaded;
  const parsed = await boundary(() => JSON.parse(new TextDecoder().decode(downloaded.value)));
  if (!parsed.ok) return corruptData("manifest", "distribution.json", "invalid_json");
  const manifest = parsed.value;
  if (!manifest || !/^[a-f0-9]{64}$/.test(manifest.version) || !Array.isArray(manifest.files)
      || manifest.files.length === 0) return corruptData("manifest", "distribution.json", "invalid_manifest");
  const paths = new Set();
  for (const entry of manifest.files) {
    if (!entry || !localPath(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256) || paths.has(entry.path)
        || !Number.isSafeInteger(entry.size_bytes) || entry.size_bytes < 0)
      return corruptData("manifest", "distribution.json", "invalid_reference_or_size");
    paths.add(entry.path);
  }
  const calculated = await boundary(() => digest(new TextEncoder().encode(JSON.stringify(manifest.files))));
  if (!calculated.ok || calculated.value !== manifest.version) return corruptData("manifest", "distribution.json", "hash_mismatch");
  const result = await boundary(async () => {
    const control = await caches.open("reorsg-active");
    const active = await control.match(new URL("./active", location.href));
    if (active && await active.text() !== "reorsg-static-" + manifest.version)
      return fail("異なるVersionへの更新は未対応です。現在の保存データを保持しました。");
    const staged = new Map();
    for (const entry of manifest.files) {
      const bytes = await fetchBytes(entry.path, {networkOnly});
      if (!bytes.ok) return bytes;
      if (bytes.value.byteLength !== entry.size_bytes || await digest(bytes.value) !== entry.sha256) return corruptData("static", entry.path, "size_or_hash_mismatch");
      staged.set(entry.path, bytes.value);
    }
    if (typeof validateCandidate !== "function") return fail("Candidate schema validator is required");
    const validated = await validateCandidate(staged);
    if (!validated.ok) return validated;
    // No existing file is touched until every candidate byte sequence has been verified.
    const cache = await caches.open("reorsg-static-" + manifest.version);
    const directory = await opfsDirectory(["game"], true);
    for (const entry of manifest.files) {
      const bytes = {value: staged.get(entry.path)};
      const parts = entry.path.split("/");
      let parent = directory;
      for (const part of parts.slice(0, -1))
        parent = await parent.getDirectoryHandle(part, {create: true});
      await writeFile(parent, parts.at(-1), bytes.value);
      const url = new URL("./" + entry.path, location.href);
      const type = entry.path.endsWith(".wasm") ? "application/wasm"
        : entry.path.endsWith(".js") ? "text/javascript"
        : entry.path.endsWith(".css") ? "text/css"
        : entry.path.endsWith(".html") ? "text/html; charset=utf-8"
        : entry.path.endsWith(".svg") ? "image/svg+xml" : "application/json";
      await cache.put(url, new Response(bytes.value, {headers: {"Content-Type": type}}));
    }
    // The completion marker is published only after the entire immutable set is verified.
    await cache.put(new URL("./distribution.json", location.href), new Response(downloaded.value));
    const registration = await navigator.serviceWorker.register("./sw.js", {scope: "./"});
    await navigator.serviceWorker.ready;
    const worker = registration.active;
    if (!worker) return fail("オフライン起動を有効にできませんでした");
    const activated = await new Promise(resolve => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => resolve(false), 10000);
      channel.port1.onmessage = event => {
        clearTimeout(timeout);
        channel.port1.close();
        resolve(event.data?.ok === true);
      };
      worker.postMessage({type: "activate", version: manifest.version}, [channel.port2]);
    });
    return activated ? ok(manifest) : fail("オフライン保存の確定に失敗しました");
  });
  return result.ok ? result.value : result;
}

import {boundary, digest, fail, fetchBytes, localPath, ok, opfsDirectory, writeFile} from "./io.js";

export async function prepareDistribution() {
  const downloaded = await fetchBytes("distribution.json");
  if (!downloaded.ok) return downloaded;
  const parsed = await boundary(() => JSON.parse(new TextDecoder().decode(downloaded.value)));
  if (!parsed.ok) return parsed;
  const manifest = parsed.value;
  if (!/^[a-f0-9]{64}$/.test(manifest.version) || !Array.isArray(manifest.files)
      || manifest.files.length === 0) return fail("配布一覧が不正です");
  const paths = new Set();
  for (const entry of manifest.files) {
    if (!localPath(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256) || paths.has(entry.path))
      return fail("配布一覧の参照が不正です");
    paths.add(entry.path);
  }
  const calculated = await boundary(() => digest(new TextEncoder().encode(JSON.stringify(manifest.files))));
  if (!calculated.ok || calculated.value !== manifest.version) return fail("配布一覧の検証に失敗しました");
  const result = await boundary(async () => {
    const control = await caches.open("reorsg-active");
    const active = await control.match(new URL("./active", location.href));
    if (active && await active.text() !== "reorsg-static-" + manifest.version)
      return fail("異なるVersionへの更新は未対応です。現在の保存データを保持しました。");
    const cache = await caches.open("reorsg-static-" + manifest.version);
    const directory = await opfsDirectory(["game"], true);
    for (const entry of manifest.files) {
      const bytes = await fetchBytes(entry.path);
      if (!bytes.ok) return bytes;
      if (await digest(bytes.value) !== entry.sha256) return fail("配布ファイルの検証に失敗しました: " + entry.path);
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

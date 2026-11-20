export const ok = value => ({ok: true, value});
export const fail = error => ({ok: false, error: String(error)});
export async function boundary(work) {
  try { return ok(await work()); } catch (error) { return fail(error?.message ?? error); }
}
export async function digest(bytes) {
  const result = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, "0")).join("");
}
export function localPath(path) {
  return typeof path === "string" && path.length > 0 && !path.includes("\\")
    && path.split("/").every(part => part && part !== "." && part !== "..")
    && !/[?#:%]/.test(path) && !path.startsWith("/");
}
export async function fetchBytes(path) {
  if (!localPath(path)) return fail("invalid distribution path");
  const response = await boundary(() => fetch("./" + path, {cache: "no-store"}));
  if (!response.ok) return response;
  if (!response.value.ok) return fail("配布データを取得できません: " + path);
  return boundary(() => response.value.arrayBuffer());
}
export async function opfsDirectory(parts, create = false) {
  let directory = await navigator.storage.getDirectory();
  for (const part of parts) directory = await directory.getDirectoryHandle(part, {create});
  return directory;
}
export async function writeFile(directory, name, bytes) {
  const handle = await directory.getFileHandle(name, {create: true});
  const writer = await handle.createWritable();
  try {
    await writer.write(bytes);
    await writer.close();
  } catch (error) {
    try { await writer.abort(); } catch { /* Browser may already have aborted the stream. */ }
    throw error;
  }
}

import {ok, apiFailure} from "./api-result.js";

const VARINT_PAYLOAD_BITS = 7n;
const VARINT_PAYLOAD_MASK = 0x7f;
const VARINT_CONTINUATION = 0x80;
const MAX_VARINT_BYTES = 10;
const LAST_U64_VARINT_BYTE = 1;

class FrameAccumulator {
  constructor(maxFrameBytes) {
    this.maxFrameBytes = BigInt(maxFrameBytes);
    this.reset();
  }

  reset() {
    this.length = 0n;
    this.shift = 0n;
    this.prefixBytes = 0;
    this.frame = null;
    this.offset = 0;
  }

  prefix(byte) {
    this.prefixBytes++;
    if (this.prefixBytes > MAX_VARINT_BYTES
        || (this.prefixBytes === MAX_VARINT_BYTES && byte > LAST_U64_VARINT_BYTE)) {
      return apiFailure("invalid_protobuf_length", {sent: true});
    }
    // Varint length = sum((byte & 0x7f) << (7 * byte_index)); retain integer precision.
    this.length |= BigInt(byte & VARINT_PAYLOAD_MASK) << this.shift;
    if (this.length > this.maxFrameBytes) return apiFailure("stream_memory_budget_exceeded", {sent: true});
    if (byte & VARINT_CONTINUATION) {
      this.shift += VARINT_PAYLOAD_BITS;
      return ok(null);
    }
    if (this.prefixBytes > 1 && byte === 0) return apiFailure("noncanonical_protobuf_length", {sent: true});
    this.frame = new Uint8Array(Number(this.length));
    return ok(null);
  }
}

// Memory budget is explicit and client-local, not a new server-side payload limit.
export async function* protobufFrames(body, {signal, maxFrameBytes}) {
  if (!body?.getReader || !Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
    yield apiFailure("invalid_stream_configuration");
    return;
  }
  const reader = body.getReader();
  const state = new FrameAccumulator(maxFrameBytes);
  const abort = () => { reader.cancel().catch(() => {}); };
  let completed = false;
  signal?.addEventListener("abort", abort, {once: true});
  try {
    while (!signal?.aborted) {
      const part = await reader.read();
      if (signal?.aborted) break;
      if (part.done) { completed = true; break; }
      if (!(part.value instanceof Uint8Array)) {
        yield apiFailure("invalid_stream_chunk", {sent: true});
        return;
      }
      for (let at = 0; at < part.value.length;) {
        if (state.frame === null) {
          const parsed = state.prefix(part.value[at++]);
          if (!parsed.ok) { yield parsed; return; }
        } else {
          const count = Math.min(state.frame.length - state.offset, part.value.length - at);
          state.frame.set(part.value.subarray(at, at + count), state.offset);
          state.offset += count;
          at += count;
        }
        if (state.frame !== null && state.offset === state.frame.length) {
          yield ok(state.frame);
          state.reset();
        }
      }
    }
    if (signal?.aborted) yield apiFailure("cancelled", {sent: true});
    else if (state.frame !== null || state.prefixBytes) yield apiFailure("truncated_protobuf_stream", {sent: true});
  } catch {
    yield apiFailure("stream_read_failed", {sent: true});
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

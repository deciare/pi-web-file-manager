import test from "node:test";
import assert from "node:assert/strict";
import { CHANNEL_DATA_JSON_MAX_BYTES, CONTENT_CHUNK_BYTES } from "../src/shared/protocol.ts";
import { chunkBytes, toBase64 } from "../src/browser/client.ts";

/**
 * The host bounds one channel data payload by its JSON size, and a chunk is
 * only useful if the frame carrying a full chunk fits. 48 KiB did not: base64
 * filled the whole 64 KiB on its own, and every upload failed with "channel
 * data exceeds the 65536 byte limit" before a single byte was written.
 */
test("a full chunk fits the host's channel data bound once encoded", () => {
  const chunk = new Uint8Array(CONTENT_CHUNK_BYTES).fill(0xff);
  const frame = JSON.stringify({ type: "chunk", data: toBase64(chunk) });
  assert.ok(
    Buffer.byteLength(frame, "utf8") <= CHANNEL_DATA_JSON_MAX_BYTES,
    `encoded frame is ${String(Buffer.byteLength(frame, "utf8"))} bytes, over the ${String(CHANNEL_DATA_JSON_MAX_BYTES)} byte bound`,
  );
});

test("base64 alone would not fit at the size the bound suggests", () => {
  // Guards the reasoning, not the arithmetic: a chunk of the bound in bytes
  // cannot be carried, so the constant has to stay below it by the codec's ratio.
  const naive = toBase64(new Uint8Array(CHANNEL_DATA_JSON_MAX_BYTES));
  assert.ok(naive.length > CHANNEL_DATA_JSON_MAX_BYTES);
});

test("a save splits the document into frames the host will accept", async () => {
  // A save used to hand the whole document to the channel as one frame, so any
  // document over ~48 KiB failed with "channel data exceeds the 65536 byte
  // limit" — the same bound an upload meets, on a path that never chunked.
  const text = "const value = 1; // ✓ a line\n".repeat(9000);
  const chunks: Uint8Array[] = [];
  for await (const chunk of chunkBytes(new TextEncoder().encode(text), CONTENT_CHUNK_BYTES)) chunks.push(chunk);
  assert.ok(chunks.length > 1, "a document this size should not travel in one frame");
  for (const chunk of chunks) {
    const frame = JSON.stringify({ type: "chunk", data: toBase64(chunk) });
    assert.ok(Buffer.byteLength(frame, "utf8") <= CHANNEL_DATA_JSON_MAX_BYTES);
  }
  // Bytes first, text second: a chunk boundary can fall inside a character.
  const joined = new TextDecoder().decode(Uint8Array.from(chunks.flatMap((chunk) => [...chunk])));
  assert.equal(joined, text);
});

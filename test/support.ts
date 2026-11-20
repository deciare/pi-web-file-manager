import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json, ChannelOpenContext } from "../src/server/pluginApi.ts";

export interface Sandbox {
  readonly root: string;
  path(...segments: string[]): string;
  cleanup(): Promise<void>;
}

export async function sandbox(prefix = "fm-test-"): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return {
    root,
    path: (...segments) => join(root, ...segments),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export function base64(text: string | Uint8Array): string {
  return Buffer.from(text).toString("base64");
}

export function decode(base64Value: string): string {
  return Buffer.from(base64Value, "base64").toString("utf8");
}

export interface ChannelHarness {
  readonly frames: Json[];
  readonly context: ChannelOpenContext;
  readonly controller: AbortController;
}

export function channelHarness(operation: string, input: Json): ChannelHarness {
  const frames: Json[] = [];
  const controller = new AbortController();
  return {
    frames,
    controller,
    context: {
      operation,
      input,
      signal: controller.signal,
      send: (data) => { frames.push(data); },
    },
  };
}

export async function collect(body: Uint8Array | AsyncIterable<Uint8Array>): Promise<Buffer> {
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

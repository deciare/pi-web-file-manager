import type { Json, RequestContext, ChannelOpenContext, ResourceContext, ServerPluginDefinition } from "./pluginApi.ts";
import type { DeleteRequest, FileManagerOperation, RenameRequest } from "../shared/protocol.ts";
import { errorCode, errorMessage, fail, ok } from "../shared/protocol.ts";
import { Failure, invalid } from "./failure.ts";
import {
  deletePath, listDirectory, makeDirectory, planDelete, readTextFile, renamePath, statPath,
} from "./fsOps.ts";
import { openSaveChannel, openUploadChannel } from "./content.ts";
import { downloadResource, zipResource } from "./resources.ts";
import { startTempSweeper } from "./temps.ts";

/**
 * Request dispatch. Every handler validates its own input, because every input
 * arrives from a browser and none of it can be trusted to be shaped as sent.
 *
 * Failures come back as a `{ ok: false }` envelope rather than a thrown error:
 * the host turns a throw into a transport-level failure, which the panel could
 * not tell apart from a lost connection.
 */

type Handler = (input: unknown) => Promise<unknown>;

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw invalid("Request input must be an object");
  return input as Record<string, unknown>;
}

const REQUEST_HANDLERS: Readonly<Record<FileManagerOperation, Handler>> = {
  list: (input) => listDirectory(asRecord(input)),
  stat: (input) => statPath(asRecord(input)),
  "read.text": (input) => readTextFile(asRecord(input)),
  mkdir: (input) => makeDirectory(asRecord(input)),
  rename: (input) => renamePath(asRecord(input) as unknown as RenameRequest),
  "delete.plan": (input) => planDelete(asRecord(input)),
  delete: (input) => deletePath(asRecord(input) as unknown as DeleteRequest),
};

function failureEnvelope(error: unknown) {
  const code = error instanceof Failure ? error.code : errorCode(error);
  // Node's filesystem errors carry the path they failed on; keeping it lets the
  // panel name the entry instead of echoing a message with a temp path in it.
  const reported = typeof error === "object" && error !== null && "path" in error ? (error as { path: unknown }).path : undefined;
  const path = error instanceof Failure
    ? error.path
    : typeof reported === "string" ? reported : undefined;
  return fail(code, errorMessage(error), path);
}

export async function request(context: RequestContext): Promise<Json> {
  context.signal.throwIfAborted();
  const operation = context.operation;
  if (!Object.hasOwn(REQUEST_HANDLERS, operation)) {
    return fail("EINVAL", `Unknown operation: ${operation}`) as unknown as Json;
  }
  try {
    const result = await REQUEST_HANDLERS[operation as FileManagerOperation](context.input);
    return ok(result) as unknown as Json;
  } catch (error) {
    return failureEnvelope(error) as unknown as Json;
  }
}

export async function openChannel(context: ChannelOpenContext) {
  const opener = context.operation === "upload" ? openUploadChannel
    : context.operation === "save.text" ? openSaveChannel
      : undefined;
  if (opener === undefined) throw invalid(`Unknown channel operation: ${context.operation}`);
  return opener(context);
}

export async function resource(context: ResourceContext) {
  const serve = context.operation === "download" ? downloadResource
    : context.operation === "zip" ? zipResource
      : undefined;
  if (serve === undefined) throw invalid(`Unknown resource operation: ${context.operation}`);
  return serve(context);
}

const plugin: ServerPluginDefinition = {
  apiVersion: 5,
  name: "File manager",
  activate: () => {
    // Interrupted transfers leave temporaries; the timer revisits directories
    // this daemon wrote into, and listings sweep the rest.
    const stopSweeper = startTempSweeper();
    return {
      peer: { request, openChannel, resource },
      dispose: () => { stopSweeper(); },
    };
  },
};

export default plugin;

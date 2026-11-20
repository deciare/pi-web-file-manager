/**
 * The slice of the host's server-plugin contract this plugin uses, declared
 * structurally rather than imported.
 *
 * The installed package has no `node_modules` next to it and the host imports
 * each entry as a plain ES module, so a bare runtime specifier would fail to
 * resolve. Type-only imports would be erased, but they still need the package
 * present for typechecking; these local declarations keep the dependency at
 * zero while documenting exactly which fields we rely on.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ChannelOpenContext {
  readonly operation: string;
  readonly input: Json;
  readonly signal: AbortSignal;
  send(data: Json): void;
}

export interface PeerChannel {
  receive(data: Json, signal: AbortSignal): Promise<void>;
  close?(context: { readonly code: number; readonly reason: string; readonly signal: AbortSignal }): Promise<void>;
}

export interface RequestContext {
  readonly operation: string;
  readonly input: Json;
  readonly signal: AbortSignal;
}

export interface ResourceContext {
  readonly operation: string;
  readonly input: Json;
  readonly signal: AbortSignal;
  readonly range?: string;
}

export interface ResourceResponse {
  readonly body: Uint8Array | AsyncIterable<Uint8Array>;
  readonly contentType: string;
  readonly contentLength?: number;
  readonly statusCode?: 200 | 206 | 416;
  readonly contentRange?: string;
  readonly acceptRanges?: "bytes";
}

export interface ServerPluginDefinition {
  readonly apiVersion: 5;
  readonly name: string;
  readonly activate: () => {
    readonly peer: {
      request(context: RequestContext): Promise<Json>;
      openChannel(context: ChannelOpenContext): Promise<PeerChannel>;
      resource(context: ResourceContext): Promise<ResourceResponse>;
    };
  };
}

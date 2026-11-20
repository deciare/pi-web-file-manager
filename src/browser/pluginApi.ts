/**
 * Structural declarations for the slice of the browser plugin contract this
 * plugin consumes. Same reasoning as the server half: the installed package has
 * no node_modules beside it, so the host's package is not importable, and a
 * type-only import would still need it at typecheck time.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface MachineRef {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
}

export interface WorkspaceRef {
  readonly id: string;
  readonly projectId: string;
  readonly path: string;
  readonly label: string;
}

export interface Peer {
  request(operation: string, input: Json, options?: { signal?: AbortSignal }): Promise<Json>;
  resourceUrl?(operation: string, input: Json): string;
  openChannel?(
    operation: string,
    input: Json,
    options: {
      readonly signal?: AbortSignal;
      readonly onData: (data: Json) => void;
    },
  ): Promise<{ send(data: Json): void; close(reason?: string): void; readonly closed: Promise<unknown> }>;
}

export interface Backend {
  readonly machineId: string;
  forScope(scope: { readonly kind: "machine" } | { readonly kind: "project"; readonly projectId: string } | { readonly kind: "workspace"; readonly projectId: string; readonly workspaceId: string }): Peer;
}

export interface SelectionSnapshot {
  readonly selectedSession?: { readonly id: string; readonly cwd: string };
  readonly selectedWorkspace?: WorkspaceRef;
  readonly selectedMachine?: MachineRef;
}

/** Basic selection only: machine, project, workspace, session — never a transcript. */
export interface SelectionService {
  getSnapshot(): SelectionSnapshot;
  subscribe(listener: (snapshot: SelectionSnapshot) => void): () => void;
}

export interface PanelContext {
  readonly machine: MachineRef;
  readonly backend?: Backend;
  readonly workspace?: WorkspaceRef;
  readonly host?: { requestRender(): void };
}

export interface TemplateTag {
  (strings: TemplateStringsArray, ...values: unknown[]): unknown;
}

import type { ErrorCode } from "../shared/protocol.ts";

/**
 * One failure type for the whole server half. The dispatcher turns it into the
 * protocol's `{ ok: false, error }` envelope; anything that is not a `Failure`
 * is a bug and is reported as `EUNKNOWN` with its message intact.
 */
export class Failure extends Error {
  readonly code: ErrorCode;
  readonly path: string | undefined;

  constructor(code: ErrorCode, message: string, path?: string) {
    super(message);
    this.name = "Failure";
    this.code = code;
    this.path = path;
  }
}

export function invalid(message: string, path?: string): Failure {
  return new Failure("EINVAL", message, path);
}

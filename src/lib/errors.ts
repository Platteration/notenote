/**
 * The one error type whose message is meant for the person using the app.
 *
 * Everything else that reaches a route handler is an internal detail: a SQLite constraint
 * message, a JSON.parse SyntaxError, "Unsupported state or unable to authenticate data" from
 * a failed decrypt, or a platform's HTTP error carrying 200 bytes of an upstream body. Those
 * used to be handed back verbatim with a 400, which is both an information leak and a poor
 * explanation. `errorResponse` now shows only these, and logs the rest.
 *
 * It lives in its own module so that library code can throw one without importing the route
 * helpers (and with them `next/server`).
 */
export class UserFacingError extends Error {
  /** Status to answer with, when this error implies one. Otherwise the caller's default. */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "UserFacingError";
    this.status = status;
  }
}

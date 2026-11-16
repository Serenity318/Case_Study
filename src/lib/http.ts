import "server-only";

import type { PostgrestError } from "@supabase/supabase-js";

/**
 * Helpers for the CRM API routes. Errors use the same shape as /api/ask:
 *   { "error": { "code": string, "message": string } }
 * 400 = bad input, 404 = no such row, 409 = conflict, 502 = database failure,
 * 500 = unexpected server error.
 */

export function errorResponse(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status });
}

/** Parses the body as a JSON object, or returns a 400 response to send back. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse(400, "invalid_body", "Request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/**
 * Maps a Supabase/Postgres error to an HTTP response. `context` lets a route give a
 * friendlier message for the constraint it expects (e.g. duplicate email).
 */
export function dbErrorResponse(
  error: PostgrestError,
  context: { uniqueViolation?: string; foreignKeyViolation?: string } = {},
) {
  switch (error.code) {
    case "23505": // unique_violation
      return errorResponse(409, "conflict", context.uniqueViolation ?? "This record already exists.");
    case "23503": // foreign_key_violation
      return errorResponse(400, "invalid_reference", context.foreignKeyViolation ?? "A referenced record does not exist.");
    case "23514": // check_violation
    case "23502": // not_null_violation
    case "22P02": // invalid_text_representation (e.g. bad uuid)
    case "22003": // numeric_value_out_of_range
      return errorResponse(400, "invalid_value", `A value was rejected by the database: ${error.message}`);
    default:
      console.error(`Supabase error ${error.code}: ${error.message}`);
      return errorResponse(502, "database_error", "The database request failed. Please try again.");
  }
}

/** Wraps a handler so an unexpected throw (e.g. missing env var) becomes a 500 with the standard shape. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    console.error("CRM API unexpected error", err);
    return errorResponse(500, "internal_error", "Unexpected server error. See server logs for details.");
  }
}

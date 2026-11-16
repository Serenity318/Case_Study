/**
 * Browser-side helper for calling this app's own /api routes.
 *
 * Client-safe: uses fetch only. Turns the routes' { error: { code, message } }
 * body (and network failures) into an ApiError with a readable message.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number, // 0 = no response (network failure)
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch<T>(
  url: string,
  options: { method?: string; json?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: options.method ?? "GET",
      headers: options.json !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
      signal: options.signal,
      cache: "no-store",
    });
  } catch (err) {
    if (options.signal?.aborted) throw err; // let callers ignore cancelled requests
    throw new ApiError(0, "network_error", "Could not reach the server. Check that the app is running and try again.");
  }

  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    throw new ApiError(
      res.status,
      typeof error?.code === "string" ? error.code : "http_error",
      typeof error?.message === "string" ? error.message : `Request failed (HTTP ${res.status}).`,
    );
  }
  return body as T;
}

/** Readable message for anything thrown by apiFetch (or elsewhere). */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "Something went wrong. Please try again.";
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

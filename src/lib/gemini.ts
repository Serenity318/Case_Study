import "server-only";

/**
 * Gemini helpers:
 *  - embeddings, shared by ingestion (documents) and /api/ask (questions)
 *  - JSON answer generation for /api/ask
 *
 * Calls the REST API directly with fetch so timeout and retry behaviour are explicit.
 */

// ---------------------------------------------------------------------------
// Model settings. Chunks and questions MUST be embedded with the same model and
// dimension, otherwise similarity scores are meaningless. Changing either value
// requires re-ingesting every document (npm run ingest -- --force) and a schema
// change if the dimension changes (chunks.embedding is vector(1536)).
// ---------------------------------------------------------------------------
export const EMBEDDING_MODEL = "gemini-embedding-2";
export const EMBEDDING_DIMENSIONS = 1536;
/** Stored on each document row so we can tell which model produced its vectors. */
export const EMBEDDING_MODEL_ID = `${EMBEDDING_MODEL}@${EMBEDDING_DIMENSIONS}`;

/** Texts sent per batchEmbedContents request. Small enough to stay under free-tier token-per-minute limits. */
export const EMBED_BATCH_SIZE = 25;

/**
 * Answer model. Measured in Phase 2 Step A: ~1-2.5 s per answer with correct citations
 * and correct found=false. (gemini-2.5-flash returned 404 for this key and
 * gemini-3.8-flash timed out, although both appear in the model list.)
 */
export const GENERATION_MODEL = "gemini-3.5-flash-lite";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

// ---------------------------------------------------------------------------
// Retry policies. Ingestion is a batch job and can wait; a user waiting on
// /api/ask cannot, so interactive calls get few attempts and short timeouts.
// ---------------------------------------------------------------------------
interface RetryPolicy {
  maxAttempts: number;
  timeoutMs: number; // per attempt
  maxBackoffMs: number; // longest wait between attempts; a longer server hint fails fast
}
const BATCH_POLICY: RetryPolicy = { maxAttempts: 6, timeoutMs: 60_000, maxBackoffMs: 60_000 };
const QUERY_EMBED_POLICY: RetryPolicy = { maxAttempts: 2, timeoutMs: 10_000, maxBackoffMs: 2_000 };
const GENERATION_POLICY: RetryPolicy = { maxAttempts: 2, timeoutMs: 25_000, maxBackoffMs: 2_000 };

export type GeminiErrorKind =
  | "timeout" // no response within the time limit
  | "rate_limited" // 429 that we could not wait out
  | "unavailable" // 5xx or network failure after retries
  | "rejected" // 4xx: bad key, unknown model, invalid request
  | "blocked" // safety filters stopped the answer
  | "bad_response"; // response missing, truncated or not valid JSON

/** Typed error so callers (the API route) can map failures to HTTP status codes. */
export class GeminiError extends Error {
  constructor(
    readonly kind: GeminiErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

// gemini-embedding-2 ignores the `taskType` field (verified against the live API:
// vectors are identical with and without it). Instead, the task is written into
// the text itself using these documented prefixes.
export function formatDocumentForEmbedding(title: string | null, text: string): string {
  return `title: ${title?.trim() || "none"} | text: ${text}`;
}

export function formatQueryForEmbedding(question: string): string {
  return `task: question answering | query: ${question}`;
}

/** Embed a user question for similarity search (interactive: fails fast). */
export async function embedQuery(question: string): Promise<number[]> {
  const [vector] = await embedBatch([formatQueryForEmbedding(question)], QUERY_EMBED_POLICY);
  return vector;
}

/**
 * Embed document chunks. `title` is the context prefix (document title and section);
 * `text` is the chunk content. Returns one vector per item, in input order.
 */
export async function embedDocuments(
  items: { title: string | null; text: string }[],
  onProgress?: (done: number, total: number) => void,
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < items.length; i += EMBED_BATCH_SIZE) {
    const batch = items
      .slice(i, i + EMBED_BATCH_SIZE)
      .map((item) => formatDocumentForEmbedding(item.title, item.text));
    vectors.push(...(await embedBatch(batch, BATCH_POLICY)));
    onProgress?.(vectors.length, items.length);
  }
  return vectors;
}

async function embedBatch(texts: string[], policy: RetryPolicy): Promise<number[][]> {
  const body = {
    requests: texts.map((text) => ({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
      outputDimensionality: EMBEDDING_DIMENSIONS,
    })),
  };

  const json = (await postWithRetry(
    `${API_BASE}/models/${EMBEDDING_MODEL}:batchEmbedContents`,
    body,
    policy,
  )) as { embeddings?: { values?: number[] }[] };

  const embeddings = json.embeddings ?? [];
  if (embeddings.length !== texts.length) {
    throw new GeminiError(
      "bad_response",
      `Gemini returned ${embeddings.length} embeddings for ${texts.length} inputs`,
    );
  }
  return embeddings.map((e, i) => {
    const v = e.values;
    if (!v || v.length !== EMBEDDING_DIMENSIONS || !v.every(Number.isFinite)) {
      throw new GeminiError(
        "bad_response",
        `Embedding ${i} has ${v?.length ?? 0} dimensions, expected ${EMBEDDING_DIMENSIONS}`,
      );
    }
    return v;
  });
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const BLOCKED_FINISH_REASONS = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
]);

interface GenerateResponse {
  promptFeedback?: { blockReason?: string };
  candidates?: {
    finishReason?: string;
    content?: { parts?: { text?: string; thought?: boolean }[] };
  }[];
}

/**
 * Asks the answer model for JSON matching `responseSchema` (Gemini's structured
 * output) and returns the parsed object. The caller must still validate its shape:
 * the schema guides the model but the result is untrusted input.
 */
export async function generateJson(options: {
  systemInstruction: string;
  prompt: string;
  responseSchema: object;
  maxOutputTokens?: number;
}): Promise<unknown> {
  const json = (await postWithRetry(
    `${API_BASE}/models/${GENERATION_MODEL}:generateContent`,
    {
      systemInstruction: { parts: [{ text: options.systemInstruction }] },
      contents: [{ role: "user", parts: [{ text: options.prompt }] }],
      generationConfig: {
        temperature: 0, // same question + same sources -> same answer, as far as possible
        maxOutputTokens: options.maxOutputTokens ?? 2048,
        responseMimeType: "application/json",
        responseSchema: options.responseSchema,
      },
    },
    GENERATION_POLICY,
  )) as GenerateResponse;

  if (json.promptFeedback?.blockReason) {
    throw new GeminiError("blocked", `Gemini blocked the request (${json.promptFeedback.blockReason})`);
  }
  const candidate = json.candidates?.[0];
  if (!candidate) throw new GeminiError("bad_response", "Gemini returned no answer");

  const reason = candidate.finishReason ?? "STOP";
  if (BLOCKED_FINISH_REASONS.has(reason)) {
    throw new GeminiError("blocked", `Gemini stopped the answer (${reason})`);
  }
  if (reason === "MAX_TOKENS") {
    throw new GeminiError("bad_response", "Gemini's answer was cut off at the output token limit");
  }

  // Skip "thought" parts (internal reasoning) if the model returns any.
  const text = (candidate.content?.parts ?? [])
    .filter((p) => !p.thought)
    .map((p) => p.text ?? "")
    .join("");
  try {
    return JSON.parse(text);
  } catch {
    throw new GeminiError("bad_response", "Gemini's answer was not valid JSON");
  }
}

// ---------------------------------------------------------------------------
// HTTP with retry
// ---------------------------------------------------------------------------

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

async function postWithRetry(url: string, body: unknown, policy: RetryPolicy): Promise<unknown> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new GeminiError("rejected", "Missing environment variable GEMINI_API_KEY");

  for (let attempt = 1; ; attempt++) {
    const isLastAttempt = attempt >= policy.maxAttempts;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        // Key goes in a header, not the URL, so it never appears in logged URLs.
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(policy.timeoutMs),
      });
    } catch (err) {
      const timedOut = (err as Error).name === "TimeoutError";
      if (isLastAttempt) {
        throw timedOut
          ? new GeminiError("timeout", `Gemini did not respond within ${policy.timeoutMs / 1000}s`)
          : new GeminiError("unavailable", `Could not reach Gemini: ${(err as Error).message}`);
      }
      await backoff(attempt, null, policy, timedOut ? "timeout" : `network error: ${(err as Error).message}`);
      continue;
    }

    if (res.ok) return res.json();

    const text = await res.text();
    const message = extractMessage(text);

    if (res.status === 429) {
      // A daily quota will not reset within any reasonable retry window: fail fast.
      if (/per[ _]?day/i.test(text)) {
        throw new GeminiError("rate_limited", `Gemini daily quota exhausted: ${message}`);
      }
      const hint = retryHintMs(res, text);
      if (isLastAttempt || (hint !== null && hint > policy.maxBackoffMs)) {
        throw new GeminiError("rate_limited", `Gemini rate limit reached: ${message}`);
      }
      await backoff(attempt, hint, policy, `HTTP 429: ${message}`);
      continue;
    }
    if (!RETRYABLE_STATUS.has(res.status)) {
      throw new GeminiError("rejected", `Gemini API ${res.status}: ${message}`);
    }
    if (isLastAttempt) {
      throw new GeminiError("unavailable", `Gemini API ${res.status} after ${attempt} attempt(s): ${message}`);
    }
    await backoff(attempt, retryHintMs(res, text), policy, `HTTP ${res.status}: ${message}`);
  }
}

/** Exponential backoff (2s, 4s, 8s ... capped by the policy) plus jitter; honours the server's hint if longer. */
async function backoff(
  attempt: number,
  hintMs: number | null,
  policy: RetryPolicy,
  reason: string,
): Promise<void> {
  const exponential = Math.min(policy.maxBackoffMs, 1000 * 2 ** attempt);
  const delay = Math.max(exponential, hintMs ?? 0) + Math.random() * 500;
  console.warn(
    `  Gemini retry ${attempt}/${policy.maxAttempts - 1} in ${(delay / 1000).toFixed(1)}s (${reason.slice(0, 160)})`,
  );
  await new Promise((resolve) => setTimeout(resolve, delay));
}

/** Reads the suggested wait from a Retry-After header or a google.rpc.RetryInfo detail ("37s"). */
function retryHintMs(res: Response, body: string): number | null {
  const header = Number(res.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const match = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return match ? Math.ceil(Number(match[1]) * 1000) : null;
}

function extractMessage(body: string): string {
  try {
    return (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? body;
  } catch {
    return body.slice(0, 300);
  }
}

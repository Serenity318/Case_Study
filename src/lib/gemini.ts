import "server-only";

/**
 * Gemini embedding helpers, shared by ingestion (documents) and /api/ask (questions).
 *
 * Calls the REST API directly with fetch so retry behaviour on 429/5xx is explicit.
 * Answer generation for /api/ask is added in a later phase.
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

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MAX_ATTEMPTS = 6;
const REQUEST_TIMEOUT_MS = 60_000;

// gemini-embedding-2 ignores the `taskType` field (verified against the live API:
// vectors are identical with and without it). Instead, the task is written into
// the text itself using these documented prefixes.
export function formatDocumentForEmbedding(title: string | null, text: string): string {
  return `title: ${title?.trim() || "none"} | text: ${text}`;
}

export function formatQueryForEmbedding(question: string): string {
  return `task: question answering | query: ${question}`;
}

/** Embed a user question for similarity search. */
export async function embedQuery(question: string): Promise<number[]> {
  const [vector] = await embedBatch([formatQueryForEmbedding(question)]);
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
    vectors.push(...(await embedBatch(batch)));
    onProgress?.(vectors.length, items.length);
  }
  return vectors;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function embedBatch(texts: string[]): Promise<number[][]> {
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
  )) as { embeddings?: { values?: number[] }[] };

  const embeddings = json.embeddings ?? [];
  if (embeddings.length !== texts.length) {
    throw new Error(`Gemini returned ${embeddings.length} embeddings for ${texts.length} inputs`);
  }
  return embeddings.map((e, i) => {
    const v = e.values;
    if (!v || v.length !== EMBEDDING_DIMENSIONS || !v.every(Number.isFinite)) {
      throw new Error(
        `Embedding ${i} has ${v?.length ?? 0} dimensions, expected ${EMBEDDING_DIMENSIONS}`,
      );
    }
    return v;
  });
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

async function postWithRetry(url: string, body: unknown): Promise<unknown> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing environment variable GEMINI_API_KEY");

  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        // Key goes in a header, not the URL, so it never appears in logged URLs.
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Network failure or timeout: retry like a 503.
      if (attempt >= MAX_ATTEMPTS) throw err;
      await backoff(attempt, null, `network error: ${(err as Error).message}`);
      continue;
    }

    if (res.ok) return res.json();

    const text = await res.text();
    const message = extractMessage(text);

    // A daily quota will not reset within any reasonable retry window: fail fast.
    if (res.status === 429 && /per[ _]?day/i.test(text)) {
      throw new Error(`Gemini daily quota exhausted: ${message}`);
    }
    if (!RETRYABLE_STATUS.has(res.status) || attempt >= MAX_ATTEMPTS) {
      throw new Error(`Gemini API ${res.status} after ${attempt} attempt(s): ${message}`);
    }
    await backoff(attempt, retryHintMs(res, text), `HTTP ${res.status}: ${message}`);
  }
}

/** Exponential backoff (2s, 4s, 8s ... capped at 60s) plus jitter; honours the server's hint if longer. */
async function backoff(attempt: number, hintMs: number | null, reason: string): Promise<void> {
  const exponential = Math.min(60_000, 1000 * 2 ** attempt);
  const delay = Math.max(exponential, hintMs ?? 0) + Math.random() * 1000;
  console.warn(
    `  Gemini retry ${attempt}/${MAX_ATTEMPTS - 1} in ${(delay / 1000).toFixed(1)}s (${reason.slice(0, 160)})`,
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

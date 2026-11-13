import { GeminiError, generateJson } from "@/lib/gemini";
import {
  ANSWER_SCHEMA,
  SYSTEM_INSTRUCTION,
  buildPrompt,
  verifyAnswer,
  type NotFoundReason,
  type VerifiedAnswer,
} from "@/lib/rag/prompt";
import {
  DOC_TYPES,
  RetrievalError,
  SIMILARITY_THRESHOLD,
  TOP_K,
  isDocType,
  pageLabel,
  pageUrl,
  retrieveChunks,
  type DocType,
  type RetrievedChunk,
} from "@/lib/rag/retrieve";

/**
 * POST /api/ask   body: { "question": string, "docType"?: "e_invoice" | "income_tax" | "sst" }
 *
 * 1. Validate input.
 * 2. Embed the question and retrieve the top-k chunks (optionally one doc_type).
 * 3. Layer 1 guard: if the best chunk scores below the threshold, answer "not found"
 *    without calling the LLM.
 * 4. Ask Gemini for a JSON answer citing numbered sources.
 * 5. Layer 2 guard: the model may itself say found=false; any citation number that
 *    does not match a retrieved chunk is removed; an answer left with no valid
 *    citation is reported as not found ("ungrounded").
 *
 * "Not found" is a normal outcome (HTTP 200, found: false). Errors use
 * { error: { code, message } } with 400 (bad input), 502 (Gemini/database failure)
 * or 504 (Gemini timeout).
 */

const MIN_QUESTION_CHARS = 3;
const MAX_QUESTION_CHARS = 1000;

export async function POST(request: Request) {
  const startedAt = Date.now();

  // 1. Input -------------------------------------------------------------------
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_json", 'Request body must be JSON, e.g. { "question": "..." }');
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse(400, "invalid_body", 'Request body must be a JSON object, e.g. { "question": "..." }');
  }
  const { question: rawQuestion, docType: rawDocType } = body as Record<string, unknown>;

  if (typeof rawQuestion !== "string") {
    return errorResponse(400, "invalid_question", '"question" is required and must be a string');
  }
  const question = rawQuestion.trim();
  if (question.length < MIN_QUESTION_CHARS || question.length > MAX_QUESTION_CHARS) {
    return errorResponse(
      400,
      "invalid_question",
      `"question" must be between ${MIN_QUESTION_CHARS} and ${MAX_QUESTION_CHARS} characters`,
    );
  }

  let docType: DocType | undefined;
  if (rawDocType !== undefined && rawDocType !== null && rawDocType !== "") {
    if (!isDocType(rawDocType)) {
      return errorResponse(400, "invalid_doc_type", `"docType" must be one of: ${DOC_TYPES.join(", ")}`);
    }
    docType = rawDocType;
  }

  try {
    // 2. Retrieve ---------------------------------------------------------------
    const chunks = await retrieveChunks(question, { docType });
    const topScore = chunks[0]?.similarity ?? null;
    const retrieval = { topScore, threshold: SIMILARITY_THRESHOLD, topK: TOP_K, docType: docType ?? null };

    // 3. Layer 1: similarity threshold -----------------------------------------
    if (topScore === null || topScore < SIMILARITY_THRESHOLD) {
      const verified: VerifiedAnswer = {
        found: false,
        answer: "",
        citedRefs: [],
        invalidRefs: [],
        notFoundReason: "below_threshold",
      };
      return answerResponse(verified, chunks, retrieval, startedAt);
    }

    // 4. Generate -----------------------------------------------------------------
    const raw = await generateJson({
      systemInstruction: SYSTEM_INSTRUCTION,
      prompt: buildPrompt(question, chunks),
      responseSchema: ANSWER_SCHEMA,
    });

    // 5. Layer 2: model's own verdict + citation verification --------------------
    const verified = verifyAnswer(raw, chunks.length);
    return answerResponse(verified, chunks, retrieval, startedAt);
  } catch (err) {
    return upstreamErrorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function answerResponse(
  verified: VerifiedAnswer,
  chunks: RetrievedChunk[],
  retrieval: { topScore: number | null; threshold: number; topK: number; docType: DocType | null },
  startedAt: number,
) {
  const cited = new Set(verified.citedRefs);

  // Log metadata only, not the question text (it may contain business details).
  console.info(
    JSON.stringify({
      route: "/api/ask",
      ms: Date.now() - startedAt,
      topScore: retrieval.topScore === null ? null : Number(retrieval.topScore.toFixed(3)),
      docType: retrieval.docType,
      found: verified.found,
      notFoundReason: verified.notFoundReason,
      cited: verified.citedRefs,
      invalidRefs: verified.invalidRefs,
    }),
  );

  return Response.json({
    found: verified.found,
    notFoundReason: verified.notFoundReason satisfies NotFoundReason | null,
    answer: verified.found
      ? verified.answer
      : "I could not find the answer to this question in the available tax documents.",
    citations: verified.citedRefs.map((ref) => {
      const chunk = chunks[ref - 1];
      return {
        ref,
        documentTitle: chunk.documentTitle,
        docType: chunk.docType,
        pageLabel: pageLabel(chunk),
        printedPage: chunk.printedPage,
        pdfPage: chunk.pdfPage,
        section: chunk.section,
        url: pageUrl(chunk),
      };
    }),
    chunks: chunks.map((chunk, i) => ({
      ref: i + 1,
      score: Number(chunk.similarity.toFixed(4)),
      cited: cited.has(i + 1),
      documentTitle: chunk.documentTitle,
      docType: chunk.docType,
      printedPage: chunk.printedPage,
      pdfPage: chunk.pdfPage,
      section: chunk.section,
      content: chunk.content,
    })),
    retrieval: {
      ...retrieval,
      topScore: retrieval.topScore === null ? null : Number(retrieval.topScore.toFixed(4)),
    },
  });
}

function errorResponse(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status });
}

function upstreamErrorResponse(err: unknown) {
  if (err instanceof GeminiError) {
    console.error(`/api/ask Gemini ${err.kind}: ${err.message}`);
    if (err.kind === "timeout") return errorResponse(504, "gemini_timeout", err.message);
    if (err.kind === "rate_limited") return errorResponse(502, "gemini_rate_limited", err.message);
    return errorResponse(502, `gemini_${err.kind}`, err.message);
  }
  if (err instanceof RetrievalError) {
    console.error(`/api/ask retrieval: ${err.message}`);
    return errorResponse(502, "database_error", err.message);
  }
  console.error("/api/ask unexpected error", err);
  return errorResponse(500, "internal_error", "Unexpected server error. See server logs for details.");
}

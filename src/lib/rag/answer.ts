import "server-only";

import { generateJson } from "@/lib/gemini";
import { ANSWER_SCHEMA, SYSTEM_INSTRUCTION, buildPrompt, verifyAnswer, type VerifiedAnswer } from "@/lib/rag/prompt";
import { SIMILARITY_THRESHOLD, TOP_K, retrieveChunks, type DocType, type RetrievedChunk } from "@/lib/rag/retrieve";

export interface RetrievalInfo {
  topScore: number | null;
  threshold: number;
  topK: number;
  docType: DocType | null;
}

export interface AnswerResult {
  verified: VerifiedAnswer;
  /** The retrieved chunks, best first; chunk i is source number i + 1 in the prompt. */
  chunks: RetrievedChunk[];
  retrieval: RetrievalInfo;
}

/**
 * The RAG pipeline shared by POST /api/ask and scripts/eval.ts:
 *
 * 1. Embed the question and retrieve the top-k chunks (optionally one doc_type).
 * 2. Layer 1 guard: if the best chunk scores below the threshold, return "not found"
 *    without calling the LLM.
 * 3. Ask Gemini for a JSON answer citing numbered sources.
 * 4. Layer 2 guard: the model may itself say found=false; citation numbers that do
 *    not match a retrieved chunk are removed; an answer left with no valid citation
 *    is reported as not found ("ungrounded").
 *
 * The question must already be validated and trimmed. Throws GeminiError or
 * RetrievalError on upstream failure; the caller decides how to report them.
 */
export async function answerQuestion(question: string, options: { docType?: DocType } = {}): Promise<AnswerResult> {
  const docType = options.docType;

  // 1. Retrieve -----------------------------------------------------------------
  const chunks = await retrieveChunks(question, { docType });
  const topScore = chunks[0]?.similarity ?? null;
  const retrieval: RetrievalInfo = { topScore, threshold: SIMILARITY_THRESHOLD, topK: TOP_K, docType: docType ?? null };

  // 2. Layer 1: similarity threshold -------------------------------------------
  if (topScore === null || topScore < SIMILARITY_THRESHOLD) {
    const verified: VerifiedAnswer = {
      found: false,
      answer: "",
      citedRefs: [],
      invalidRefs: [],
      notFoundReason: "below_threshold",
    };
    return { verified, chunks, retrieval };
  }

  // 3. Generate -------------------------------------------------------------------
  const raw = await generateJson({
    systemInstruction: SYSTEM_INSTRUCTION,
    prompt: buildPrompt(question, chunks),
    responseSchema: ANSWER_SCHEMA,
  });

  // 4. Layer 2: model's own verdict + citation verification ----------------------
  const verified = verifyAnswer(raw, chunks.length);
  return { verified, chunks, retrieval };
}

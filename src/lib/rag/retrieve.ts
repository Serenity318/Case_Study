import "server-only";

import { embedQuery } from "@/lib/gemini";
import { getSupabase } from "@/lib/supabase";

/** How many chunks are retrieved and shown to the model. */
export const TOP_K = 5;

/**
 * Minimum cosine similarity of the BEST chunk for a question to be sent to the model
 * (layer 1 of the hallucination guard). Scores are for gemini-embedding-2@1536 with the
 * "task: question answering" query prefix; re-measure if any of those change.
 *
 * History: 0.73 was set from the Phase 2 measurement (answerable 0.776-0.815,
 * unanswerable 0.516-0.695). The 10-question eval (eval/results-threshold-0.73.md)
 * showed it refused two answerable scenario questions, q2 (0.719) and q7 (0.692).
 * In the eval the two groups overlap (answerable 0.692-0.814, unanswerable
 * 0.516-0.741), so no threshold separates them. At 0.65 this check only stops
 * clearly unrelated questions; in-domain questions the documents do not cover
 * (q8 0.741, q9 0.668) are refused by layer 2, the model's own found=false.
 * All 3 unanswerable questions were still refused (eval/results.md).
 */
export const SIMILARITY_THRESHOLD = 0.65;

/** Allowed values for the optional doc_type filter (documents.doc_type). */
export const DOC_TYPES = ["e_invoice", "income_tax", "sst"] as const;
export type DocType = (typeof DOC_TYPES)[number];

export function isDocType(value: unknown): value is DocType {
  return typeof value === "string" && (DOC_TYPES as readonly string[]).includes(value);
}

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  docType: string;
  version: string | null;
  publishedDate: string | null; // ISO date, e.g. "2020-10-13"
  sourceUrl: string | null;
  pdfPage: number;
  printedPage: string | null;
  section: string | null;
  content: string;
  similarity: number;
}

/** A database failure during retrieval (as opposed to a Gemini failure). */
export class RetrievalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetrievalError";
  }
}

/** Row shape returned by the match_chunks SQL function (supabase/migrations/0002). */
interface MatchChunksRow {
  chunk_id: string;
  document_id: string;
  document_title: string;
  doc_type: string;
  version: string | null;
  published_date: string | null;
  source_url: string | null;
  pdf_page: number;
  printed_page: string | null;
  section: string | null;
  content: string;
  similarity: number;
}

/**
 * Embeds the question (same model, dimension and query prefix as ingestion) and
 * returns the TOP_K most similar chunks, best first. Does NOT apply the threshold:
 * the caller decides, so it can still show the closest matches when nothing passes.
 */
export async function retrieveChunks(
  question: string,
  options: { docType?: DocType } = {},
): Promise<RetrievedChunk[]> {
  const embedding = await embedQuery(question); // throws GeminiError on failure

  const { data, error } = await getSupabase().rpc("match_chunks", {
    // pgvector accepts the "[0.1,0.2,...]" text form; JSON.stringify produces exactly that.
    query_embedding: JSON.stringify(embedding),
    match_count: TOP_K,
    filter_doc_type: options.docType ?? null,
  });

  if (error) {
    // PGRST202 = PostgREST cannot find the function: the migration has not been run.
    if (error.code === "PGRST202") {
      throw new RetrievalError(
        "Search function match_chunks not found. Run supabase/migrations/0002_match_chunks.sql in the Supabase SQL editor.",
      );
    }
    throw new RetrievalError(`Similarity search failed: ${error.message}`);
  }

  return ((data ?? []) as MatchChunksRow[]).map((row) => ({
    chunkId: row.chunk_id,
    documentId: row.document_id,
    documentTitle: row.document_title,
    docType: row.doc_type,
    version: row.version,
    publishedDate: row.published_date,
    sourceUrl: row.source_url,
    pdfPage: row.pdf_page,
    printedPage: row.printed_page,
    section: row.section,
    content: row.content,
    similarity: Number(row.similarity),
  }));
}

/** "p. 10 (PDF p. 13)"; "p. 6" when both agree; "PDF p. 2" when no printed number was found. */
export function pageLabel(chunk: Pick<RetrievedChunk, "printedPage" | "pdfPage">): string {
  if (!chunk.printedPage) return `PDF p. ${chunk.pdfPage}`;
  if (chunk.printedPage === String(chunk.pdfPage)) return `p. ${chunk.printedPage}`;
  return `p. ${chunk.printedPage} (PDF p. ${chunk.pdfPage})`;
}

/** Link that opens the source PDF at the right page in browser PDF viewers. */
export function pageUrl(chunk: Pick<RetrievedChunk, "sourceUrl" | "pdfPage">): string | null {
  return chunk.sourceUrl ? `${chunk.sourceUrl}#page=${chunk.pdfPage}` : null;
}

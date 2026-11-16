/**
 * Retrieval + answer evaluation over eval/questions.json.
 *
 *   npm.cmd run eval                    # all questions, 8 s pause between them
 *   npm.cmd run eval -- --delay 15      # longer pause (seconds) if you hit 429s
 *   npm.cmd run eval -- --only q03      # one question (by id); repeatable
 *   npm.cmd run eval -- --questions other.json --out other-results.md
 *
 * questions.json: [{ "id": "q01", "question": "...", "expectedDoc": "file.pdf" | null, "notes": "..." }]
 *   expectedDoc = the manifest filename that should answer it, or null if the
 *   documents should NOT answer it (the system is expected to refuse).
 *
 * Each question runs through the same pipeline as POST /api/ask
 * (src/lib/rag/answer.ts), with no docType filter. Writes eval/results.md.
 *
 * Metrics:
 *   hit@5 / hit@1        answerable questions: expectedDoc appears in the top 5 / at rank 1
 *   correct-refusal rate unanswerable questions: found = false
 * Questions that failed with an error are listed but excluded from the metrics.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { loadEnvConfig } from "@next/env";

import { EMBEDDING_MODEL_ID, GENERATION_MODEL, GeminiError } from "../src/lib/gemini";
import { answerQuestion } from "../src/lib/rag/answer";
import { SIMILARITY_THRESHOLD, TOP_K } from "../src/lib/rag/retrieve";
import { getSupabase } from "../src/lib/supabase";

loadEnvConfig(process.cwd());

const ROOT = process.cwd();
const DEFAULT_QUESTIONS_PATH = path.join(ROOT, "eval", "questions.json");
const DEFAULT_RESULTS_PATH = path.join(ROOT, "eval", "results.md");
const MANIFEST_PATH = path.join(ROOT, "data", "tax-docs", "manifest.json");

/**
 * Default pause between questions. Each question costs one embedding call and (if it
 * passes the threshold) one generation call; 8 s keeps generation under ~8 requests
 * per minute, inside the free-tier per-minute limits with room for retries.
 */
const DEFAULT_DELAY_SECONDS = 8;
/** One extra attempt after a rate-limit error, after this pause. */
const RATE_LIMIT_RETRY_SECONDS = 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface EvalQuestion {
  id: string;
  question: string;
  expectedDoc: string | null;
  notes: string;
}

interface EvalResult {
  q: EvalQuestion;
  topScore: number | null;
  /** 1-based rank of the first chunk from expectedDoc in the top-k; "miss" if absent; null if unanswerable. */
  rank: number | "miss" | null;
  found: boolean | null;
  notFoundReason: string | null;
  citedDocs: string[];
  ms: number;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const { values } = parseArgs({
    options: {
      delay: { type: "string", default: String(DEFAULT_DELAY_SECONDS) },
      only: { type: "string", multiple: true },
      questions: { type: "string", default: DEFAULT_QUESTIONS_PATH },
      out: { type: "string", default: DEFAULT_RESULTS_PATH },
    },
  });
  const questionsPath = path.resolve(values.questions);
  const resultsPath = path.resolve(values.out);
  const delaySeconds = Number(values.delay);
  if (!Number.isFinite(delaySeconds) || delaySeconds < 0) fail(`--delay must be a number of seconds, got "${values.delay}"`);

  const manifestFiles = new Set(
    (JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as { filename: string }[]).map((e) => e.filename),
  );
  let questions = await loadQuestions(questionsPath, manifestFiles);
  if (values.only?.length) {
    const wanted = new Set(values.only);
    questions = questions.filter((q) => wanted.has(q.id));
    if (questions.length === 0) fail(`No question matches --only ${values.only.join(", ")}`);
  }

  const filenameById = await loadDocumentFilenames();
  const missing = [...manifestFiles].filter((f) => ![...filenameById.values()].includes(f));
  if (missing.length) console.warn(`Warning: not ingested yet (will always be a miss): ${missing.join(", ")}`);

  console.log(
    `Evaluating ${questions.length} question(s) · ${EMBEDDING_MODEL_ID} · ${GENERATION_MODEL} · ` +
      `threshold ${SIMILARITY_THRESHOLD} · top ${TOP_K} · ${delaySeconds}s pause\n`,
  );

  const results: EvalResult[] = [];
  for (const [i, q] of questions.entries()) {
    if (i > 0) await sleep(delaySeconds * 1000);
    const result = await evaluate(q, filenameById);
    results.push(result);
    console.log(`[${i + 1}/${questions.length}] ${q.id}  ${summaryLine(result)}`);
  }

  const markdown = renderMarkdown(results, delaySeconds, path.relative(ROOT, questionsPath));
  await writeFile(resultsPath, markdown, "utf8");

  const m = metrics(results);
  console.log(
    `\nhit@5 ${fmtRate(m.hit5, m.answerable)} · hit@1 ${fmtRate(m.hit1, m.answerable)} · ` +
      `correct refusals ${fmtRate(m.refused, m.unanswerable)} · errors ${m.errors}`,
  );
  console.log(`Wrote ${path.relative(ROOT, resultsPath)}`);
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
async function loadQuestions(file: string, manifestFiles: Set<string>): Promise<EvalQuestion[]> {
  const name = path.relative(ROOT, file);
  let parsed: unknown;
  try {
    // Strip a UTF-8 BOM: PowerShell 5.1's Out-File and some Windows editors add one.
    parsed = JSON.parse((await readFile(file, "utf8")).replace(/^﻿/, ""));
  } catch (err) {
    fail(`Could not read ${name}: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) fail(`${name} must be a JSON array`);
  if (parsed.length === 0) fail(`${name} is empty. Add questions first.`);

  const problems: string[] = [];
  const seen = new Set<string>();
  const questions = parsed.map((item, i): EvalQuestion => {
    const where = `item ${i + 1}`;
    const o = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const id = typeof o.id === "string" || typeof o.id === "number" ? String(o.id) : "";
    if (!id) problems.push(`${where}: "id" must be a string or number`);
    else if (seen.has(id)) problems.push(`${where}: duplicate id "${id}"`);
    seen.add(id);

    const question = typeof o.question === "string" ? o.question.trim() : "";
    if (question.length < 3 || question.length > 1000) {
      problems.push(`${where} (${id}): "question" must be a string of 3-1000 characters`);
    }

    if (o.expectedDoc !== null && typeof o.expectedDoc !== "string") {
      problems.push(`${where} (${id}): "expectedDoc" must be a filename or null`);
    } else if (typeof o.expectedDoc === "string" && !manifestFiles.has(o.expectedDoc)) {
      problems.push(`${where} (${id}): expectedDoc "${o.expectedDoc}" is not in data/tax-docs/manifest.json`);
    }

    return {
      id,
      question,
      expectedDoc: typeof o.expectedDoc === "string" ? o.expectedDoc : null,
      notes: typeof o.notes === "string" ? o.notes : "",
    };
  });

  if (problems.length) fail(`${name} has problems:\n  - ${problems.join("\n  - ")}`);
  return questions;
}

/** documents.id -> filename (match_chunks returns the id and title, not the filename). */
async function loadDocumentFilenames(): Promise<Map<string, string>> {
  const { data, error } = await getSupabase().from("documents").select("id, filename");
  if (error) fail(`Could not read the documents table: ${error.message}`);
  return new Map((data as { id: string; filename: string }[]).map((d) => [d.id, d.filename]));
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------
async function evaluate(q: EvalQuestion, filenameById: Map<string, string>): Promise<EvalResult> {
  const started = Date.now();
  try {
    const { verified, chunks, retrieval } = await withRateLimitRetry(() => answerQuestion(q.question));
    const files = chunks.map((c) => filenameById.get(c.documentId) ?? `unknown:${c.documentId}`);

    let rank: EvalResult["rank"] = null;
    if (q.expectedDoc !== null) {
      const index = files.indexOf(q.expectedDoc);
      rank = index === -1 ? "miss" : index + 1;
    }

    return {
      q,
      topScore: retrieval.topScore,
      rank,
      found: verified.found,
      notFoundReason: verified.notFoundReason,
      citedDocs: [...new Set(verified.citedRefs.map((ref) => files[ref - 1]))],
      ms: Date.now() - started,
      error: null,
    };
  } catch (err) {
    const message = err instanceof GeminiError ? `Gemini ${err.kind}: ${err.message}` : (err as Error).message;
    return {
      q,
      topScore: null,
      rank: null,
      found: null,
      notFoundReason: null,
      citedDocs: [],
      ms: Date.now() - started,
      error: message,
    };
  }
}

async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof GeminiError && err.kind === "rate_limited")) throw err;
    console.warn(`  rate limited; waiting ${RATE_LIMIT_RETRY_SECONDS}s and retrying once`);
    await sleep(RATE_LIMIT_RETRY_SECONDS * 1000);
    return fn();
  }
}

/** Plain-language verdict for one question. */
function outcome(r: EvalResult): string {
  if (r.error) return "ERROR";
  if (r.q.expectedDoc === null) {
    return r.found ? "WRONG: answered (should refuse)" : "OK: refused";
  }
  if (!r.found) return r.rank === "miss" ? "WRONG: retrieval miss" : `WRONG: refused (${r.notFoundReason})`;
  if (!r.citedDocs.includes(r.q.expectedDoc)) return "PARTIAL: answered, expected doc not cited";
  return "OK: answered from expected doc";
}

function metrics(results: EvalResult[]) {
  const ok = results.filter((r) => !r.error);
  const answerable = ok.filter((r) => r.q.expectedDoc !== null);
  const unanswerable = ok.filter((r) => r.q.expectedDoc === null);
  return {
    answerable: answerable.length,
    hit5: answerable.filter((r) => typeof r.rank === "number" && r.rank <= TOP_K).length,
    hit1: answerable.filter((r) => r.rank === 1).length,
    answered: answerable.filter((r) => r.found).length,
    citedExpected: answerable.filter((r) => r.found && r.citedDocs.includes(r.q.expectedDoc!)).length,
    unanswerable: unanswerable.length,
    refused: unanswerable.filter((r) => r.found === false).length,
    errors: results.length - ok.length,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
function renderMarkdown(results: EvalResult[], delaySeconds: number, questionsName: string): string {
  const m = metrics(results);
  const lines: string[] = [];

  lines.push("# Evaluation results", "");
  lines.push(
    `Generated ${new Date().toISOString()} by \`npm run eval\` from \`${questionsName.replaceAll("\\", "/")}\` (${results.length} questions).`,
    "",
    `Embedding \`${EMBEDDING_MODEL_ID}\`; generation \`${GENERATION_MODEL}\`; similarity threshold ${SIMILARITY_THRESHOLD}; top ${TOP_K}; no docType filter; ${delaySeconds}s pause between questions.`,
    "",
  );

  lines.push("## Summary", "");
  lines.push("| Metric | Value | Counted over |", "| --- | --- | --- |");
  lines.push(`| hit@5 | ${fmtRate(m.hit5, m.answerable)} | answerable questions (expectedDoc in the top ${TOP_K} chunks) |`);
  lines.push(`| hit@1 | ${fmtRate(m.hit1, m.answerable)} | answerable questions (expectedDoc is the top chunk) |`);
  lines.push(`| Correct-refusal rate | ${fmtRate(m.refused, m.unanswerable)} | unanswerable questions (found = false) |`);
  lines.push(`| Answered (found = true) | ${fmtRate(m.answered, m.answerable)} | answerable questions |`);
  lines.push(`| Answered and cited expectedDoc | ${fmtRate(m.citedExpected, m.answerable)} | answerable questions |`);
  lines.push(`| Errors (excluded above) | ${m.errors} | all questions |`, "");

  lines.push("## Per question", "");
  lines.push(
    "| ID | Question | Expected doc | Top score | Rank | Found | Not-found reason | Cited docs | Outcome | Notes |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const r of results) {
    const cells = [
      r.q.id,
      r.q.question,
      r.q.expectedDoc ?? "_(none: should refuse)_",
      r.topScore === null ? "-" : r.topScore.toFixed(3),
      r.rank === null ? "-" : String(r.rank),
      r.found === null ? "-" : r.found ? "yes" : "no",
      r.notFoundReason ?? "-",
      r.citedDocs.length ? r.citedDocs.join("<br>") : "-",
      r.error ? `ERROR: ${r.error}` : outcome(r),
      r.q.notes || "",
    ];
    lines.push(`| ${cells.map(cell).join(" | ")} |`);
  }
  lines.push("");
  lines.push(
    "Rank = position (1-5) of the first retrieved chunk from the expected document; `miss` = not in the top 5; `-` = not applicable.",
    "",
  );
  return lines.join("\n");
}

function summaryLine(r: EvalResult): string {
  if (r.error) return `ERROR ${r.error}`;
  const score = r.topScore === null ? "n/a" : r.topScore.toFixed(3);
  return `top ${score} · rank ${r.rank ?? "-"} · found ${r.found} · ${outcome(r)} · ${r.ms} ms`;
}

/** Escape a value for a Markdown table cell. */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function fmtRate(n: number, d: number): string {
  return d === 0 ? "n/a (0 questions)" : `${((n / d) * 100).toFixed(0)}% (${n}/${d})`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

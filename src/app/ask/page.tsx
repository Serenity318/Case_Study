"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// Response types. Mirrors the JSON built in src/app/api/ask/route.ts.
// Declared here on purpose: this is a client component, so it must not import
// server modules (src/lib/supabase.ts, src/lib/gemini.ts, src/lib/rag/*).
// ---------------------------------------------------------------------------

type NotFoundReason = "below_threshold" | "model_declined" | "ungrounded";

interface Citation {
  ref: number;
  documentTitle: string;
  docType: string;
  pageLabel: string;
  printedPage: string | null;
  pdfPage: number;
  section: string | null;
  url: string | null;
}

interface RetrievedChunk {
  ref: number;
  score: number;
  cited: boolean;
  documentTitle: string;
  docType: string;
  printedPage: string | null;
  pdfPage: number;
  section: string | null;
  content: string;
}

interface AskResponse {
  found: boolean;
  notFoundReason: NotFoundReason | null;
  answer: string;
  citations: Citation[];
  chunks: RetrievedChunk[];
  retrieval: { topScore: number | null; threshold: number; topK: number; docType: string | null };
}

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; question: string; data: AskResponse }
  | { status: "error"; title: string; detail: string | null };

const MIN_CHARS = 3; // same limits as the API
const MAX_CHARS = 1000;

const DOC_TYPE_OPTIONS = [
  { value: "", label: "All documents" },
  { value: "e_invoice", label: "e-Invoice" },
  { value: "income_tax", label: "Income tax" },
  { value: "sst", label: "SST" },
] as const;

const DOC_TYPE_LABELS: Record<string, string> = {
  e_invoice: "e-Invoice",
  income_tax: "Income tax",
  sst: "SST",
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AskPage() {
  const [question, setQuestion] = useState("");
  const [docType, setDocType] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });
  const inFlight = useRef<AbortController | null>(null);

  // Cancel a pending request if the user leaves the page.
  useEffect(() => () => inFlight.current?.abort(), []);

  const trimmed = question.trim();
  const tooShort = trimmed.length < MIN_CHARS;
  const tooLong = trimmed.length > MAX_CHARS;
  const loading = state.status === "loading";

  async function ask(event?: FormEvent) {
    event?.preventDefault();
    if (loading || tooShort || tooLong) return;

    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setState({ status: "loading" });

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(docType ? { question: trimmed, docType } : { question: trimmed }),
        signal: controller.signal,
      });
      const body: unknown = await res.json().catch(() => null);
      if (controller.signal.aborted) return;

      if (!res.ok) {
        setState({ status: "error", ...describeError(res.status, body) });
        return;
      }
      if (!isAskResponse(body)) {
        setState({
          status: "error",
          title: "The server sent a response this page could not read.",
          detail: `HTTP ${res.status}`,
        });
        return;
      }
      setState({ status: "success", question: trimmed, data: body });
    } catch (err) {
      if (controller.signal.aborted) return;
      setState({
        status: "error",
        title: "Could not reach the server. Check that the app is running and your connection is up, then try again.",
        detail: err instanceof Error ? err.message : null,
      });
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold">Tax Q&amp;A</h1>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Ask about Malaysian e-Invoice, income tax or SST. Answers come only from the loaded LHDN and
        RMCD documents, with page citations.
      </p>

      <form onSubmit={ask} className="mt-6 space-y-3">
        <label htmlFor="question" className="block text-sm font-medium">
          Question
        </label>
        <textarea
          id="question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void ask();
          }}
          rows={3}
          maxLength={MAX_CHARS + 200}
          placeholder="e.g. When must a supplier issue a consolidated e-Invoice?"
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30 dark:border-zinc-700 dark:bg-zinc-900"
        />
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor="docType" className="text-sm font-medium">
            Documents
          </label>
          <select
            id="docType"
            value={docType}
            onChange={(e) => setDocType(e.target.value)}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            {DOC_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span
            className={`ml-auto text-xs ${tooLong ? "text-red-600" : "text-zinc-500"}`}
            aria-live="polite"
          >
            {trimmed.length}/{MAX_CHARS}
          </span>
          <button
            type="submit"
            disabled={loading || tooShort || tooLong}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Searching…" : "Ask"}
          </button>
        </div>
        <p className="text-xs text-zinc-500">Ctrl+Enter to submit.</p>
      </form>

      <section className="mt-8" aria-live="polite" aria-busy={loading}>
        {state.status === "loading" && <LoadingSkeleton />}
        {state.status === "error" && <ErrorBox title={state.title} detail={state.detail} />}
        {state.status === "success" && <Result question={state.question} data={state.data} />}
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

function Result({ question, data }: { question: string; data: AskResponse }) {
  return (
    <div className="space-y-6">
      <p className="text-sm text-zinc-500">
        Question: <span className="text-zinc-800 dark:text-zinc-200">{question}</span>
      </p>

      {data.found ? (
        <>
          <div className="rounded-md border border-zinc-200 bg-white p-4 leading-relaxed whitespace-pre-line dark:border-zinc-800 dark:bg-zinc-900">
            {renderAnswer(data.answer, data.citations)}
          </div>
          <CitationList citations={data.citations} />
        </>
      ) : (
        <NotFound data={data} />
      )}

      <ChunksPanel data={data} />
    </div>
  );
}

/** Turns "[1]", "[2][3]" and "[1, 2]" in the answer into links to the citation list. */
const CITATION_MARKER = /\[(\s*\d{1,2}\s*(?:,\s*\d{1,2}\s*)*)\]/g;

function renderAnswer(text: string, citations: Citation[]): ReactNode[] {
  const byRef = new Map(citations.map((c) => [c.ref, c]));
  const parts: ReactNode[] = [];
  let last = 0;

  for (const match of text.matchAll(CITATION_MARKER)) {
    const start = match.index;
    if (start > last) parts.push(text.slice(last, start));
    const refs = match[1].split(",").map((n) => Number(n.trim()));
    parts.push(
      <sup key={start} className="mx-0.5 whitespace-nowrap">
        {refs.map((ref) => {
          const c = byRef.get(ref);
          if (!c) return <span key={ref}>[{ref}]</span>;
          return (
            <a
              key={ref}
              href={`#citation-${ref}`}
              title={`${c.documentTitle}, ${c.pageLabel}`}
              className="font-medium text-blue-600 hover:underline dark:text-blue-400"
            >
              [{ref}]
            </a>
          );
        })}
      </sup>,
    );
    last = start + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function CitationList({ citations }: { citations: Citation[] }) {
  if (citations.length === 0) return null;
  return (
    <div>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Sources</h2>
      <ol className="mt-2 space-y-2">
        {citations.map((c) => (
          <li
            key={c.ref}
            id={`citation-${c.ref}`}
            className="scroll-mt-4 rounded-md border border-zinc-200 p-3 text-sm target:border-blue-500 target:ring-2 target:ring-blue-500/30 dark:border-zinc-800"
          >
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-semibold text-blue-600 dark:text-blue-400">[{c.ref}]</span>
              <span className="font-medium">{c.documentTitle}</span>
              <DocTypeBadge docType={c.docType} />
            </div>
            <div className="mt-1 text-zinc-600 dark:text-zinc-400">
              {c.pageLabel}
              {c.section && <> · {c.section}</>}
            </div>
            {c.url ? (
              <a
                href={c.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-block text-blue-600 hover:underline dark:text-blue-400"
              >
                Open PDF at {c.pageLabel} ↗
              </a>
            ) : (
              <span className="mt-1 inline-block text-xs text-zinc-500">No PDF link available for this document.</span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function NotFound({ data }: { data: AskResponse }) {
  const { topScore, threshold } = data.retrieval;
  let explanation: string;
  switch (data.notFoundReason) {
    case "below_threshold":
      explanation =
        topScore === null
          ? "No document passages were returned for this question."
          : `None of the document passages are a close enough match to this question (best match ${pct(topScore)}, needs at least ${pct(threshold)}). The question is probably outside what the loaded documents cover.`;
      break;
    case "model_declined":
      explanation =
        "Related passages were found, but none of them actually answers the question, so the assistant declined rather than guess.";
      break;
    case "ungrounded":
      explanation =
        "A draft answer was produced, but it could not be tied to any of the source passages, so it was withheld to avoid giving an unsupported answer.";
      break;
    default:
      explanation = "The answer is not in the available documents.";
  }

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-950/40">
      <p className="font-semibold text-amber-900 dark:text-amber-200">{data.answer}</p>
      <p className="mt-2 text-amber-900/90 dark:text-amber-100/90">{explanation}</p>
      <p className="mt-2 text-amber-900/70 dark:text-amber-100/70">
        Try rephrasing with the terms used in the guidelines
        {data.retrieval.docType ? ", or switch the document filter to “All documents”" : ""}.
      </p>
    </div>
  );
}

function ChunksPanel({ data }: { data: AskResponse }) {
  const { topScore, threshold, topK } = data.retrieval;
  return (
    <details className="rounded-md border border-zinc-200 dark:border-zinc-800">
      <summary className="cursor-pointer select-none px-4 py-2 text-sm font-medium">
        Retrieved passages ({data.chunks.length}) · top score {topScore === null ? "n/a" : topScore.toFixed(3)} ·
        threshold {threshold.toFixed(2)}
      </summary>
      <div className="space-y-3 border-t border-zinc-200 p-4 dark:border-zinc-800">
        {data.chunks.length === 0 && <p className="text-sm text-zinc-500">No passages were retrieved.</p>}
        {data.chunks.map((chunk) => {
          const below = chunk.score < threshold;
          return (
            <article key={chunk.ref} className="text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">[{chunk.ref}]</span>
                <span
                  className={`rounded px-1.5 py-0.5 font-mono text-xs ${
                    below
                      ? "bg-zinc-100 text-zinc-500 dark:bg-zinc-800"
                      : "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200"
                  }`}
                  title={below ? "Below the similarity threshold" : "At or above the similarity threshold"}
                >
                  {chunk.score.toFixed(4)}
                </span>
                {chunk.cited && (
                  <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-800 dark:bg-blue-900/50 dark:text-blue-200">
                    cited
                  </span>
                )}
                <DocTypeBadge docType={chunk.docType} />
                <span className="font-medium">{chunk.documentTitle}</span>
                <span className="text-zinc-500">
                  {chunk.printedPage ? `p. ${chunk.printedPage}` : ""} (PDF p. {chunk.pdfPage})
                </span>
              </div>
              {chunk.section && <div className="mt-1 text-xs text-zinc-500">{chunk.section}</div>}
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-zinc-50 p-2 font-sans text-xs leading-relaxed text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                {chunk.content}
              </pre>
            </article>
          );
        })}
        <p className="text-xs text-zinc-500">
          Top {topK} passages by cosine similarity. Questions whose best score is below the threshold are
          answered “not found” without calling the model.
        </p>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function DocTypeBadge({ docType }: { docType: string }) {
  return (
    <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
      {DOC_TYPE_LABELS[docType] ?? docType}
    </span>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3" role="status">
      <p className="text-sm text-zinc-500">Searching the tax documents and drafting an answer…</p>
      <div className="h-4 w-full animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-4 w-11/12 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-4 w-2/3 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
    </div>
  );
}

function ErrorBox({ title, detail }: { title: string; detail: string | null }) {
  return (
    <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-4 text-sm dark:border-red-800 dark:bg-red-950/40">
      <p className="font-semibold text-red-800 dark:text-red-200">{title}</p>
      {detail && <p className="mt-1 font-mono text-xs text-red-700/80 dark:text-red-300/80">{detail}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pct(score: number) {
  return `${Math.round(score * 100)}%`;
}

/** Plain-language message for a non-2xx response from /api/ask. */
function describeError(status: number, body: unknown): { title: string; detail: string | null } {
  const err =
    typeof body === "object" && body !== null && "error" in body
      ? (body as { error?: { code?: unknown; message?: unknown } }).error
      : undefined;
  const code = typeof err?.code === "string" ? err.code : null;
  const message = typeof err?.message === "string" ? err.message : null;
  const detail = [`HTTP ${status}`, code, message].filter(Boolean).join(" · ");

  if (status === 400) {
    return { title: `Please check your question: ${message ?? "the request was not valid."}`, detail };
  }
  if (status === 504) {
    return {
      title: "The AI service took too long to answer. Please try again; a shorter, more specific question can help.",
      detail,
    };
  }
  if (status === 502) {
    if (code === "gemini_rate_limited") {
      return { title: "The AI service is busy right now (rate limited). Wait a minute and try again.", detail };
    }
    if (code === "database_error") {
      return { title: "Could not search the tax documents because the database did not respond. Try again shortly.", detail };
    }
    return { title: "The AI service returned an error. Please try again in a moment.", detail };
  }
  return { title: `Something went wrong on the server (HTTP ${status}). Please try again.`, detail };
}

function isAskResponse(body: unknown): body is AskResponse {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Partial<AskResponse>;
  return (
    typeof b.found === "boolean" &&
    typeof b.answer === "string" &&
    Array.isArray(b.citations) &&
    Array.isArray(b.chunks) &&
    typeof b.retrieval === "object" &&
    b.retrieval !== null
  );
}

/**
 * Ingestion pipeline: data/tax-docs/*.pdf  ->  Supabase `documents` + `chunks`.
 *
 *   npm run ingest                                   # all files in manifest.json
 *   npm run ingest -- --file <filename.pdf>          # one file
 *   npm run ingest -- --force                        # re-ingest even if unchanged
 *   npm run ingest -- --dry-run [--show 5]           # parse + chunk only, no Gemini, no DB
 *
 * Steps per file: read PDF -> extract text page by page -> strip repeated
 * headers/footers -> detect printed page numbers and headings -> rebuild
 * paragraphs -> pack into ~1,500-char chunks (never crossing a page) ->
 * embed in batches -> replace this document's rows in Supabase.
 *
 * Idempotent: documents are keyed by filename; unchanged files (same SHA-256,
 * same embedding model, previous run completed) are skipped; changed files have
 * their chunks deleted and re-inserted.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { loadEnvConfig } from "@next/env";
import { extractText, getDocumentProxy } from "unpdf";

import { EMBEDDING_MODEL_ID, embedDocuments } from "../src/lib/gemini";
import { getSupabase } from "../src/lib/supabase";

// Load .env the same way Next.js does. Clients read process.env lazily, so this
// only has to run before the first Gemini/Supabase call.
loadEnvConfig(process.cwd());

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const DOCS_DIR = path.join(process.cwd(), "data", "tax-docs");
const MANIFEST_PATH = path.join(DOCS_DIR, "manifest.json");

const CHUNK_TARGET_CHARS = 1500; // aim for ~350 tokens per chunk
const CHUNK_MAX_CHARS = 2000; // hard ceiling for a chunk including overlap
const CHUNK_MIN_CHARS = 500; // don't close a chunk before this unless forced
const OVERLAP_CHARS = 200; // tail of previous chunk repeated at start of next
const MIN_TAIL_CHARS = 300; // a page's last chunk smaller than this merges backwards
const MIN_PAGE_CHARS = 30; // pages with less text than this are skipped

const BOUNDARY_ZONE_LINES = 8; // header/footer search window at top and bottom of each page
const DB_INSERT_BATCH = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ManifestEntry {
  filename: string;
  title: string;
  publisher?: string;
  doc_type: string;
  version?: string | null;
  published_date?: string;
  language?: string;
  source_url?: string;
}

interface PageText {
  pdfPage: number; // 1-based
  printedPage: string | null;
  lines: string[]; // body lines, header/footer removed
}

interface Chunk {
  chunkIndex: number;
  content: string;
  pdfPage: number;
  printedPage: string | null;
  section: string | null;
}

interface ParsedDocument {
  pageCount: number;
  pages: PageText[];
  skippedPages: { pdfPage: number; reason: string }[];
  boilerplateTemplates: string[];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function main() {
  const { values } = parseArgs({
    options: {
      file: { type: "string" },
      force: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      show: { type: "string", default: "2" },
    },
  });
  const dryRun = values["dry-run"]!;
  const showChunks = Number(values.show) || 0;

  const manifest = await loadManifest();
  let entries = manifest;
  if (values.file) {
    const wanted = path.basename(values.file);
    entries = manifest.filter((e) => e.filename === wanted);
    if (entries.length === 0) {
      throw new Error(
        `"${wanted}" is not in manifest.json. Known files:\n  ${manifest.map((e) => e.filename).join("\n  ")}`,
      );
    }
  }

  console.log(
    `${dryRun ? "[dry run] " : ""}Ingesting ${entries.length} file(s) with ${EMBEDDING_MODEL_ID}\n`,
  );

  const failures: string[] = [];
  for (const entry of entries) {
    try {
      await ingestOne(entry, { force: values.force!, dryRun, showChunks });
    } catch (err) {
      failures.push(entry.filename);
      console.error(`  FAILED ${entry.filename}: ${(err as Error).message}\n`);
    }
  }

  if (failures.length > 0) {
    console.error(`${failures.length} file(s) failed: ${failures.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("Done.");
  }
}

async function ingestOne(
  entry: ManifestEntry,
  opts: { force: boolean; dryRun: boolean; showChunks: number },
) {
  console.log(`> ${entry.filename}`);
  const bytes = await readFile(path.join(DOCS_DIR, entry.filename));
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  // 1. Skip if this exact file was already fully ingested with the same model.
  if (!opts.dryRun && !opts.force) {
    const { data: existing, error } = await getSupabase()
      .from("documents")
      .select("file_sha256, embedding_model, ingested_at")
      .eq("filename", entry.filename)
      .maybeSingle();
    if (error) throw new Error(`Looking up document: ${error.message}`);
    if (
      existing?.ingested_at &&
      existing.file_sha256 === sha256 &&
      existing.embedding_model === EMBEDDING_MODEL_ID
    ) {
      console.log("  unchanged since last ingest, skipping (use --force to redo)\n");
      return;
    }
  }

  // 2. Parse and chunk (pure, no network).
  const parsed = await parsePdf(bytes);
  const chunks = chunkDocument(parsed.pages);
  printParseSummary(parsed, chunks, opts.showChunks && opts.dryRun ? opts.showChunks : 0);
  if (chunks.length === 0) throw new Error("No text extracted (scanned PDF without OCR?)");
  if (opts.dryRun) return;

  // 3. Embed everything BEFORE touching the database, so an embedding failure
  //    leaves the previous version of this document intact.
  const vectors = await embedDocuments(
    chunks.map((c) => ({
      title: c.section ? `${entry.title} > ${c.section}` : entry.title,
      text: c.content,
    })),
    (done, total) => process.stdout.write(`\r  embedded ${done}/${total}`),
  );
  process.stdout.write("\n");

  // 4. Upsert the document row by filename. ingested_at = null marks it
  //    "in progress" until every chunk is stored.
  const supabase = getSupabase();
  const { data: doc, error: docError } = await supabase
    .from("documents")
    .upsert(
      {
        filename: entry.filename,
        title: entry.title,
        publisher: entry.publisher ?? null,
        doc_type: entry.doc_type,
        version: entry.version ?? null,
        published_date: entry.published_date ?? null,
        language: entry.language ?? "en",
        source_url: entry.source_url ?? null,
        page_count: parsed.pageCount,
        file_sha256: sha256,
        embedding_model: EMBEDDING_MODEL_ID,
        ingested_at: null,
      },
      { onConflict: "filename" },
    )
    .select("id")
    .single();
  if (docError) throw new Error(`Upserting document: ${docError.message}`);

  // 5. Replace this document's chunks: delete old, insert new in batches.
  const { error: delError } = await supabase.from("chunks").delete().eq("document_id", doc.id);
  if (delError) throw new Error(`Deleting old chunks: ${delError.message}`);

  for (let i = 0; i < chunks.length; i += DB_INSERT_BATCH) {
    const rows = chunks.slice(i, i + DB_INSERT_BATCH).map((c, j) => ({
      document_id: doc.id,
      chunk_index: c.chunkIndex,
      content: c.content,
      pdf_page: c.pdfPage,
      printed_page: c.printedPage,
      section: c.section,
      embedding: vectors[i + j],
    }));
    const { error } = await supabase.from("chunks").insert(rows);
    if (error) throw new Error(`Inserting chunks ${i}-${i + rows.length - 1}: ${error.message}`);
  }

  // 6. Mark complete. Only now will a re-run treat this file as "unchanged".
  const { error: doneError } = await supabase
    .from("documents")
    .update({ ingested_at: new Date().toISOString() })
    .eq("id", doc.id);
  if (doneError) throw new Error(`Marking document ingested: ${doneError.message}`);

  console.log(`  stored ${chunks.length} chunks\n`);
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------
async function loadManifest(): Promise<ManifestEntry[]> {
  const raw = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error("manifest.json must be an array");
  const seen = new Set<string>();
  for (const [i, e] of raw.entries()) {
    for (const key of ["filename", "title", "doc_type"] as const) {
      if (typeof e?.[key] !== "string" || !e[key].trim()) {
        throw new Error(`manifest.json entry ${i} is missing "${key}"`);
      }
    }
    if (seen.has(e.filename)) throw new Error(`manifest.json lists ${e.filename} twice`);
    seen.add(e.filename);
  }
  return raw as ManifestEntry[];
}

// ---------------------------------------------------------------------------
// PDF parsing: text per page, header/footer removal, printed page numbers
// ---------------------------------------------------------------------------
async function parsePdf(bytes: Buffer): Promise<ParsedDocument> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  const { totalPages, text } = await extractText(pdf, { mergePages: false });

  const rawPages = text.map((t) =>
    t
      .replace(/\u0000/g, "") // Postgres text cannot store NUL bytes
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter((l) => l.length > 0),
  );

  // Header/footer lines repeat on most pages, usually with only digits changing
  // ("Page 3 of 65", "Page 4 of 65"). Compare lines with digits masked.
  const boilerplate = findBoilerplateTemplates(rawPages);
  const printedPages = detectPrintedPages(rawPages, boilerplate);

  const pages: PageText[] = [];
  const skippedPages: ParsedDocument["skippedPages"] = [];

  rawPages.forEach((lines, i) => {
    const pdfPage = i + 1;
    const body = lines.filter(
      (line, idx) => !(inBoundaryZone(idx, lines.length) && boilerplate.has(template(line))),
    );
    if (isTableOfContents(body)) {
      skippedPages.push({ pdfPage, reason: "table of contents" });
      return;
    }
    if (body.join(" ").length < MIN_PAGE_CHARS) {
      skippedPages.push({ pdfPage, reason: "no meaningful text" });
      return;
    }
    pages.push({ pdfPage, printedPage: printedPages[i], lines: body });
  });

  return {
    pageCount: totalPages,
    pages,
    skippedPages,
    boilerplateTemplates: [...boilerplate],
  };
}

function template(line: string): string {
  return line.toLowerCase().replace(/\d+/g, "#");
}

function inBoundaryZone(index: number, total: number): boolean {
  return index < BOUNDARY_ZONE_LINES || index >= total - BOUNDARY_ZONE_LINES;
}

/** Digit-masked lines that appear near the top/bottom of at least half the pages. */
function findBoilerplateTemplates(pages: string[][]): Set<string> {
  const threshold = Math.max(3, Math.ceil(pages.length * 0.5));
  const pageCount = new Map<string, number>();
  for (const lines of pages) {
    const seen = new Set<string>();
    lines.forEach((line, idx) => {
      if (inBoundaryZone(idx, lines.length)) seen.add(template(line));
    });
    for (const t of seen) pageCount.set(t, (pageCount.get(t) ?? 0) + 1);
  }
  return new Set([...pageCount].filter(([, n]) => n >= threshold).map(([t]) => t));
}

const PAGE_NUMBER_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: "page-n-of-m", regex: /\bpage\s+(\d{1,4})\s+of\s+\d{1,4}\b/i },
  { name: "bare-number", regex: /^(\d{1,4})$/ },
  { name: "trailing-number", regex: /\s(\d{1,4})$/ },
];

/**
 * Finds the number printed on each page. Candidates come from boilerplate lines
 * in the header/footer zone. A candidate is only accepted if it is part of a
 * sequence: the previous page shows n-1 or the next page shows n+1. This rejects
 * constants like years ("As at 13 October 2020") and stray table numbers.
 * The pattern (per line template) that explains the most pages wins.
 */
function detectPrintedPages(pages: string[][], boilerplate: Set<string>): (string | null)[] {
  // candidates.get(key)[pageIndex] = numbers found on that page for that key
  const candidates = new Map<string, number[][]>();
  pages.forEach((lines, pageIdx) => {
    lines.forEach((line, idx) => {
      const t = template(line);
      if (!inBoundaryZone(idx, lines.length) || !boilerplate.has(t)) return;
      for (const { name, regex } of PAGE_NUMBER_PATTERNS) {
        const m = line.match(regex);
        if (!m) continue;
        const key = `${name}|${t}`;
        if (!candidates.has(key)) candidates.set(key, pages.map(() => []));
        candidates.get(key)![pageIdx].push(Number(m[1]));
      }
    });
  });

  let best: (number | null)[] = pages.map(() => null);
  let bestCount = 0;
  for (const perPage of candidates.values()) {
    const accepted = perPage.map((nums, i) => {
      const prev = perPage[i - 1] ?? [];
      const next = perPage[i + 1] ?? [];
      return nums.find((n) => prev.includes(n - 1) || next.includes(n + 1)) ?? null;
    });
    const count = accepted.filter((n) => n !== null).length;
    if (count > bestCount) {
      best = accepted;
      bestCount = count;
    }
  }
  return best.map((n) => (n === null ? null : String(n)));
}

/**
 * Contents pages list section titles, so they match questions strongly but contain
 * no answers. Detected by dot leaders ("INTRODUCTION ...... 1"), or by a
 * "CONTENTS" title with most lines ending in a page number ("1. Objective 1").
 */
function isTableOfContents(lines: string[]): boolean {
  const leaderLines = lines.filter((l) => /(\.\s?){5,}\s*\d{1,4}$/.test(l)).length;
  if (leaderLines >= 5 && leaderLines >= lines.length * 0.4) return true;
  const hasTitle = lines.slice(0, 5).some((l) => /^(table of )?contents( page)?$/i.test(l));
  const numberedLines = lines.filter((l) => /\s\d{1,3}$/.test(l)).length;
  return hasTitle && numberedLines >= lines.length * 0.4;
}

// ---------------------------------------------------------------------------
// Structure: headings and paragraphs
// ---------------------------------------------------------------------------
interface Heading {
  level: number;
  number: number | null; // top-level number for numbered headings ("5" for "5.2.1")
  label: string;
  numbered: boolean;
}

/** Heading state carried across pages of one document. */
interface HeadingState {
  stack: Heading[];
  lastTopNumber: number; // highest accepted top-level heading number
  lastCandidate: { number: number; accepted: boolean } | null; // previous top-level candidate
  upperCaseTopLevel: boolean; // document's real top-level headings are UPPER CASE
}

const TITLE_CASE_LOWER_WORDS = new Set(
  "a an and as at by for from in into of on or per the to under upon via with".split(" "),
);

const NUMBERED_HEADING = /^(\d{1,2}(?:\.\d{1,2}){0,3})(\.?)\s+(\S.*)$/;

function detectHeading(line: string): Heading | null {
  if (line.length > 100 || /(\.\s?){5,}/.test(line)) return null;

  const m = line.match(NUMBERED_HEADING);
  if (m) {
    const [, number, dot, rest] = m;
    const dotted = number.includes(".");
    if (!dotted && !dot) return null; // "12 months" is not a heading; "5. Gifts" is
    if (!/^[A-Z]/.test(rest) || /[.,;:]$/.test(rest) || rest.length > 80) return null;
    // Title case: every lowercase word must be a short function word, so
    // "Scenarios and Types of e-Invoices" passes but a wrapped sentence such as
    // "Inland Revenue Board of Malaysia (IRBM) has issued the e-Invoice" does not.
    const words = rest.split(" ").map((w) => w.replace(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, ""));
    const isTitleCase = words.every(
      (w) => w === "" || !/^\p{Ll}/u.test(w) || TITLE_CASE_LOWER_WORDS.has(w) || /^e-\p{Lu}/u.test(w),
    );
    if (!isTitleCase) return null;
    // "2.0 Getting Ready" is a top-level heading: ignore trailing ".0" parts.
    const parts = number.split(".").filter(Boolean);
    while (parts.length > 1 && parts[parts.length - 1] === "0") parts.pop();
    return {
      level: parts.length,
      number: Number(parts[0]),
      label: `${number}${dot} ${rest}`,
      numbered: true,
    };
  }

  // ALL-CAPS heading, e.g. "INTRODUCTION", "SERVICE TAX DUE ON IMPORTED SERVICES".
  // Lines with digits are excluded: those are usually table rows ("TOTAL ASSETS 26,050").
  const letters = line.replace(/[^A-Za-z]/g, "");
  if (
    letters.length >= 4 &&
    !/\d/.test(line) &&
    letters === letters.toUpperCase() &&
    line.length <= 80 &&
    !/[.,;:]$/.test(line) &&
    line.split(" ").filter((w) => /[A-Z]{3,}/.test(w)).length >= 1
  ) {
    return { level: 1, number: null, label: line, numbered: false };
  }
  return null;
}

const isUpperCase = (s: string) => s === s.toUpperCase() && /[A-Z]/.test(s);

/**
 * Detects headings for every line, then demotes runs of 2+ consecutive numbered
 * "headings" at the same level with no body text between them: those are list or
 * table rows ("1. API Application Programming Interface", "2. B2B Business-to-Business").
 */
function detectHeadings(lines: string[]): (Heading | null)[] {
  const headings = lines.map(detectHeading);
  for (let i = 0; i < headings.length; ) {
    const h = headings[i];
    let j = i + 1;
    while (h?.numbered && headings[j]?.numbered && headings[j]!.level === h.level) j++;
    if (j - i >= 2) for (let k = i; k < j; k++) headings[k] = null;
    i = j;
  }
  // An upper-case heading that wraps onto following lines ("9. TRANSACTIONS ... TO" /
  // "AGENTS, DEALERS OR DISTRIBUTORS" / "WITH INDIVIDUALS"): merge them into one.
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (!h || !isUpperCase(h.label)) continue;
    for (let k = i + 1; k < headings.length; k++) {
      const next = headings[k];
      if (!next || next.numbered || !isUpperCase(next.label)) break;
      h.label = `${h.label} ${next.label}`;
      headings[k] = null;
      lines[k] = ""; // consumed into the heading line
    }
  }
  return headings;
}

/**
 * Decides whether a top-level numbered heading is real or a numbered list item:
 *  - Style: if most top-level candidates in this document are UPPER CASE
 *    ("4. STATEMENTS OR BILLS"), Title Case ones ("1. Online Platform") are list items.
 *  - Sequence: top-level numbers must move forward. "2. Divorced" after
 *    "6. Allowable Deduction" is a list item, as is a "4." that continues a run of
 *    rejected "1., 2., 3." items.
 * Set DEBUG_HEADINGS=1 to print every decision.
 */
function acceptHeading(h: Heading, state: HeadingState): boolean {
  if (!h.numbered || h.level > 1 || h.number === null) return true;
  const wrongStyle = state.upperCaseTopLevel && !isUpperCase(h.label);
  const continuesRejectedList =
    state.lastCandidate !== null &&
    !state.lastCandidate.accepted &&
    state.lastCandidate.number === h.number - 1;
  const accepted = !wrongStyle && h.number > state.lastTopNumber && !continuesRejectedList;
  if (process.env.DEBUG_HEADINGS) console.log(`    [heading ${accepted ? "accept" : "reject"}] ${h.label}`);
  if (!wrongStyle) state.lastCandidate = { number: h.number, accepted };
  if (accepted) state.lastTopNumber = h.number;
  return accepted;
}

/** True if most top-level numbered heading candidates in the document are UPPER CASE. */
function prefersUpperCaseTopLevel(pages: PageText[]): boolean {
  const topLevel = pages
    .flatMap((p) => detectHeadings([...p.lines]))
    .filter((h): h is Heading => !!h && h.numbered && h.level === 1);
  const upper = topLevel.filter((h) => isUpperCase(h.label)).length;
  return upper >= 3 && upper >= topLevel.length * 0.6;
}

const NEW_ITEM_MARKER =
  /^(\d{1,2}\.\s+\S|\d{1,2}(\.\d{1,2}){1,3}\.?\s+\S|\(?([a-z]{1,4}|\d{1,2})\)\s+\S|[•●▪◦·*\-–—]\s+\S)/i;

function startsNewParagraph(line: string, previous: string | undefined): boolean {
  if (previous === undefined) return true;
  if (NEW_ITEM_MARKER.test(line)) return true;
  return /[.:;!?]["”’)]?$/.test(previous) && /^[A-Z(“"]/.test(line);
}

interface Block {
  text: string;
  isHeading: boolean;
  section: string | null; // section in effect for this block
}

/** Turns one page's lines into paragraph/heading blocks, updating the heading stack across pages. */
function toBlocks(pageLines: string[], state: HeadingState): Block[] {
  const lines = [...pageLines];
  const { stack } = state;
  const blocks: Block[] = [];
  let current: string[] = [];
  const sectionLabel = () => (stack.length ? stack.map((h) => h.label).join(" > ").slice(0, 200) : null);
  const flush = () => {
    if (current.length) blocks.push({ text: joinLines(current), isHeading: false, section: sectionLabel() });
    current = [];
  };

  const headings = detectHeadings(lines);
  lines.forEach((line, i) => {
    if (line === "") return; // merged into the previous heading
    const heading = headings[i];
    if (heading && acceptHeading(heading, state)) {
      flush();
      while (stack.length && stack[stack.length - 1].level >= heading.level) stack.pop();
      stack.push(heading);
      blocks.push({ text: heading.label, isHeading: true, section: sectionLabel() });
      return;
    }
    if (startsNewParagraph(line, current.length ? lines[i - 1] : undefined)) flush();
    // A rejected heading stays as body text (its label includes any merged wrapped lines).
    current.push(heading ? heading.label : line);
  });
  flush();
  return blocks;
}

/** Joins wrapped lines; "e-" + "Invoice" becomes "e-Invoice" rather than "e- Invoice". */
function joinLines(lines: string[]): string {
  return lines.reduce((acc, line) => (/[A-Za-z]-$/.test(acc) ? acc + line : `${acc} ${line}`));
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------
function chunkDocument(pages: PageText[]): Chunk[] {
  const chunks: Chunk[] = [];
  // Headings carry over from page to page.
  const state: HeadingState = {
    stack: [],
    lastTopNumber: 0,
    lastCandidate: null,
    upperCaseTopLevel: prefersUpperCaseTopLevel(pages),
  };

  for (const page of pages) {
    const blocks = toBlocks(page.lines, state).flatMap((b) => splitOversized(b));
    for (const piece of packBlocks(blocks)) {
      chunks.push({
        chunkIndex: chunks.length,
        content: piece.content,
        pdfPage: page.pdfPage,
        printedPage: page.printedPage,
        section: piece.section,
      });
    }
  }
  return chunks;
}

/** Splits a block longer than the per-unit limit by sentences, then by words. */
function splitOversized(block: Block): Block[] {
  const limit = CHUNK_MAX_CHARS - OVERLAP_CHARS;
  if (block.text.length <= limit) return [block];
  const sentences = block.text.split(/(?<=[.!?;])\s+(?=[A-Z(“"])/);
  const pieces: string[] = [];
  let current = "";
  for (const s of sentences.flatMap((s) => (s.length > limit ? splitByWords(s, limit) : [s]))) {
    if (current && current.length + 1 + s.length > limit) {
      pieces.push(current);
      current = s;
    } else {
      current = current ? `${current} ${s}` : s;
    }
  }
  if (current) pieces.push(current);
  return pieces.map((text) => ({ ...block, text }));
}

function splitByWords(text: string, limit: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (current && current.length + 1 + word.length > limit) {
      out.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Greedily packs one page's blocks into chunks of ~CHUNK_TARGET_CHARS. Each new
 * chunk starts with the last ~OVERLAP_CHARS of the previous one so a sentence
 * cut at a boundary is still found whole in at least one chunk.
 */
function packBlocks(blocks: Block[]): { content: string; section: string | null }[] {
  const out: { content: string; section: string | null; newText: string }[] = [];
  let units: Block[] = [];
  let overlap = "";

  const textOf = (us: Block[]) => us.map((u) => u.text).join("\n\n");
  const lengthWith = (extra: Block) =>
    (overlap ? overlap.length + 2 : 0) + textOf([...units, extra]).length;

  const emit = () => {
    // Never end a chunk on a heading: carry it into the next chunk with its body.
    let carry: Block[] = [];
    if (units.length > 1 && units[units.length - 1].isHeading) carry = [units.pop()!];
    const newText = textOf(units);
    const content = overlap ? `${overlap}\n\n${newText}` : newText;
    out.push({ content, section: units[0].section, newText });
    overlap = tailForOverlap(newText);
    units = carry;
  };

  for (const block of blocks) {
    if (units.length > 0) {
      const size = lengthWith(block);
      const currentSize = lengthWith({ ...block, text: "" });
      if ((size > CHUNK_TARGET_CHARS && currentSize >= CHUNK_MIN_CHARS) || size > CHUNK_MAX_CHARS) {
        emit();
      }
    }
    units.push(block);
  }
  if (units.length > 0) {
    const newText = textOf(units);
    const prev = out[out.length - 1];
    // A small leftover at the end of a page is merged into the previous chunk if it fits.
    if (prev && newText.length < MIN_TAIL_CHARS && prev.content.length + 2 + newText.length <= CHUNK_MAX_CHARS) {
      prev.content = `${prev.content}\n\n${newText}`;
      prev.newText = `${prev.newText}\n\n${newText}`;
    } else {
      out.push({ content: overlap ? `${overlap}\n\n${newText}` : newText, section: units[0].section, newText });
    }
  }
  return out.map(({ content, section }) => ({ content, section }));
}

/** Last ~OVERLAP_CHARS of text, starting at a sentence (or at least a word) boundary. */
function tailForOverlap(text: string): string {
  if (text.length <= OVERLAP_CHARS) return "";
  const tail = text.slice(-OVERLAP_CHARS);
  const sentence = tail.search(/[.!?;]\s+\S/);
  if (sentence !== -1 && sentence < tail.length - 40) {
    return tail.slice(sentence + 1).trim();
  }
  const space = tail.indexOf(" ");
  return "… " + tail.slice(space + 1).trim();
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
function printParseSummary(parsed: ParsedDocument, chunks: Chunk[], show: number) {
  const sizes = chunks.map((c) => c.content.length);
  const withPrinted = parsed.pages.filter((p) => p.printedPage !== null).length;
  const offsets = [
    ...new Set(
      parsed.pages
        .filter((p) => p.printedPage !== null && /^\d+$/.test(p.printedPage))
        .map((p) => p.pdfPage - Number(p.printedPage)),
    ),
  ];
  console.log(
    `  pages: ${parsed.pageCount} (kept ${parsed.pages.length}, skipped ${parsed.skippedPages.length}` +
      (parsed.skippedPages.length
        ? `: ${parsed.skippedPages.map((s) => `p${s.pdfPage} ${s.reason}`).join(", ")}`
        : "") +
      ")",
  );
  console.log(`  header/footer lines removed: ${parsed.boilerplateTemplates.length} distinct`);
  console.log(
    `  printed page numbers: ${withPrinted}/${parsed.pages.length} kept pages` +
      (offsets.length ? ` (PDF page minus printed page = ${offsets.join(", ")})` : ""),
  );
  if (chunks.length) {
    console.log(
      `  chunks: ${chunks.length}, chars min/avg/max ${Math.min(...sizes)}/` +
        `${Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length)}/${Math.max(...sizes)}, ` +
        `with section: ${chunks.filter((c) => c.section).length}`,
    );
  }
  for (const c of chunks.slice(0, show)) {
    console.log(
      `  --- chunk ${c.chunkIndex} | pdf p${c.pdfPage} | printed ${c.printedPage ?? "-"} | ${c.section ?? "(no section)"}`,
    );
    console.log(`  ${c.content.slice(0, 400).replace(/\n/g, "\n  ")}${c.content.length > 400 ? " …" : ""}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

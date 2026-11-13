# Phase 1, Step A: Claude Code's full response

Verbatim response from Claude Code to the Phase 1 prompt (see [AI_USAGE.md](../../AI_USAGE.md)), before any code was written.

---

# Step A: Phase 1 decisions

I read ARCHITECTURE.md, the manifest, AGENTS.md and the variable names in `.env`. I never displayed any secret values. I also opened the PDFs and made one test call per embedding model, so the numbers below are measured, not guessed.

**What the documents look like:** 5 PDFs, about 300 pages and 60,000 words in total.

| File | PDF pages | Words |
|---|---|---|
| e-Invoice Guideline v4.8 | 62 | 10.4k |
| e-Invoice Specific Guideline v4.9 | 138 | 23.5k |
| Public Ruling 4/2026 | 15 | 4.3k |
| Public Ruling 7/2025 | 68 | 17.7k |
| SST Return & Payment guide | 17 | 3.8k |

**⚠️ Two things to fix in `.env` before Step B can run:**
- **`SUPABASE_URL` is wrong.** It's the dashboard address (`https://supabase.com/dashboard/project/...`), not the API address. It needs to be `https://<project-ref>.supabase.co`, which you'll find under Project Settings → Data API.
- **`SUPABASE_SERVICE_ROLE_KEY` is fine.** It already holds a new-style secret key (`sb_secret_...`), which `@supabase/supabase-js` accepts in that slot. I'll keep the variable name unless you'd rather rename it to `SUPABASE_SECRET_KEY`.

---

## 1. PDF parsing library (must keep page boundaries)

| Option | Pros | Cons |
|---|---|---|
| **A. `unpdf`** | Small, modern wrapper around Mozilla's pdf.js, built for Node and serverless. `extractText(pdf, { mergePages: false })` returns one string per page, and it gives low-level pdf.js access if we ever need it. | Gives plain text only, without fonts or positions, unless we drop down to pdf.js. |
| **B. `pdfjs-dist` directly** | Full control: every text item comes with x/y position and font size. That lets us detect headings by font size and strip headers and footers by position. | Much more code (grouping items into lines, worker setup, ESM quirks in Node). Too much for 5 documents. |
| **C. `pdf-parse`** | Most popular and well known. | v1 merges all pages unless you write a custom callback, and it's barely maintained. v2 is a rewrite with a different API. Its main advantage over A is familiarity. |

**Recommendation: A (`unpdf`).** It handles page boundaries out of the box, and if heading detection turns out to need font sizes, it can still reach pdf.js.

## 2. Chunk size, overlap and splitting strategy

Note on units: Gemini's tokenizer isn't available offline, so I'd measure chunks in **characters** (fast and repeatable). English text averages about 4 characters per token.

| Option | Pros | Cons |
|---|---|---|
| **A. Fixed size** (e.g. 1,000 chars, 150 overlap) | Simplest, predictable chunk count. | Cuts mid-sentence and mid-table. A rule like "return due by…" can lose its subject. |
| **B. Paragraph/sentence-aware, within each page** (target ~1,500 chars ≈ 350 tokens, max ~2,000, ~200-char overlap). Splits on blank lines, then sentence ends, then words. Records the nearest numbered heading (e.g. `3.2 …`, `INTRODUCTION`) as `section`. | Chunks are coherent, and each chunk belongs to exactly one page, so citations are exact. Gives roughly 400–600 chunks for this corpus. | A paragraph that runs over a page break gets split in two. The overlap only partly makes up for that. Heading detection is a best-effort guess, so `section` can be empty. |
| **C. Structure-first** (split by detected section, then sub-split large sections) | Each chunk follows the document's own logic. | Each of the 5 PDFs formats headings differently, so detection would be fragile. Sections also cross pages, so a chunk would need a page range. |

**Recommendation: B.** I'd also add a small, cheap retrieval improvement: when embedding, put the document title and section in front of the chunk text (e.g. `"SST Guide on Return and Payment > SALES TAX AND SERVICE TAX DUE\n\n…"`). Without this, a chunk that only says "the taxable person shall…" doesn't say which tax it's about. The `content` column stores the clean text without that prefix.

## 3. Embedding model and vector dimension

Your key has access to three embedding models. I tested two of them:

| Model | Max input | Default dimension | Truncated dimensions come back normalised? |
|---|---|---|---|
| `gemini-embedding-001` | 2,048 tokens | 3072 | **No** (1536 → norm 0.695). We'd have to normalise them ourselves. |
| `gemini-embedding-2` (GA) | 8,192 tokens | 3072 | **Yes** (norm 1.000 at 768 and 1536) |
| `gemini-embedding-2-preview` | 8,192 tokens | n/a | Not tested. It's a preview and can change or be removed, so I'd skip it. |

**pgvector limit:** its HNSW and IVFFlat indexes support at most **2,000 dimensions** on the `vector` type. So 3072 would need either the `halfvec` type or no index. That leaves these options:

- **A. `gemini-embedding-2` at 1536 → `vector(1536)`.** Close to full quality, indexable, and storage is trivial for about 600 rows.
- **B. `gemini-embedding-2` at 768 → `vector(768)`.** Half the size, slightly lower quality. Storage and speed don't matter at this scale, so there's little reason to go smaller.
- **C. `gemini-embedding-001` at 3072 → `halfvec(3072)`.** Older model with a short 2k-token input limit, plus the extra `halfvec` complexity.

**Recommendation: A.** The rule that matters later: **questions must be embedded with the same model and dimension as the chunks.** I'll put both in one constant in `gemini.ts`. Before writing that file, I'll also check how `gemini-embedding-2` expects document and query task types to be passed. The older `task_type` parameter worked on 001; I'll confirm against the live API rather than assume.

## 4. Citations: PDF page index, printed page number, or both

From the documents themselves, the offset between the two varies:
- **No offset:** e-Invoice Guideline (footer `6` on PDF page 6) and PR 4/2026 (`Page 6 of 15`).
- **Offset of 3:** PR 7/2025 (PDF page 6 shows `Page 3 of 65`) and the SST guide (printed page 1 is PDF page 4, after the cover, publication and contents pages).

| Option | Pros | Cons |
|---|---|---|
| **A. PDF page index only** | Always correct and deterministic. Can deep-link straight to the page (`source_url#page=4`). | "Page 4" won't match what a reader sees printed on that page in 2 of the 5 documents. |
| **B. Printed page only** | Matches the document. | Has to be read from footers with per-format patterns (`Page N of M`, a bare trailing number, `… Department 1`). Cover and contents pages have none, and extraction can fail silently. |
| **C. Both:** `pdf_page int NOT NULL` + `printed_page text NULL` | A reliable link plus a human-friendly label, e.g. "SST Guide, p. 1 (PDF p. 4)". The label falls back to the PDF page when no printed number is found. Stored as text in case of roman numerals. | Two columns, plus a footer-detection heuristic. I'd check it by confirming the detected numbers rise by 1 from page to page, and store null when they don't. |

**Recommendation: C.** (An alternative to detection is a manual `page_offset` per document in the manifest. It's simpler, but breaks when numbering restarts partway through a document.)

## 5. Store `published_date` and `version` on `documents`?

| Option | Pros | Cons |
|---|---|---|
| **A. Yes, plus the other manifest fields:** `filename` (unique), `publisher`, `version text`, `published_date date`, `language`, and a `file_sha256` | Tax guidance goes out of date, so answers can say "per e-Invoice Guideline v4.8 (30 Aug 2026)". Later we can rank or filter by recency. `filename` + hash is what makes re-running safe: same hash means skip, changed hash means replace that document's chunks. | A few more columns. |
| **B. Only what ARCHITECTURE.md lists now** | Matches the current diagram. | Loses information that matters for tax questions, and leaves re-runs without a natural key to avoid duplicates. |
| **C. Store the manifest entry as one `metadata jsonb` column** | Flexible. | Harder to query and constrain, and it hides fields the prompt will need. |

**Recommendation: A.** One thing to be aware of: in the manifest, `version` doesn't mean the same thing for every document. For the e-Invoice guidelines it's a revision (`4.8`); for the Public Rulings it's the ruling number (`4`, `7`). It's harmless if we only display it, but you might want to rename it, or add a separate `ruling_no`.

---

**Summary of my recommendations:**
1. `unpdf`
2. Paragraph-aware chunks of ~1,500 characters with ~200 overlap, kept within one page, with a title/section prefix for embedding
3. `gemini-embedding-2` at 1536 dimensions with an HNSW cosine index
4. Store both page numbers
5. Add the manifest fields plus `filename` and `file_sha256`

You can reply with "all recommended" or override any number. I'll wait for your decisions, and the `.env` URL fix, before writing any code.

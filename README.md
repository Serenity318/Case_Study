# taxPOD CRM

## Project Overview

A small CRM (contacts/leads, an opportunities Kanban board and a dashboard) with a **Tax Q&A** assistant that answers questions about Malaysian e-Invoice, income tax and SST using only five official LHDN and RMCD documents, with page-level citations.

- **Stack:** Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, Supabase Postgres with pgvector, Google Gemini (`gemini-embedding-2` for embeddings, `gemini-3.5-flash-lite` for answers).
- **Design and evaluation:** see [ARCHITECTURE.md](ARCHITECTURE.md). How AI tools were used: [AI_USAGE.md](AI_USAGE.md).

## Prerequisites

- **Node.js 20.9 or later** (required by Next.js 16; developed on Node 22) and npm.
- **Git.**
- **A Supabase project** (the free tier is enough). The migration enables the `vector` extension for you.
- **A Gemini API key** from [Google AI Studio](https://aistudio.google.com/apikey) (the free tier is enough; see the rate-limit notes below).

> **Windows / PowerShell:** use `npm.cmd` and `npx.cmd` instead of `npm` and `npx`. PowerShell's default execution policy blocks the `npm.ps1` / `npx.ps1` wrappers with *"running scripts is disabled on this system"*; the `.cmd` versions do the same thing without changing the policy. To pass options to a script, put them after `--`, e.g. `npm.cmd run ingest -- --dry-run`. On macOS/Linux, drop the `.cmd`. The commands below use the PowerShell form.

## Setup

```powershell
git clone https://github.com/Serenity318/Case_Study.git
cd Case_Study
npm.cmd install
```

## Environment Variables

Create `.env` from the template, then fill in the three values:

```powershell
Copy-Item .env.example .env
notepad .env
```

| Variable | Where to find it | Notes |
|---|---|---|
| `GEMINI_API_KEY` | Google AI Studio → API keys | Server-side only. |
| `SUPABASE_URL` | Supabase → Project Settings → Data API → Project URL | Must be the bare API URL, `https://<project-ref>.supabase.co`. The dashboard address (`https://supabase.com/dashboard/project/...`) or a URL ending in `/rest/v1` is rejected with an error on the first database call. |
| `SUPABASE_SECRET_KEY` | Supabase → Project Settings → API Keys → Secret key (`sb_secret_...`) | Bypasses Row Level Security. Used only on the server and in scripts; never put it in a `NEXT_PUBLIC_` variable. |

`.env` is git-ignored. Next.js and the scripts both load it automatically.

## Database Setup

Run the two migrations **in order** in the Supabase dashboard → **SQL Editor** → New query → paste the file's contents → **Run**:

1. **`supabase/migrations/0001_init.sql`**: enables pgvector and creates the `contacts`, `opportunities`, `documents` and `chunks` tables, the `updated_at` triggers, the HNSW vector index, and Row Level Security (enabled with no policies, so the public API key can read nothing).
2. **`supabase/migrations/0002_match_chunks.sql`**: creates the `match_chunks()` similarity-search function used by the Tax Q&A, executable only by the server's secret key.

Both files are safe to re-run. If the Tax Q&A later reports *"Search function match_chunks not found"*, migration 0002 has not been run.

## Ingesting the Documents

The five PDFs and their metadata are already in `data/tax-docs/` (`manifest.json` lists them). Parse, chunk, embed and store them:

```powershell
npm.cmd run ingest
```

- Produces about 315 chunks and takes a few minutes; progress is printed per file.
- **Safe to re-run:** files that are unchanged since a completed run (same file hash and embedding model) are skipped.
- Options:
  - `npm.cmd run ingest -- --file lhdn-public-ruling-4-2026.pdf` ingests one file
  - `npm.cmd run ingest -- --force` re-ingests even if unchanged
  - `npm.cmd run ingest -- --dry-run --show 5` parses and chunks only (no Gemini, no database) and prints 5 sample chunks
- On the Gemini free tier, a rate-limit error is retried automatically with backoff. If the **daily** quota is exhausted, the affected files fail with a quota error (the run exits with code 1 and lists them); re-run the next day and completed files are skipped.

## Seeding Sample CRM Data

```powershell
npm.cmd run seed
```

Inserts 10 contacts and 12 opportunities for fictional Malaysian companies (emails use the reserved `.example` domain). Safe to re-run: existing sample rows are skipped. `npm.cmd run seed -- --reset` deletes the sample contacts and their opportunities first; contacts you created yourself are never touched.

## Running the App

```powershell
npm.cmd run dev
```

Open http://localhost:3000. The navigation bar links to:

- **Dashboard** (`/`): total contacts, open opportunities, total value in RM, pipeline by stage, recent activity.
- **Leads** (`/leads`): search by name, email or company, filter by status, create, edit and delete contacts.
- **Opportunities** (`/opportunities`): Kanban board by stage; change a card's stage with its dropdown; create, edit and delete.
- **Tax Q&A** (`/ask`).

For a production build: `npm.cmd run build`, then `npm.cmd run start`.

## Using the Tax Q&A (RAG)

Type a question, optionally restrict it to one document type (e-Invoice, Income tax or SST), and press **Ask** (or Ctrl+Enter). Answers cite their sources as `[1]`, `[2]`: click a marker to jump to the source, then **Open PDF** to open the official document at that page. **Retrieved passages** shows the five chunks that were searched and their similarity scores.

Questions to try (from the evaluation set):

| Question | Expected |
|---|---|
| When must a buyer issue a self-billed e-invoice? | Answer from the e-Invoice Specific Guideline |
| What is the maximum value of a small value asset? | Answer from Public Ruling 4/2026 |
| When must the SST-02 return be submitted? | Answer from the SST Guide on Return and Payment |
| My Sdn Bhd only brings in around RM1.2 million a year, which is well under the RM3 million threshold. Are we still exempt from issuing e-Invoices if our holding company makes over RM5 million annually? | No: the exemption does not apply to a subsidiary of a holding company with turnover of at least RM3 million (e-Invoice Guideline) |
| My company sells commercial trailers, and one of our buyers said they don't need an e-Invoice. Can I just bundle that sale into my monthly consolidated e-Invoice instead? | No: consolidated e-Invoices are not allowed for motor vehicles, which include trailers (e-Invoice Specific Guideline) |
| What is the corporate tax rate for SMEs in Malaysia? | **Not found**: Malaysian tax, but not covered by the five documents |
| How do I bake a chocolate cake? | **Not found**: off-topic, refused without calling the model |

## Running the Evaluation

```powershell
npm.cmd run eval
```

- Runs every question in `eval/questions.json` through the same pipeline as the Tax Q&A and writes `eval/results.md`: hit@5 and hit@1 for answerable questions, the correct-refusal rate for unanswerable ones, and a per-question table.
- Takes about 10 seconds per question: it pauses 8 seconds between questions to stay within Gemini free-tier limits, and retries once after 60 seconds on a rate-limit error.
- **`eval/results.md` is overwritten on every run.** The earlier run at threshold 0.73 is kept in `eval/results-threshold-0.73.md`.
- Options: `npm.cmd run eval -- --delay 15` (longer pause), `npm.cmd run eval -- --only q3` (one question).
- Question format: `{ "id": "q1", "question": "...", "expectedDoc": "<filename in data/tax-docs> or null if the documents should not answer it", "notes": "..." }`.

Results and their interpretation are in [ARCHITECTURE.md → Evaluation Results](ARCHITECTURE.md#evaluation-results).

## Demo

TODO

## Tools Used

- **Claude (desktop app):** understanding the brief and RAG concepts, planning the architecture, writing prompts for Claude Code, and reviewing Claude Code's output before I acted on it.
- **Claude Code:** scaffolding the project, writing the schema and ingestion code, and running tests and checks.
- No other AI tools.

**My workflow:** I ask Claude Code for options before it writes any code, paste its response into Claude (desktop) for review, make my decisions, and then send them back to Claude Code.

## Real Example

### Prompt

```
Read ARCHITECTURE.md, data/tax-docs/manifest.json, AGENTS.md and .env (never print secret values). We are building Phase 1 only: the database schema and the document ingestion pipeline.

STEP A: Do not write any code yet. Present each of these decisions to me with 2-3 options, the trade-offs of each, and your recommendation, then STOP and wait for my reply:
1. PDF parsing library for Node/TypeScript that preserves page boundaries.
2. Chunk size and overlap (in tokens or characters), and whether to split on headings/paragraphs or by fixed size.
3. Which of my available Gemini embedding models to use, and its vector dimension.
4. Citations: store the PDF page index, the printed page number, or both (these differ because of cover and contents pages).
5. Whether the documents table should include published_date and version from the manifest.

STEP B: After I reply with my decisions:
1. Write supabase/migrations/0001_init.sql: enable the vector extension, then create contacts, opportunities, documents and chunks per ARCHITECTURE.md plus my decisions, with a suitable vector index. Explain every table, column and index in plain language. I will run it in the Supabase SQL editor myself.
2. Implement src/lib/supabase.ts (server-only client using the secret key) and src/lib/gemini.ts (embedding call), and implement scripts/ingest.ts: read the manifest, parse each PDF page by page, chunk with page metadata, embed in batches with retry and backoff on rate-limit errors, and insert documents and chunks. Re-running it must not create duplicates. Support a flag to ingest a single file.
3. After each file, explain in plain language what it does, why it is built that way, and what could go wrong. Assume I know Java/Spring and React but have never built RAG.
4. Do NOT edit AI_USAGE.md. In ARCHITECTURE.md, only update the Data Model to match the final schema; leave all other TODOs to me.
5. Do not run ingestion on all files. Tell me the exact command to ingest only the SST guide. Do not commit.
```

### Output

In Step A, Claude Code presented the five decisions, each with options, trade-offs and a recommendation:

1. **PDF parsing:** `unpdf`, which returns the text of each page separately.
2. **Chunking:** paragraph-aware chunks of about 1,500 characters with about 200 characters of overlap, kept within a single page, with the document title and section added in front of each chunk for embedding only.
3. **Embedding:** `gemini-embedding-2` at 1536 dimensions, with an HNSW cosine index.
4. **Citations:** store both the PDF page index and the printed page number.
5. **Documents table:** include the manifest fields (including `published_date` and `version`), plus `filename` and a file hash so that re-runs don't create duplicates.

Full output: [docs/ai-usage/phase1-step-a.md](docs/ai-usage/phase1-step-a.md)

### What I Changed

- **Why I asked for options first:** I had no idea what I needed to build, so I had Claude Code present options with trade-offs before writing any code. This kept me in control of the decisions and taught me things I didn't know.
- **Embedding dimension:** I learned that there are two separate numbers: the maximum input (how much text the model reads at once) and the dimension (how many numbers are in the output vector). I chose 1536 dimensions because pgvector's index supports at most 2,000, so the default of 3072 couldn't be indexed; 1536 is the most detail that still fits, at close to full quality.
- **My review in Claude (desktop)** added three changes to Claude Code's recommendations, which I approved and sent back:
  1. `version` was given one meaning (document revision), with null for public rulings, because it meant the revision for some documents and the ruling number for others.
  2. Task types were to be verified against the live API rather than trusting the documentation.
  3. The key variable was renamed to `SUPABASE_SECRET_KEY` to match Supabase's current naming.

### Why

I asked for options before any code was written so that the decisions stayed with me. I gave `version` a single meaning because a field should not mean two different things, and I had the task types tested against the live API because documentation should not be trusted without testing it.

## Where AI Helped Most

- AI helped me most with understanding the brief and the RAG concepts; everything else built on that.
- **Example:** Claude Code's live test showed that `gemini-embedding-2` silently ignores the `taskType` parameter. Nothing errored; the vectors were simply identical. Without that test, every question would have been embedded in the wrong format, and retrieval would have quietly got worse.

## Where AI Fell Short

- **Outdated knowledge:** Claude (desktop) used Supabase's old key name (`SUPABASE_SERVICE_ROLE_KEY`) after Supabase had renamed its keys, which confused me. AI knowledge lags behind tools that change, so I need to check more carefully.
- **Wrong environment:** Claude Code gave me an `npm run ingest -- --file` command that fails in Windows PowerShell, because PowerShell removes the `--`. I now tell it up front that I'm on PowerShell.
- **Unusable format:** Claude (desktop) gave me a Mermaid diagram that the chat displayed as a picture, so there was no text to copy.
- **My own process:** AI produced long responses faster than I could read them, so I skimmed and missed important things. For example, I put real keys into `.env.example`, which is a committed file. It was caught before anything was committed, and I confirmed with `git log -S` that no keys were ever pushed. **Lesson:** read everything fully and verify with evidence.

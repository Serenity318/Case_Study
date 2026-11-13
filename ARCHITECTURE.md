# Architecture

## System Design
```mermaid
flowchart TB
  subgraph Browser["Browser - Next.js pages"]
    CRM["CRM pages: Leads, Opportunities Kanban, Dashboard"]
    Chat["Tax Q&A chat box"]
  end

  subgraph Server["Next.js API routes - server side"]
    CRMAPI["/api/contacts, /api/opportunities, /api/dashboard"]
    AskAPI["/api/ask"]
    Guard{"Best match score above threshold?"}
  end

  subgraph Ingest["Ingestion script - run once with npm run ingest"]
    Parse["Parse PDFs page by page"]
    Chunk["Split into chunks + doc name and page"]
  end

  PDFs[("5+ tax PDFs in data/tax-docs")]
  DB[("Supabase Postgres + pgvector: contacts, opportunities, documents, chunks")]
  Embed["Gemini embedding model"]
  LLM["Gemini LLM"]

  CRM --> CRMAPI --> DB

  Chat -->|"question"| AskAPI
  AskAPI -->|"Step 1: embed question"| Embed
  AskAPI -->|"Step 2: top-k similarity search"| DB
  AskAPI --> Guard
  Guard -->|"no"| NotFound["Reply: not found in documents"]
  Guard -->|"yes - Step 3: prompt + chunks"| LLM
  LLM -->|"Step 4: answer + citations"| Chat

  PDFs --> Parse --> Chunk
  Chunk -->|"embed each chunk"| Embed
  Chunk -->|"store chunk + vector + doc/page"| DB
```

## Data Model

```mermaid
erDiagram
  contacts ||--o{ opportunities : "has"
  documents ||--o{ chunks : "has"

  contacts {
    uuid id PK
    text name "not null"
    text email "unique, case-insensitive, nullable"
    text phone
    text company
    text status "lead / prospect / customer, default lead"
    timestamptz created_at
    timestamptz updated_at "set by trigger"
  }

  opportunities {
    uuid id PK
    uuid contact_id FK "references contacts.id, on delete cascade"
    text title "not null"
    numeric value_rm "numeric(12,2), >= 0"
    text stage "new / contacted / qualified / proposal / won / lost"
    timestamptz created_at
    timestamptz updated_at "set by trigger"
  }

  documents {
    uuid id PK
    text filename UK "natural key from manifest.json"
    text title
    text publisher
    text doc_type "e_invoice / income_tax / sst"
    text version "document revision, null for public rulings"
    date published_date
    text language
    text source_url
    int page_count
    text file_sha256 "detects changed PDFs on re-ingest"
    text embedding_model "e.g. gemini-embedding-2@1536"
    timestamptz ingested_at "null until all chunks stored"
    timestamptz created_at
    timestamptz updated_at "set by trigger"
  }

  chunks {
    uuid id PK
    uuid document_id FK "references documents.id, on delete cascade"
    int chunk_index "unique per document"
    text content "clean chunk text, no embedding prefix"
    int pdf_page "1-based page index in the PDF file"
    text printed_page "number printed on the page, null if none"
    text section "nearest heading path, best effort"
    vector embedding "vector(1536), HNSW cosine index"
    timestamptz created_at
  }
```

- The brief uses 'Leads' and 'contacts' interchangeably; I model one contacts table where Lead/Prospect/Customer is the status field.
- Embedding dimension: 1536 (`gemini-embedding-2` with `outputDimensionality: 1536`). pgvector's HNSW index supports up to 2,000 dimensions on `vector`, so the 3072 default would not be indexable.
- Status and stage are `text` with `CHECK` constraints rather than Postgres enums, so adding a value is a one-line migration.
- Row Level Security is enabled on all four tables with no policies: the public API key can read nothing; the server uses the secret key, which bypasses RLS.
- Schema source of truth: `supabase/migrations/0001_init.sql`.

## RAG Design

### Document Parsing

TODO

### Chunking Strategy and Size

TODO

### Embedding Model

TODO

### Vector Store and Index

TODO

### Retrieval Settings (top-k, filters, reranking)

TODO

### Prompt Design

TODO

### Citation Approach

TODO

### Hallucination Guard

TODO

### Error Handling

TODO

## Stack Choice

TODO

## Evaluation Results

TODO

## What I Would Do Differently With More Time

TODO

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
    text name
    text email
    text phone
    text company
    text status "lead / prospect / customer"
    timestamptz created_at
    timestamptz updated_at
  }

  opportunities {
    uuid id PK
    uuid contact_id FK "references contacts.id"
    text title
    numeric value_rm "numeric(12,2)"
    text stage "new / contacted / qualified / proposal / won / lost"
    timestamptz created_at
    timestamptz updated_at
  }

  documents {
    uuid id PK
    text title
    text source_url
    text doc_type
    timestamptz created_at
  }

  chunks {
    uuid id PK
    uuid document_id FK "references documents.id"
    text content
    int page_number
    text section
    vector embedding
    timestamptz created_at
  }
```

- The brief uses 'Leads' and 'contacts' interchangeably; I model one contacts table where Lead/Prospect/Customer is the status field.
- Embedding dimension: TODO - must match the chosen Gemini embedding model.

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

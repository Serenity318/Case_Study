-- =============================================================================
-- 0001_init.sql — Phase 1 schema: CRM tables + RAG document store
--
-- Run once in the Supabase SQL editor. Safe to re-run: every statement uses
-- IF NOT EXISTS / OR REPLACE / DROP ... IF EXISTS.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Extensions
-- -----------------------------------------------------------------------------
-- pgvector adds the `vector` column type, distance operators (<=> = cosine
-- distance) and the HNSW index type. Supabase convention is to install
-- extensions into the `extensions` schema rather than `public`.
create extension if not exists vector with schema extensions;


-- -----------------------------------------------------------------------------
-- Shared trigger: keep updated_at current on every UPDATE
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;


-- -----------------------------------------------------------------------------
-- contacts — one row per person/company in the CRM.
-- "Lead", "Prospect" and "Customer" are stages of the same contact, so they
-- are a status value, not separate tables.
-- -----------------------------------------------------------------------------
create table if not exists public.contacts (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null check (length(trim(name)) > 0),
  email       text,
  phone       text,
  company     text,
  status      text        not null default 'lead'
                          check (status in ('lead', 'prospect', 'customer')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- At most one contact per email address, ignoring case. Contacts without an
-- email are allowed (partial index skips NULLs).
create unique index if not exists contacts_email_unique
  on public.contacts (lower(email))
  where email is not null;

drop trigger if exists contacts_set_updated_at on public.contacts;
create trigger contacts_set_updated_at
  before update on public.contacts
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- opportunities — a potential deal with a contact; one card on the Kanban.
-- -----------------------------------------------------------------------------
create table if not exists public.opportunities (
  id          uuid          primary key default gen_random_uuid(),
  contact_id  uuid          not null
                            references public.contacts (id) on delete cascade,
  title       text          not null check (length(trim(title)) > 0),
  value_rm    numeric(12,2) not null default 0 check (value_rm >= 0),
  stage       text          not null default 'new'
                            check (stage in ('new', 'contacted', 'qualified',
                                             'proposal', 'won', 'lost')),
  created_at  timestamptz   not null default now(),
  updated_at  timestamptz   not null default now()
);

-- Postgres does NOT index foreign keys automatically. This speeds up
-- "all opportunities for contact X" and the cascade delete.
create index if not exists opportunities_contact_id_idx
  on public.opportunities (contact_id);

-- Kanban columns and dashboard totals group/filter by stage.
create index if not exists opportunities_stage_idx
  on public.opportunities (stage);

drop trigger if exists opportunities_set_updated_at on public.opportunities;
create trigger opportunities_set_updated_at
  before update on public.opportunities
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- documents — one row per source PDF (mirrors data/tax-docs/manifest.json).
-- -----------------------------------------------------------------------------
create table if not exists public.documents (
  id              uuid        primary key default gen_random_uuid(),
  filename        text        not null unique,   -- natural key used by ingestion
  title           text        not null,
  publisher       text,
  doc_type        text        not null,           -- e_invoice / income_tax / sst
  version         text,                           -- document revision; NULL if none
  published_date  date,
  language        text        not null default 'en',
  source_url      text,
  page_count      integer     check (page_count > 0),
  file_sha256     text        not null,           -- fingerprint of the PDF bytes
  embedding_model text        not null,           -- e.g. gemini-embedding-2@1536
  ingested_at     timestamptz,                    -- NULL until all chunks are stored
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

drop trigger if exists documents_set_updated_at on public.documents;
create trigger documents_set_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- chunks — a ~1,500-character passage of one page of one document, plus its
-- embedding vector. This is what similarity search runs over.
-- -----------------------------------------------------------------------------
create table if not exists public.chunks (
  id            uuid        primary key default gen_random_uuid(),
  document_id   uuid        not null
                            references public.documents (id) on delete cascade,
  chunk_index   integer     not null check (chunk_index >= 0),
  content       text        not null,
  pdf_page      integer     not null check (pdf_page > 0),  -- 1-based page in the PDF file
  printed_page  text,                                        -- number printed on the page; NULL if none detected
  section       text,                                        -- nearest heading, e.g. "1. Introduction > 1.3 Transaction Types"
  embedding     extensions.vector(1536) not null,            -- gemini-embedding-2, 1536 dims
  created_at    timestamptz not null default now(),

  -- Database-level guarantee against duplicates: a document can only have one
  -- chunk at each position. Also serves as the index for document_id lookups.
  constraint chunks_document_chunk_unique unique (document_id, chunk_index)
);

-- Approximate-nearest-neighbour index for cosine similarity search.
-- Queries must ORDER BY embedding <=> query_vector for it to be used.
create index if not exists chunks_embedding_hnsw_idx
  on public.chunks
  using hnsw (embedding extensions.vector_cosine_ops);


-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------
-- Supabase exposes every table in `public` over its REST API. With RLS enabled
-- and no policies, the public (anon/publishable) key can read or write nothing.
-- Our server uses the secret key, which bypasses RLS, so the app still works.
alter table public.contacts      enable row level security;
alter table public.opportunities enable row level security;
alter table public.documents     enable row level security;
alter table public.chunks        enable row level security;

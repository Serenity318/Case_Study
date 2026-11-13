-- =============================================================================
-- 0002_match_chunks.sql — similarity search function used by /api/ask
--
-- Run once in the Supabase SQL editor after 0001_init.sql. Safe to re-run
-- (CREATE OR REPLACE).
--
-- Called from the server as:
--   supabase.rpc('match_chunks', { query_embedding, match_count, filter_doc_type })
-- =============================================================================

create or replace function public.match_chunks(
  query_embedding extensions.vector(1536),     -- the question's embedding
  match_count     integer default 5,           -- top-k
  filter_doc_type text    default null         -- e.g. 'sst'; NULL = search all documents
)
returns table (
  chunk_id        uuid,
  document_id     uuid,
  document_title  text,
  doc_type        text,
  version         text,
  published_date  date,
  source_url      text,
  pdf_page        integer,
  printed_page    text,
  section         text,
  content         text,
  similarity      double precision           -- cosine similarity: 1 = identical direction
)
language plpgsql
volatile           -- it changes session settings (set_config), so it is not STABLE
security invoker   -- runs with the caller's permissions; RLS still applies
set search_path = ''
as $$
declare
  pgvector_version text;
begin
  if query_embedding is null then
    raise exception 'query_embedding must not be null';
  end if;
  match_count := least(greatest(coalesce(match_count, 5), 1), 50);

  -- An HNSW index scan finds the nearest ~40 candidates (hnsw.ef_search) and only
  -- then applies WHERE filters. With a doc_type filter on a small document set
  -- (SST has 17 of 315 chunks), that could return fewer than match_count rows.
  -- pgvector >= 0.8 can keep scanning until enough rows pass the filter
  -- ("iterative scan"); older versions get a wider candidate list instead.
  -- `true` = these settings last only for the current transaction (this call).
  if filter_doc_type is not null then
    select e.extversion into pgvector_version
    from pg_catalog.pg_extension e
    where e.extname = 'vector';

    if string_to_array(pgvector_version, '.')::int[] >= array[0, 8, 0] then
      perform pg_catalog.set_config('hnsw.iterative_scan', 'relaxed_order', true);
    else
      perform pg_catalog.set_config('hnsw.ef_search', '400', true);
    end if;
  end if;

  return query
  -- MATERIALIZED + re-sort: "relaxed_order" may return rows slightly out of
  -- order, so the final ORDER BY restores exact ranking (pgvector's documented pattern).
  with nearest as materialized (
    select
      c.id            as chunk_id,
      c.document_id,
      c.pdf_page,
      c.printed_page,
      c.section,
      c.content,
      -- <=> is cosine DISTANCE (0 = same direction). ORDER BY this expression
      -- + LIMIT is the shape that lets Postgres use the HNSW index.
      c.embedding operator(extensions.<=>) query_embedding as distance
    from public.chunks c
    where filter_doc_type is null
       or c.document_id in (
            select d.id from public.documents d where d.doc_type = filter_doc_type
          )
    order by distance
    limit match_count
  )
  select
    n.chunk_id,
    n.document_id,
    d.title,
    d.doc_type,
    d.version,
    d.published_date,
    d.source_url,
    n.pdf_page,
    n.printed_page,
    n.section,
    n.content,
    1 - n.distance as similarity
  from nearest n
  join public.documents d on d.id = n.document_id
  order by n.distance;
end;
$$;

comment on function public.match_chunks(extensions.vector, integer, text) is
  'Top-k cosine similarity search over chunks, optionally restricted to one documents.doc_type.';

-- Only the server (secret key -> service_role) may call it. By default Postgres
-- lets everyone (PUBLIC) execute new functions, which would expose it through the
-- public API key too.
revoke execute on function public.match_chunks(extensions.vector, integer, text)
  from public, anon, authenticated;
grant execute on function public.match_chunks(extensions.vector, integer, text)
  to service_role;

-- Tell Supabase's REST layer (PostgREST) to pick up the new function immediately.
notify pgrst, 'reload schema';

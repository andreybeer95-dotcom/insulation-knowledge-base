-- Add additional document metadata fields
alter table public.documents
  add column if not exists storage_path text,
  add column if not exists file_size bigint,
  add column if not exists pages_count integer;

-- Chunks for AI / fulltext / retrieval
create table if not exists public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  created_at timestamptz not null default now(),
  search_vector tsvector
);

create unique index if not exists document_chunks_document_chunk_idx
  on public.document_chunks (document_id, chunk_index);

create index if not exists document_chunks_search_vector_idx
  on public.document_chunks using gin (search_vector);

-- Triggered tsvector for chunks
create or replace function public.set_document_chunks_search_vector()
returns trigger
language plpgsql
as $$
begin
  new.search_vector :=
    to_tsvector('pg_catalog.russian', coalesce(new.content, ''));
  return new;
end;
$$;

create trigger document_chunks_set_search_vector
before insert or update on public.document_chunks
for each row
execute function public.set_document_chunks_search_vector();

-- RLS
alter table public.document_chunks enable row level security;

create policy "public read document_chunks"
on public.document_chunks
for select
using (true);

create policy "auth write document_chunks"
on public.document_chunks
for all
using (auth.role() = 'authenticated')
with check (auth.role() = 'authenticated');

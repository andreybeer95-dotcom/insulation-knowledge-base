-- 001_knowledge_base_schema.sql
-- Главная схема базы знаний: enum, категории, продукты, связи, расширения документов,
-- автосинхронизация чанков и RPC get_ai_context для n8n.

create extension if not exists pgcrypto;

-- ===== ENUM TYPES =====
do $$
begin
  if not exists (select 1 from pg_type where typname = 'product_relation_type') then
    create type public.product_relation_type as enum (
      'analogue',
      'accessory',
      'upsell',
      'cross_sell',
      'replacement'
    );
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'intent_tag') then
    create type public.intent_tag as enum (
      'selection',
      'manager',
      'comparison',
      'compatibility',
      'price',
      'delivery',
      'certificate',
      'script',
      'faq'
    );
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'doc_type_ai') then
    create type public.doc_type_ai as enum (
      'script',
      'tds',
      'certificate',
      'price',
      'manual',
      'faq'
    );
  end if;
end $$;

-- ===== CATEGORIES =====
create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name_ru text not null,
  description text,
  sort_order integer not null default 100,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists categories_sort_order_idx on public.categories (sort_order);
create index if not exists categories_active_idx on public.categories (is_active);

-- ===== PRODUCTS EXTENSION =====
alter table public.products
  add column if not exists sku text unique,
  add column if not exists category_id uuid references public.categories(id) on delete set null,
  add column if not exists density integer,
  add column if not exists thickness integer,
  add column if not exists is_active boolean not null default true;

create index if not exists products_category_idx on public.products (category_id);
create index if not exists products_sku_idx on public.products (sku);

-- ===== RELATIONS BETWEEN PRODUCTS =====
create table if not exists public.product_relations (
  id uuid primary key default gen_random_uuid(),
  from_product_id uuid not null references public.products(id) on delete cascade,
  to_product_id uuid not null references public.products(id) on delete cascade,
  relation_type public.product_relation_type not null,
  weight integer not null default 50,
  note text,
  created_at timestamptz not null default now(),
  unique (from_product_id, to_product_id, relation_type)
);

create index if not exists product_relations_from_idx on public.product_relations (from_product_id);
create index if not exists product_relations_to_idx on public.product_relations (to_product_id);
create index if not exists product_relations_type_idx on public.product_relations (relation_type);

-- ===== DOCUMENTS EXTENSION =====
alter table public.documents
  add column if not exists category_id uuid references public.categories(id) on delete set null,
  add column if not exists intent_tags public.intent_tag[] not null default '{}',
  add column if not exists doc_type_ai public.doc_type_ai,
  add column if not exists source_system text,
  add column if not exists priority integer not null default 50,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists documents_category_idx on public.documents (category_id);
create index if not exists documents_doc_type_ai_idx on public.documents (doc_type_ai);
create index if not exists documents_intent_tags_gin_idx on public.documents using gin (intent_tags);
create index if not exists documents_priority_idx on public.documents (priority desc);

-- ===== DOCUMENT CHUNKS EXTENSION =====
alter table public.document_chunks
  add column if not exists chunk_hash text,
  add column if not exists source text not null default 'auto',
  add column if not exists updated_at timestamptz not null default now();

create index if not exists document_chunks_hash_idx on public.document_chunks (chunk_hash);
create index if not exists document_chunks_source_idx on public.document_chunks (source);

-- ===== UPDATED_AT TRIGGERS =====
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_categories_updated_at on public.categories;
create trigger trg_categories_updated_at
before update on public.categories
for each row execute function public.set_updated_at();

drop trigger if exists trg_documents_updated_at on public.documents;
create trigger trg_documents_updated_at
before update on public.documents
for each row execute function public.set_updated_at();

drop trigger if exists trg_document_chunks_updated_at on public.document_chunks;
create trigger trg_document_chunks_updated_at
before update on public.document_chunks
for each row execute function public.set_updated_at();

-- ===== AUTO CHUNK SYNC FROM documents.extracted_text =====
create or replace function public.sync_document_chunks()
returns trigger
language plpgsql
security definer
as $$
declare
  chunk_size int := 1000;
  overlap int := 200;
  step_size int := 800;
  idx int := 0;
  pos int := 1;
  txt text;
  part text;
begin
  if tg_op = 'DELETE' then
    delete from public.document_chunks where document_id = old.id;
    return old;
  end if;

  if new.extracted_text is null or length(trim(new.extracted_text)) = 0 then
    delete from public.document_chunks where document_id = new.id;
    return new;
  end if;

  -- Синхронизируем только когда текст реально изменился
  if tg_op = 'UPDATE' and coalesce(old.extracted_text, '') = coalesce(new.extracted_text, '') then
    return new;
  end if;

  delete from public.document_chunks where document_id = new.id;

  txt := new.extracted_text;
  while pos <= length(txt) loop
    part := btrim(substring(txt from pos for chunk_size));
    if length(part) > 50 then
      insert into public.document_chunks (document_id, content, chunk_index, metadata, chunk_hash, source)
      values (
        new.id,
        part,
        idx,
        jsonb_build_object('from_sync', true, 'doc_type_ai', new.doc_type_ai, 'priority', new.priority),
        md5(part),
        'sync_trigger'
      );
      idx := idx + 1;
    end if;
    pos := pos + step_size;
  end loop;

  return new;
end;
$$;

drop trigger if exists trg_sync_document_chunks on public.documents;
create trigger trg_sync_document_chunks
after insert or update of extracted_text on public.documents
for each row
execute function public.sync_document_chunks();

-- ===== RPC FOR N8N =====
create or replace function public.get_ai_context(
  p_query text,
  p_intents text[] default null,
  p_doc_types text[] default null,
  p_product_id uuid default null,
  p_limit integer default 12
)
returns table (
  kind text,
  id uuid,
  title text,
  content text,
  score numeric,
  meta jsonb
)
language sql
stable
as $$
  with chunk_pool as (
    select
      'document_chunk'::text as kind,
      dc.id,
      d.title,
      dc.content,
      ts_rank(to_tsvector('russian', dc.content), plainto_tsquery('russian', p_query))::numeric as score,
      jsonb_build_object(
        'document_id', d.id,
        'doc_type_ai', d.doc_type_ai,
        'intent_tags', d.intent_tags,
        'manufacturer_id', d.manufacturer_id,
        'product_id', d.product_id
      ) as meta
    from public.document_chunks dc
    join public.documents d on d.id = dc.document_id
    where
      (
        p_query is null
        or p_query = ''
        or to_tsvector('russian', dc.content) @@ plainto_tsquery('russian', p_query)
      )
      and (p_product_id is null or d.product_id = p_product_id)
      and (
        p_doc_types is null
        or cardinality(p_doc_types) = 0
        or d.doc_type_ai::text = any(p_doc_types)
      )
      and (
        p_intents is null
        or cardinality(p_intents) = 0
        or exists (
          select 1
          from unnest(d.intent_tags::text[]) t
          where t = any(p_intents)
        )
      )
  ),
  product_pool as (
    select
      'product'::text as kind,
      p.id,
      coalesce(p.sku, p.name) as title,
      concat_ws(
        ' | ',
        p.name,
        'coating=' || coalesce(p.coating, '-'),
        'density=' || coalesce(p.density::text, '-'),
        'thickness=' || coalesce(p.thickness::text, '-'),
        'temp_max=' || coalesce(p.temp_max::text, '-')
      ) as content,
      0.30::numeric as score,
      jsonb_build_object(
        'sku', p.sku,
        'category_id', p.category_id,
        'manufacturer_id', p.manufacturer_id
      ) as meta
    from public.products p
    where (p_product_id is null or p.id = p_product_id)
    limit 10
  ),
  rules_pool as (
    select
      'selection_rule'::text as kind,
      r.id,
      r.rule_name as title,
      r.rule_text as content,
      (0.25 + least(r.priority, 10) / 100.0)::numeric as score,
      jsonb_build_object(
        'priority', r.priority,
        'is_prohibition', r.is_prohibition
      ) as meta
    from public.selection_rules r
    limit 10
  )
  select * from (
    select * from chunk_pool
    union all
    select * from product_pool
    union all
    select * from rules_pool
  ) u
  order by score desc nulls last
  limit greatest(p_limit, 1);
$$;

comment on function public.get_ai_context(text, text[], text[], uuid, integer)
is 'Контекст для n8n/LLM: фильтры intents, doc_types, product_id и ранжирование чанков.';


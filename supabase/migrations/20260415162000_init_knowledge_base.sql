-- Extensions
create extension if not exists "pgcrypto";

-- Utility function: updated_at trigger
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Utility function: search_vector triggers
create or replace function public.set_products_search_vector()
returns trigger
language plpgsql
as $$
begin
  new.search_vector :=
    to_tsvector('pg_catalog.russian', coalesce(new.name, '') || ' ' || coalesce(new.application_notes, ''));
  return new;
end;
$$;

create or replace function public.set_documents_search_vector()
returns trigger
language plpgsql
as $$
begin
  new.search_vector :=
    to_tsvector(
      'pg_catalog.russian',
      coalesce(new.extracted_text, '') || ' ' || coalesce(new.notes, '') || ' ' || coalesce(new.title, '')
    );
  return new;
end;
$$;

create or replace function public.set_knowledge_notes_search_vector()
returns trigger
language plpgsql
as $$
begin
  new.search_vector :=
    to_tsvector(
      'pg_catalog.russian',
      coalesce(new.title, '') || ' ' || coalesce(new.content, '') || ' ' || coalesce(array_to_string(new.tags, ' '), '')
    );
  return new;
end;
$$;

-- 1) manufacturers
create table if not exists public.manufacturers (
  id uuid primary key default gen_random_uuid(),
  name_ru text not null,
  name_en text,
  synonyms text[] not null default '{}',
  website text,
  phone text,
  tu text,
  created_at timestamptz not null default now()
);

create index if not exists manufacturers_name_ru_idx on public.manufacturers (name_ru);
create index if not exists manufacturers_synonyms_gin_idx on public.manufacturers using gin (synonyms);

-- 2) products
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  manufacturer_id uuid not null references public.manufacturers(id) on delete cascade,
  name text not null,
  product_type text not null check (product_type in ('вырезной', 'навивной', 'термонавивной')),
  coating text not null check (coating in ('без покрытия', 'НФ', 'АФ', 'ФА', 'ФТ', 'ФТ-У', 'AL', 'AL2', 'СТ', 'БТ', 'Ф')),
  flammability text not null check (flammability in ('НГ', 'Г1', 'КМ0')),
  density_min integer,
  density_max integer,
  temp_min integer,
  temp_max integer,
  diameter_min integer,
  diameter_max integer,
  thickness_min integer,
  thickness_max integer,
  length integer,
  lambda_10 numeric(6,4),
  lambda_25 numeric(6,4),
  lambda_125 numeric(6,4),
  lambda_300 numeric(6,4),
  has_lock boolean not null default false,
  lock_type text,
  outdoor_use boolean not null default false,
  application_notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search_vector tsvector
);

create trigger products_set_updated_at
before update on public.products
for each row
execute function public.set_updated_at();

create trigger products_set_search_vector
before insert or update on public.products
for each row
execute function public.set_products_search_vector();

create index if not exists products_manufacturer_idx on public.products (manufacturer_id);
create index if not exists products_flammability_idx on public.products (flammability);
create index if not exists products_coating_idx on public.products (coating);
create index if not exists products_temp_range_idx on public.products (temp_min, temp_max);
create index if not exists products_diameter_range_idx on public.products (diameter_min, diameter_max);
create index if not exists products_search_vector_idx on public.products using gin (search_vector);

-- 3) certificates
create table if not exists public.certificates (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  cert_type text not null check (cert_type in ('пожарный', 'СС', 'декларация', 'СЭЗ', 'морской регистр')),
  cert_number text not null,
  valid_until date,
  issuer text,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists certificates_product_idx on public.certificates (product_id);
create index if not exists certificates_valid_until_idx on public.certificates (valid_until);

-- 4) diameter_conversion
create table if not exists public.diameter_conversion (
  id uuid primary key default gen_random_uuid(),
  du integer not null unique,
  outer_diameter_steel numeric(8,2),
  outer_diameter_copper numeric(8,2),
  insulation_diameter_mineral integer
);

create index if not exists diameter_conversion_du_idx on public.diameter_conversion (du);

-- 5) accessories
create table if not exists public.accessories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  apply_with text[] not null default '{}',
  manufacturer_id uuid references public.manufacturers(id) on delete set null
);

create index if not exists accessories_name_idx on public.accessories (name);
create index if not exists accessories_apply_with_gin_idx on public.accessories using gin (apply_with);

-- 6) selection_rules
create table if not exists public.selection_rules (
  id uuid primary key default gen_random_uuid(),
  rule_name text not null,
  condition text not null,
  rule_text text not null,
  priority integer not null default 3,
  is_prohibition boolean not null default false
);

create index if not exists selection_rules_priority_idx on public.selection_rules (priority);
create index if not exists selection_rules_is_prohibition_idx on public.selection_rules (is_prohibition);

-- 7) documents
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.products(id) on delete set null,
  manufacturer_id uuid references public.manufacturers(id) on delete set null,
  doc_type text not null check (doc_type in ('техлист', 'сертификат', 'прайс', 'инструкция', 'дополнение')),
  title text not null,
  file_url text not null,
  file_name text not null,
  extracted_text text,
  notes text,
  uploaded_by text,
  created_at timestamptz not null default now(),
  search_vector tsvector
);

create trigger documents_set_search_vector
before insert or update on public.documents
for each row
execute function public.set_documents_search_vector();

create index if not exists documents_product_idx on public.documents (product_id);
create index if not exists documents_manufacturer_idx on public.documents (manufacturer_id);
create index if not exists documents_doc_type_idx on public.documents (doc_type);
create index if not exists documents_search_vector_idx on public.documents using gin (search_vector);

-- 8) knowledge_notes
create table if not exists public.knowledge_notes (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('правило', 'совет', 'скрипт продаж', 'FAQ', 'дополнение')),
  title text not null,
  content text not null,
  product_id uuid references public.products(id) on delete set null,
  manufacturer_id uuid references public.manufacturers(id) on delete set null,
  tags text[] not null default '{}',
  is_active boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search_vector tsvector
);

create trigger knowledge_notes_set_updated_at
before update on public.knowledge_notes
for each row
execute function public.set_updated_at();

create trigger knowledge_notes_set_search_vector
before insert or update on public.knowledge_notes
for each row
execute function public.set_knowledge_notes_search_vector();

create index if not exists knowledge_notes_category_idx on public.knowledge_notes (category);
create index if not exists knowledge_notes_is_active_idx on public.knowledge_notes (is_active);
create index if not exists knowledge_notes_tags_gin_idx on public.knowledge_notes using gin (tags);
create index if not exists knowledge_notes_search_vector_idx on public.knowledge_notes using gin (search_vector);

-- 9) prices
create table if not exists public.prices (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  price numeric(12,2) not null,
  unit text not null check (unit in ('пм', 'шт', 'м²')),
  currency text not null default 'RUB',
  supplier text,
  valid_from date not null,
  valid_until date,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists prices_product_idx on public.prices (product_id);
create index if not exists prices_valid_from_until_idx on public.prices (valid_from, valid_until);
create index if not exists prices_supplier_idx on public.prices (supplier);

-- 10) change_log
create table if not exists public.change_log (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  record_id uuid not null,
  action text not null check (action in ('create', 'update', 'delete')),
  changed_by text,
  changes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists change_log_table_name_idx on public.change_log (table_name);
create index if not exists change_log_created_at_idx on public.change_log (created_at desc);
create index if not exists change_log_changes_gin_idx on public.change_log using gin (changes);

-- Public read + auth write model for core knowledge tables
alter table public.manufacturers enable row level security;
alter table public.products enable row level security;
alter table public.certificates enable row level security;
alter table public.diameter_conversion enable row level security;
alter table public.accessories enable row level security;
alter table public.selection_rules enable row level security;
alter table public.documents enable row level security;
alter table public.knowledge_notes enable row level security;
alter table public.prices enable row level security;
alter table public.change_log enable row level security;

-- Read policies
create policy "public read manufacturers" on public.manufacturers for select using (true);
create policy "public read products" on public.products for select using (true);
create policy "public read certificates" on public.certificates for select using (true);
create policy "public read diameter_conversion" on public.diameter_conversion for select using (true);
create policy "public read accessories" on public.accessories for select using (true);
create policy "public read selection_rules" on public.selection_rules for select using (true);
create policy "public read documents" on public.documents for select using (true);
create policy "public read knowledge_notes" on public.knowledge_notes for select using (true);
create policy "public read prices" on public.prices for select using (true);
create policy "public read change_log" on public.change_log for select using (true);

-- Auth write policies
create policy "auth write manufacturers" on public.manufacturers for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "auth write products" on public.products for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "auth write certificates" on public.certificates for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "auth write diameter_conversion" on public.diameter_conversion for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "auth write accessories" on public.accessories for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "auth write selection_rules" on public.selection_rules for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "auth write documents" on public.documents for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "auth write knowledge_notes" on public.knowledge_notes for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "auth write prices" on public.prices for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "auth write change_log" on public.change_log for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Storage bucket and policies
insert into storage.buckets (id, name, public)
values ('documents', 'documents', true)
on conflict (id) do nothing;

create policy "public read documents bucket"
on storage.objects
for select
using (bucket_id = 'documents');

create policy "authenticated upload documents bucket"
on storage.objects
for insert
with check (bucket_id = 'documents' and auth.role() = 'authenticated');

create policy "authenticated update documents bucket"
on storage.objects
for update
using (bucket_id = 'documents' and auth.role() = 'authenticated');

create policy "authenticated delete documents bucket"
on storage.objects
for delete
using (bucket_id = 'documents' and auth.role() = 'authenticated');

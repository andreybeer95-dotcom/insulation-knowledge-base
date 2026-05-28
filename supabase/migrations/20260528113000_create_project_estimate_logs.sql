create table if not exists project_estimate_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  source text not null default 'project-upload',
  status text not null default 'estimated',
  file_name text,
  direction text,
  question text,
  manager_comment text,
  pages integer,
  chars integer,
  area jsonb,
  ai_extraction jsonb,
  detected_layers jsonb not null default '[]'::jsonb,
  invoice_items jsonb not null default '[]'::jsonb,
  quote_items jsonb not null default '[]'::jsonb,
  quote_draft text,
  project_only jsonb not null default '[]'::jsonb,
  not_found jsonb not null default '[]'::jsonb,
  roof_fastener_guidance jsonb,
  roof_drain_guidance jsonb
);

create index if not exists project_estimate_logs_created_at_idx
  on project_estimate_logs (created_at desc);

create index if not exists project_estimate_logs_file_name_idx
  on project_estimate_logs (file_name);

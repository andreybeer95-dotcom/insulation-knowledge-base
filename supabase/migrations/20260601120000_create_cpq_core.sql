create table if not exists public.cpq_systems (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  direction text not null,
  name text not null,
  source text not null default 'manual',
  source_url text,
  description text,
  applicability jsonb not null default '{}'::jsonb,
  tags text[] not null default '{}',
  status text not null default 'draft',
  priority integer not null default 100,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger cpq_systems_set_updated_at
before update on public.cpq_systems
for each row
execute function public.set_updated_at();

create index if not exists cpq_systems_direction_idx
  on public.cpq_systems (direction);

create index if not exists cpq_systems_active_priority_idx
  on public.cpq_systems (is_active, priority);

create table if not exists public.cpq_system_layers (
  id uuid primary key default gen_random_uuid(),
  system_id uuid not null references public.cpq_systems(id) on delete cascade,
  layer_key text not null,
  role text not null,
  display_name text not null,
  sequence_no integer not null default 100,
  is_required boolean not null default true,
  is_project_only boolean not null default false,
  requires_project_quantity boolean not null default false,
  quantity_basis text not null default 'area',
  factor numeric(10,4),
  thickness_mm numeric(10,2),
  formula_code text,
  formula_text text,
  source_note text,
  constraints jsonb not null default '{}'::jsonb,
  allowed_material_patterns text[] not null default '{}',
  prohibited_material_patterns text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (system_id, layer_key)
);

create trigger cpq_system_layers_set_updated_at
before update on public.cpq_system_layers
for each row
execute function public.set_updated_at();

create index if not exists cpq_system_layers_system_sequence_idx
  on public.cpq_system_layers (system_id, sequence_no);

create index if not exists cpq_system_layers_role_idx
  on public.cpq_system_layers (role);

create table if not exists public.cpq_layer_product_links (
  id uuid primary key default gen_random_uuid(),
  system_layer_id uuid not null references public.cpq_system_layers(id) on delete cascade,
  code_1c text,
  product_name_snapshot text,
  brand text,
  priority integer not null default 100,
  match_type text not null default 'candidate',
  is_primary boolean not null default false,
  conditions jsonb not null default '{}'::jsonb,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists cpq_layer_product_links_layer_priority_idx
  on public.cpq_layer_product_links (system_layer_id, priority);

create index if not exists cpq_layer_product_links_code_idx
  on public.cpq_layer_product_links (code_1c);

create table if not exists public.cpq_calculation_rules (
  id uuid primary key default gen_random_uuid(),
  system_id uuid not null references public.cpq_systems(id) on delete cascade,
  rule_key text not null,
  role text,
  sequence_no integer not null default 100,
  formula_code text not null,
  formula_text text not null,
  input_requirements jsonb not null default '{}'::jsonb,
  output_unit text,
  factor numeric(10,4),
  requires_geometry boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (system_id, rule_key)
);

create trigger cpq_calculation_rules_set_updated_at
before update on public.cpq_calculation_rules
for each row
execute function public.set_updated_at();

create index if not exists cpq_calculation_rules_system_sequence_idx
  on public.cpq_calculation_rules (system_id, sequence_no);

alter table public.project_estimate_logs
  add column if not exists project_system jsonb,
  add column if not exists roof_breakdown jsonb not null default '[]'::jsonb,
  add column if not exists analog_recommendations jsonb not null default '[]'::jsonb,
  add column if not exists cpq_context jsonb;

alter table public.cpq_systems enable row level security;
alter table public.cpq_system_layers enable row level security;
alter table public.cpq_layer_product_links enable row level security;
alter table public.cpq_calculation_rules enable row level security;

drop policy if exists "public read cpq_systems" on public.cpq_systems;
create policy "public read cpq_systems"
  on public.cpq_systems for select using (true);

drop policy if exists "public read cpq_system_layers" on public.cpq_system_layers;
create policy "public read cpq_system_layers"
  on public.cpq_system_layers for select using (true);

drop policy if exists "public read cpq_layer_product_links" on public.cpq_layer_product_links;
create policy "public read cpq_layer_product_links"
  on public.cpq_layer_product_links for select using (true);

drop policy if exists "public read cpq_calculation_rules" on public.cpq_calculation_rules;
create policy "public read cpq_calculation_rules"
  on public.cpq_calculation_rules for select using (true);

insert into public.cpq_systems (slug, direction, name, source, source_url, description, tags, status, priority, applicability)
values
  (
    'tn_roof_klassik',
    'roof',
    'ТН-КРОВЛЯ Классик',
    'nav_tn',
    'https://nav.tn.ru/',
    'Механически закрепляемая ПВХ-кровля по профилированному листу с минераловатной теплоизоляцией.',
    array['roof','pvc','flat_roof','mechanical_fastening'],
    'draft_verified',
    20,
    '{"basis":["profiled_sheet"],"waterproofing":["pvc_membrane"],"fastening":["mechanical"]}'::jsonb
  ),
  (
    'tn_roof_smart_pir',
    'roof',
    'ТН-КРОВЛЯ Смарт PIR',
    'nav_tn',
    'https://nav.tn.ru/',
    'Механически закрепляемая ПВХ-кровля с PIR-слоем и нижним слоем минераловатной теплоизоляции.',
    array['roof','pvc','flat_roof','mechanical_fastening','pir'],
    'draft_verified',
    10,
    '{"basis":["profiled_sheet","concrete"],"waterproofing":["pvc_membrane"],"fastening":["mechanical"],"insulation":["pir","stone_wool"]}'::jsonb
  )
on conflict (slug) do update set
  name = excluded.name,
  source = excluded.source,
  source_url = excluded.source_url,
  description = excluded.description,
  tags = excluded.tags,
  status = excluded.status,
  priority = excluded.priority,
  applicability = excluded.applicability;

with system_rows as (
  select id, slug from public.cpq_systems where slug in ('tn_roof_klassik', 'tn_roof_smart_pir')
),
layer_rows(system_slug, layer_key, role, display_name, sequence_no, is_required, is_project_only, requires_project_quantity, quantity_basis, factor, formula_code, formula_text, source_note, constraints, allowed_material_patterns, prohibited_material_patterns) as (
  values
    ('tn_roof_klassik','pvc_membrane','кровельный ковер','LOGICROOF V-RP / PRO V-RP',10,true,false,false,'area',1.1500,'area_factor','Площадь кровли × 1,15; рулоны считать по площади выбранного рулона.','Толщину мембраны брать из проекта; без толщины не ставить в счет.','{"needs_thickness":true}'::jsonb,array['LOGICROOF V-RP','PRO V-RP'],array[]::text[]),
    ('tn_roof_klassik','membrane_fastener','крепеж мембраны','TERMOCLIP саморез + телескоп',20,true,false,true,'wind_calculation',null,'wind_calculation','Финально считать по ветровому расчету; ориентир поля не является счетной нормой.','Нужны основание, высота здания, регион, зоны кровли.', '{"requires_wind_calculation":true}'::jsonb,array['TERMOCLIP'],array[]::text[]),
    ('tn_roof_klassik','top_stone_wool','верхний слой утепления','ТЕХНОРУФ В ЭКСТРА / В ПРОФ / В60',30,true,false,false,'area_thickness',1.0300,'area_thickness_factor','Площадь участка × 1,03 × толщина слоя.','Марку и толщину брать из проекта.', '{}'::jsonb,array['ТЕХНОРУФ В','ТЕХНОРУФ В60'],array[]::text[]),
    ('tn_roof_klassik','bottom_stone_wool','нижний слой утепления','ТЕХНОРУФ Н ПРОФ / Н30 / Н ОПТИМА',40,true,false,false,'area_thickness',1.0300,'area_thickness_factor','Площадь участка × 1,03 × толщина слоя.','Марку и толщину брать из проекта.', '{}'::jsonb,array['ТЕХНОРУФ Н','ТЕХНОРУФ Н30','ТЕХНОРУФ Н ПРОФ'],array[]::text[]),
    ('tn_roof_klassik','slope_layer','уклонообразующий слой','ТЕХНОРУФ КЛИН / LOGICPIR SLOPE / XPS SLOPE',50,false,false,true,'slope_layout',null,'slope_layout','Считать только по плану уклонов/раскладке клиновидных плит.','Нельзя считать по общей площади кровли.', '{"requires_slope_layout":true}'::jsonb,array['КЛИН','SLOPE'],array[]::text[]),
    ('tn_roof_klassik','vapor_barrier','пароизоляция','Паробарьер СА500 / СФ1000 / указанная в проекте',60,true,false,false,'area',1.1200,'area_factor','Площадь участка × 1,12.','Марку не смешивать между разными участками кровли.', '{}'::jsonb,array['Паробарьер','Технобарьер'],array[]::text[]),
    ('tn_roof_klassik','basis_profiled_sheet','основание','Профилированный лист',70,true,true,true,'project',null,'project_only','Основание брать по КМ/КМД; в кровельный счет автоматически не ставить.','Отдельная система/ведомость металлоконструкций.', '{"project_only":true}'::jsonb,array['профлист','профилированный лист'],array[]::text[]),
    ('tn_roof_klassik','roof_drainage','водоотвод','Воронки/желоба/трубы',80,true,false,true,'drainage_project',null,'drainage_project','Считать по проекту водоотвода или калькулятору; нужна схема и водосборные участки.','Наружный водосток вести отдельной системой.', '{"separate_system":true}'::jsonb,array['воронка','желоб','водосток'],array[]::text[]),

    ('tn_roof_smart_pir','pvc_membrane','кровельный ковер','LOGICROOF V-RP / PRO V-RP',10,true,false,false,'area',1.1500,'area_factor','Площадь кровли × 1,15; рулоны считать по площади выбранного рулона.','Толщину и группу горючести сверять по проекту.', '{"needs_thickness":true}'::jsonb,array['LOGICROOF V-RP','PRO V-RP'],array[]::text[]),
    ('tn_roof_smart_pir','pir_layer','PIR теплоизоляция','LOGICPIR PROF',20,true,false,false,'area_thickness',1.0300,'area_thickness_factor','Площадь участка × 1,03 × толщина слоя.','Марку, толщину и участок основания брать из проекта.', '{}'::jsonb,array['LOGICPIR PROF'],array[]::text[]),
    ('tn_roof_smart_pir','stone_wool_layer','нижний слой утепления','ТЕХНОРУФ Н ПРОФ / Н ОПТИМА / Н30',30,true,false,false,'area_thickness',1.0300,'area_thickness_factor','Площадь участка × 1,03 × толщина слоя.','Нужна привязка к конкретному участку кровли.', '{}'::jsonb,array['ТЕХНОРУФ Н','ТЕХНОРУФ Н ПРОФ','ТЕХНОРУФ Н30'],array[]::text[]),
    ('tn_roof_smart_pir','slope_layer','уклонообразующий слой','LOGICPIR SLOPE / ТЕХНОРУФ КЛИН / XPS SLOPE',40,false,false,true,'slope_layout',null,'slope_layout','Считать только по схеме уклонов/раскладке элементов.','Не считать по общей площади.', '{"requires_slope_layout":true}'::jsonb,array['LOGICPIR SLOPE','КЛИН','SLOPE'],array[]::text[]),
    ('tn_roof_smart_pir','vapor_barrier','пароизоляция','Технобарьер / Паробарьер СА500 / проектная марка',50,true,false,false,'area',1.1200,'area_factor','Площадь участка × 1,12.','Не смешивать разные марки на всю площадь, если проект делит участки.', '{}'::jsonb,array['Технобарьер','Паробарьер'],array[]::text[]),
    ('tn_roof_smart_pir','basis','основание','Профлист или Ж/Б основание',60,true,true,true,'project',null,'project_only','Основание не ставить в кровельный счет без отдельной ведомости.','Ж/Б, профлист и сэндвич-панели считаются разными участками/системами.', '{"project_only":true}'::jsonb,array['профлист','железобетон','монолит'],array[]::text[]),
    ('tn_roof_smart_pir','roof_drainage','водоотвод','Воронки/желоба/трубы',70,true,false,true,'drainage_project',null,'drainage_project','Считать по проекту водоотвода или калькулятору; нужна схема и водосборные участки.','Наружный водосток вести отдельной системой.', '{"separate_system":true}'::jsonb,array['воронка','желоб','водосток'],array[]::text[])
)
insert into public.cpq_system_layers (
  system_id, layer_key, role, display_name, sequence_no, is_required, is_project_only,
  requires_project_quantity, quantity_basis, factor, formula_code, formula_text,
  source_note, constraints, allowed_material_patterns, prohibited_material_patterns
)
select
  s.id, l.layer_key, l.role, l.display_name, l.sequence_no, l.is_required, l.is_project_only,
  l.requires_project_quantity, l.quantity_basis, l.factor, l.formula_code, l.formula_text,
  l.source_note, l.constraints, l.allowed_material_patterns, l.prohibited_material_patterns
from layer_rows l
join system_rows s on s.slug = l.system_slug
on conflict (system_id, layer_key) do update set
  role = excluded.role,
  display_name = excluded.display_name,
  sequence_no = excluded.sequence_no,
  is_required = excluded.is_required,
  is_project_only = excluded.is_project_only,
  requires_project_quantity = excluded.requires_project_quantity,
  quantity_basis = excluded.quantity_basis,
  factor = excluded.factor,
  formula_code = excluded.formula_code,
  formula_text = excluded.formula_text,
  source_note = excluded.source_note,
  constraints = excluded.constraints,
  allowed_material_patterns = excluded.allowed_material_patterns,
  prohibited_material_patterns = excluded.prohibited_material_patterns;

with system_rows as (
  select id, slug from public.cpq_systems where slug in ('tn_roof_klassik', 'tn_roof_smart_pir')
),
rule_rows(system_slug, rule_key, role, sequence_no, formula_code, formula_text, input_requirements, output_unit, factor, requires_geometry, notes) as (
  values
    ('tn_roof_klassik','pvc_membrane_area','кровельный ковер',10,'area_factor','Площадь кровли × 1,15; затем округлить до целых рулонов по площади рулона.','{"required":["roof_area","membrane_thickness","roll_area"]}'::jsonb,'m2',1.1500,false,'Без толщины мембраны не выбирать код 1С.'),
    ('tn_roof_klassik','insulation_volume','утепление',20,'area_thickness_factor','Площадь участка × 1,03 × толщина слоя в метрах.','{"required":["roof_area","layer_thickness_mm","project_material"]}'::jsonb,'m3',1.0300,false,'Слои и толщины брать из проекта.'),
    ('tn_roof_klassik','vapor_barrier_area','пароизоляция',30,'area_factor','Площадь участка × 1,12.','{"required":["roof_area","vapor_barrier_brand"]}'::jsonb,'m2',1.1200,false,'Марку пароизоляции брать из проекта.'),
    ('tn_roof_klassik','fasteners','крепеж',40,'wind_calculation','Финальное количество только по ветровому расчету.','{"required":["wind_region","building_height","roof_zones","basis","insulation_thickness"]}'::jsonb,'pcs',null,true,'Ориентир поля можно показывать отдельно, но не как счетную норму.'),
    ('tn_roof_klassik','drainage','водоотвод',50,'drainage_project','Количество воронок/желобов/труб по проекту водоотвода или калькулятору.','{"required":["catchment_area","city","drain_type","drainage_scheme"]}'::jsonb,'pcs',null,true,'Наружный водосток - отдельная система.'),

    ('tn_roof_smart_pir','pvc_membrane_area','кровельный ковер',10,'area_factor','Площадь кровли × 1,15; затем округлить до целых рулонов по площади рулона.','{"required":["roof_area","membrane_thickness","roll_area"]}'::jsonb,'m2',1.1500,false,'Без толщины мембраны не выбирать код 1С.'),
    ('tn_roof_smart_pir','pir_volume','PIR теплоизоляция',20,'area_thickness_factor','Площадь участка × 1,03 × толщина PIR-слоя в метрах.','{"required":["roof_segment_area","layer_thickness_mm","project_material"]}'::jsonb,'m3',1.0300,false,'Участки по Ж/Б и профлисту не смешивать.'),
    ('tn_roof_smart_pir','stone_wool_volume','нижний слой утепления',30,'area_thickness_factor','Площадь участка × 1,03 × толщина слоя в метрах.','{"required":["roof_segment_area","layer_thickness_mm","project_material"]}'::jsonb,'m3',1.0300,false,'Участки по Ж/Б и профлисту не смешивать.'),
    ('tn_roof_smart_pir','vapor_barrier_area','пароизоляция',40,'area_factor','Площадь участка × 1,12.','{"required":["roof_segment_area","vapor_barrier_brand"]}'::jsonb,'m2',1.1200,false,'Не смешивать Технобарьер и Паробарьер на всю площадь, если проект разделяет участки.'),
    ('tn_roof_smart_pir','slope_layout','уклонообразующий слой',50,'slope_layout','Количество клиновидных плит считать только по плану уклонов/раскладке.','{"required":["slope_layout"]}'::jsonb,'project',null,true,'Не считать по общей площади.'),
    ('tn_roof_smart_pir','drainage','водоотвод',60,'drainage_project','Количество воронок/желобов/труб по проекту водоотвода или калькулятору.','{"required":["catchment_area","city","drain_type","drainage_scheme"]}'::jsonb,'pcs',null,true,'Наружный водосток - отдельная система.')
)
insert into public.cpq_calculation_rules (
  system_id, rule_key, role, sequence_no, formula_code, formula_text,
  input_requirements, output_unit, factor, requires_geometry, notes
)
select
  s.id, r.rule_key, r.role, r.sequence_no, r.formula_code, r.formula_text,
  r.input_requirements, r.output_unit, r.factor, r.requires_geometry, r.notes
from rule_rows r
join system_rows s on s.slug = r.system_slug
on conflict (system_id, rule_key) do update set
  role = excluded.role,
  sequence_no = excluded.sequence_no,
  formula_code = excluded.formula_code,
  formula_text = excluded.formula_text,
  input_requirements = excluded.input_requirements,
  output_unit = excluded.output_unit,
  factor = excluded.factor,
  requires_geometry = excluded.requires_geometry,
  notes = excluded.notes;

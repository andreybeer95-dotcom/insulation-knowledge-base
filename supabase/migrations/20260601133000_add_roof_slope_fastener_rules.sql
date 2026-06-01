alter table public.project_estimate_logs
  add column if not exists roof_slope_guidance jsonb;

with target_layers as (
  select l.id, s.slug, l.layer_key
  from public.cpq_system_layers l
  join public.cpq_systems s on s.id = l.system_id
  where s.slug in ('tn_roof_klassik', 'tn_roof_smart_pir')
    and l.layer_key in ('slope_layer', 'membrane_fastener')
)
update public.cpq_system_layers l
set
  formula_text = case
    when t.layer_key = 'slope_layer' then
      'Считать отдельным блоком по плану уклонов/контруклонов: тип фигуры, расстояние между воронками, смещение от парапета, уклон %, количество одинаковых фигур. Итог должен быть в элементах клиновидных плит, а не только в м2.'
    when t.layer_key = 'membrane_fastener' then
      'Финальное количество по ветровому расчету. Длину крепежа подбирать по максимальной толщине участка: основной пирог + уклон/контруклон; учитывать тип основания и минимальное заглубление по техлисту.'
    else l.formula_text
  end,
  source_note = case
    when t.layer_key = 'slope_layer' then
      'Основную кровлю считать отдельно; уклонку добавлять после расчета поля. Воронки и их смещение брать из проекта, не назначать произвольно.'
    when t.layer_key = 'membrane_fastener' then
      'Если уклонка есть, базовая толщина утеплителя недостаточна для выбора длины крепежа; нужна максимальная толщина в зоне.'
    else l.source_note
  end,
  constraints = l.constraints || case
    when t.layer_key = 'slope_layer' then
      '{
        "requires_slope_layout": true,
        "do_not_calculate_by_total_area_only": true,
        "required_inputs": [
          "slope_type",
          "shape_type",
          "distance_between_drains_or_triangle_base",
          "drain_offset_from_parapet",
          "slope_percent",
          "same_shapes_count",
          "base_roof_build_up_thickness"
        ]
      }'::jsonb
    when t.layer_key = 'membrane_fastener' then
      '{
        "requires_wind_calculation": true,
        "requires_max_build_up_thickness": true,
        "minimum_embedment_mm_reference": 40
      }'::jsonb
    else '{}'::jsonb
  end
from target_layers t
where l.id = t.id;

with system_rows as (
  select id, slug
  from public.cpq_systems
  where slug in ('tn_roof_klassik', 'tn_roof_smart_pir')
),
rule_rows(system_slug, rule_key, role, sequence_no, formula_code, formula_text, input_requirements, output_unit, factor, requires_geometry, notes) as (
  values
    ('tn_roof_klassik','slope_counter_slope_layout','уклонка/контруклон',55,'slope_layout_elements',
      'Уклонку и контруклон считать не по общей площади, а по раскладке фигур вокруг воронок. Результат: количество элементов/марок клиновидных плит.',
      '{"required":["slope_type","shape_type","distance_between_drains_or_triangle_base","drain_offset_from_parapet","slope_percent","same_shapes_count","base_roof_build_up_thickness"]}'::jsonb,
      'elements',null,true,
      'Сначала считать основную кровлю, затем добавлять уклонку отдельным блоком.'),
    ('tn_roof_klassik','fastener_length_max_build_up','крепеж',56,'fastener_length_by_max_thickness',
      'Длину телескопа/самореза выбирать по максимальной толщине участка: основной пирог + высота уклона/контруклона; заглубление сверять по техлисту крепежа и основанию.',
      '{"required":["basis","base_roof_build_up_thickness","max_slope_height","fastener_embedment_requirement"]}'::jsonb,
      'mm',null,true,
      'Без максимальной толщины участка показывать только предварительный ориентир, не счетную длину.'),

    ('tn_roof_smart_pir','slope_counter_slope_layout','уклонка/контруклон',55,'slope_layout_elements',
      'Уклонку и контруклон считать не по общей площади, а по раскладке фигур вокруг воронок. Результат: количество элементов/марок клиновидных плит.',
      '{"required":["slope_type","shape_type","distance_between_drains_or_triangle_base","drain_offset_from_parapet","slope_percent","same_shapes_count","base_roof_build_up_thickness"]}'::jsonb,
      'elements',null,true,
      'Сначала считать основную кровлю, затем добавлять уклонку отдельным блоком.'),
    ('tn_roof_smart_pir','fastener_length_max_build_up','крепеж',56,'fastener_length_by_max_thickness',
      'Длину телескопа/самореза выбирать по максимальной толщине участка: основной пирог + высота уклона/контруклона; заглубление сверять по техлисту крепежа и основанию.',
      '{"required":["basis","base_roof_build_up_thickness","max_slope_height","fastener_embedment_requirement"]}'::jsonb,
      'mm',null,true,
      'Без максимальной толщины участка показывать только предварительный ориентир, не счетную длину.')
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

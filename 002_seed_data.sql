-- 002_seed_data.sql
-- Начальные данные: производители (с is_competitor), категории и первые SKU цилиндров.

alter table public.manufacturers
  add column if not exists is_competitor boolean not null default false;

-- Производители
insert into public.manufacturers (name_ru, name_en, is_competitor, synonyms, website)
values
  ('ТехноНИКОЛЬ', 'TechnoNICOL', false, array['тн', 'technonicol'], 'https://www.tn.ru'),
  ('Rockwool', 'Rockwool', true, array['роквул'], 'https://www.rockwool.com'),
  ('ISOVER', 'ISOVER', true, array['изовер'], 'https://www.isover.ru'),
  ('KNAUF Insulation', 'KNAUF', true, array['кнауф'], 'https://www.knaufinsulation.ru')
on conflict do nothing;

-- 18 ключевых категорий
insert into public.categories (slug, name_ru, description, sort_order)
values
  ('cylinders-standard', 'Цилиндры стандарт', 'Базовые теплоизоляционные цилиндры', 10),
  ('cylinders-folie', 'Цилиндры фольгированные', 'Исполнение с покрытием фольгой', 20),
  ('cylinders-outdoor', 'Цилиндры наружные', 'Для наружного применения', 30),
  ('bends', 'Отводы', 'Фасонные элементы: отводы', 40),
  ('tees', 'Тройники', 'Фасонные элементы: тройники', 50),
  ('reducers', 'Переходы', 'Фасонные элементы: переходы', 60),
  ('plugs', 'Заглушки', 'Заглушки и торцевые элементы', 70),
  ('mounting-kits', 'Монтажные комплекты', 'Ленты, проволока, скобы', 80),
  ('al-shell', 'Алюминиевые кожухи', 'Защитные оболочки', 90),
  ('galv-shell', 'Оцинкованные кожухи', 'Металлическая защита', 100),
  ('vapor-barrier', 'Пароизоляция', 'Пароизоляционные материалы', 110),
  ('fire-protection', 'Огнезащита', 'Решения по огнезащите', 120),
  ('cold-lines', 'Холодоснабжение', 'Решения для холодных трубопроводов', 130),
  ('hot-lines', 'Теплосети', 'Решения для высоких температур', 140),
  ('industrial', 'Промышленная изоляция', 'Промышленный сегмент', 150),
  ('housing', 'ЖКХ', 'Жилищно-коммунальный сегмент', 160),
  ('cert-docs', 'Сертификаты и ТУ', 'Нормативные документы', 170),
  ('sales-assets', 'Материалы для продаж', 'Скрипты, FAQ, допродажи', 180)
on conflict (slug) do nothing;

-- SKU цилиндров (первые позиции)
with m as (
  select id, name_ru from public.manufacturers
),
c as (
  select id, slug from public.categories
)
insert into public.products (
  manufacturer_id,
  category_id,
  sku,
  name,
  product_type,
  coating,
  flammability,
  density,
  density_min,
  density_max,
  thickness,
  thickness_min,
  thickness_max,
  temp_min,
  temp_max,
  diameter_min,
  diameter_max,
  is_active
)
select
  (select id from m where name_ru = 'ТехноНИКОЛЬ'),
  (select id from c where slug = 'cylinders-folie'),
  'TN-CYL-089-040-AF',
  'Цилиндр ТН AF DU89x40',
  'навивной',
  'АФ',
  'НГ',
  90,
  85,
  95,
  40,
  40,
  40,
  -60,
  650,
  89,
  89,
  true
where not exists (select 1 from public.products where sku = 'TN-CYL-089-040-AF')
union all
select
  (select id from m where name_ru = 'ТехноНИКОЛЬ'),
  (select id from c where slug = 'cylinders-standard'),
  'TN-CYL-108-050-NF',
  'Цилиндр ТН NF DU108x50',
  'навивной',
  'НФ',
  'НГ',
  100,
  95,
  105,
  50,
  50,
  50,
  -60,
  650,
  108,
  108,
  true
where not exists (select 1 from public.products where sku = 'TN-CYL-108-050-NF')
union all
select
  (select id from m where name_ru = 'Rockwool'),
  (select id from c where slug = 'cylinders-folie'),
  'RW-100-076-040-AL',
  'Rockwool 100 DU76x40 AL',
  'навивной',
  'AL',
  'НГ',
  100,
  95,
  110,
  40,
  40,
  40,
  -50,
  680,
  76,
  76,
  true
where not exists (select 1 from public.products where sku = 'RW-100-076-040-AL')
union all
select
  (select id from m where name_ru = 'ISOVER'),
  (select id from c where slug = 'cylinders-standard'),
  'IS-CYL-089-030-NF',
  'ISOVER DU89x30 NF',
  'навивной',
  'НФ',
  'НГ',
  90,
  80,
  95,
  30,
  30,
  30,
  -50,
  600,
  89,
  89,
  true
where not exists (select 1 from public.products where sku = 'IS-CYL-089-030-NF')
union all
select
  (select id from m where name_ru = 'KNAUF Insulation'),
  (select id from c where slug = 'cylinders-outdoor'),
  'KN-CYL-133-060-FTU',
  'KNAUF DU133x60 FT-У',
  'термонавивной',
  'ФТ-У',
  'НГ',
  110,
  105,
  120,
  60,
  60,
  60,
  -50,
  700,
  133,
  133,
  true
where not exists (select 1 from public.products where sku = 'KN-CYL-133-060-FTU');


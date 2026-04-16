begin;

-- Manufacturers
insert into public.manufacturers (name_ru, name_en, synonyms, website, phone, tu)
values
  ('ЭКОРОЛЛ', 'ECOROLL', array['Экоролл', 'ECOROLL'], 'https://ecoroll.ru', null, '23.99.19-004-21610045-2018'),
  ('XOTPIPE', 'XOTPIPE', array['Хотпайп', 'ХОТПАЙП'], 'https://xotpipe.ru', '8-800-333-63-61', '23.99.19-007-39049991-2021'),
  ('BOS', 'BOS', array['Бос', 'БОС', 'BOS-PIPE'], 'https://bos-pro.ru', '8-800-775-14-72', '5769-007-09740968-2015'),
  ('ISOTEC', 'ISOTEC', array['Изотек', 'ИЗОТЕК'], 'https://isotecti.ru', '+7-495-228-81-10', '23.99.19-104-56846022-2016'),
  ('CUTWOOL', 'CUTWOOL', array['Катвул', 'КАТВУЛ', 'CUTWOOL'], null, null, '5762-002-89646568-2013'),
  ('ROCKWOOL', 'ROCKWOOL', array['Роквул', 'РОКВУЛ'], 'https://www.rockwool.com/ru', null, '5762-050-45757203-15')
on conflict do nothing;

-- Products
with m as (
  select id, name_ru from public.manufacturers
)
insert into public.products (
  manufacturer_id, name, product_type, coating, flammability,
  density_min, density_max, temp_min, temp_max, diameter_min, diameter_max,
  thickness_min, thickness_max, length, lambda_10, lambda_25, lambda_125, lambda_300,
  has_lock, lock_type, outdoor_use, application_notes, is_active
)
values
-- ECOROLL (12)
((select id from m where name_ru='ЭКОРОЛЛ'),'КВ-80 без покрытия','вырезной','без покрытия','НГ',61,80,-180,450,10,1420,20,200,1000,0.034,0.036,0.047,0.086,true,'шип-паз',false,null,true),
((select id from m where name_ru='ЭКОРОЛЛ'),'КВ-100 без покрытия','вырезной','без покрытия','НГ',81,100,-180,550,10,1420,20,200,1000,0.035,0.036,0.047,0.086,true,'шип-паз',false,null,true),
((select id from m where name_ru='ЭКОРОЛЛ'),'КВ-120 без покрытия','вырезной','без покрытия','НГ',101,120,-180,650,10,1420,20,200,1000,0.035,0.037,0.048,0.080,true,'шип-паз',false,null,true),
((select id from m where name_ru='ЭКОРОЛЛ'),'КВ-150 без покрытия','вырезной','без покрытия','НГ',126,150,-180,680,10,1420,20,200,1000,0.036,0.037,0.048,0.080,true,'шип-паз',false,null,true),
((select id from m where name_ru='ЭКОРОЛЛ'),'КВ-80 Ф','вырезной','НФ','НГ',61,80,-180,450,10,1420,20,200,1000,0.034,0.036,0.047,0.086,true,'шип-паз',false,'Только внутри помещений, не под оцинковку',true),
((select id from m where name_ru='ЭКОРОЛЛ'),'КВ-100 Ф','вырезной','НФ','НГ',81,100,-180,550,10,1420,20,200,1000,0.035,0.036,0.047,0.086,true,'шип-паз',false,'Только внутри помещений, не под оцинковку',true),
((select id from m where name_ru='ЭКОРОЛЛ'),'КВ-120 Ф','вырезной','НФ','НГ',101,120,-180,650,10,1420,20,200,1000,0.035,0.037,0.048,0.080,true,'шип-паз',false,'Только внутри помещений, не под оцинковку',true),
((select id from m where name_ru='ЭКОРОЛЛ'),'КВ-80 ФА','вырезной','ФА','Г1',61,80,-180,450,10,1420,20,200,1000,0.034,0.036,0.047,0.086,true,'шип-паз',false,'Подвалы/каналы, не использовать в котельных',true),
((select id from m where name_ru='ЭКОРОЛЛ'),'КВ-100 ФА','вырезной','ФА','Г1',81,100,-180,550,10,1420,20,200,1000,0.035,0.036,0.047,0.086,true,'шип-паз',false,'Подвалы/каналы, не использовать в котельных',true),
((select id from m where name_ru='ЭКОРОЛЛ'),'КВ-80 ФТ','вырезной','ФТ','Г1',61,80,-180,450,10,1420,20,200,1000,0.034,0.036,0.047,0.086,true,'шип-паз',false,'Для помещений',true),
((select id from m where name_ru='ЭКОРОЛЛ'),'КВ-80 ФТ-У','вырезной','ФТ-У','Г1',61,80,-180,450,10,1420,20,200,1000,0.034,0.036,0.047,0.086,true,'шип-паз',true,'Можно на улице без оцинковки',true),
((select id from m where name_ru='ЭКОРОЛЛ'),'КВ-100 ФТ-У','вырезной','ФТ-У','Г1',81,100,-180,550,10,1420,20,200,1000,0.035,0.036,0.047,0.086,true,'шип-паз',true,'Можно на улице без оцинковки',true),

-- XOTPIPE (6)
((select id from m where name_ru='XOTPIPE'),'SP Alu1 80кг','навивной','НФ','НГ',80,80,-200,450,6,1420,20,150,1000,null,0.037,0.053,null,true,'шип-паз продольный',false,'Только помещения, на улице нужна доп.защита',true),
((select id from m where name_ru='XOTPIPE'),'SP Alu1 100кг','навивной','НФ','НГ',100,100,-200,550,6,1420,20,150,1000,null,0.037,0.051,null,true,'шип-паз продольный',false,'Только помещения, на улице нужна доп.защита',true),
((select id from m where name_ru='XOTPIPE'),'SP Alu1 120кг','навивной','НФ','НГ',120,120,-200,650,6,1420,20,150,1000,null,0.038,0.052,null,true,'шип-паз продольный',false,'Только помещения, на улице нужна доп.защита',true),
((select id from m where name_ru='XOTPIPE'),'SP Alu1 Connect','навивной','НФ','НГ',80,120,-200,650,6,1420,60,150,1170,null,0.038,0.052,null,true,'шип-паз продольный+торцевой',false,'Только прямые участки без фасонных элементов',true),
((select id from m where name_ru='XOTPIPE'),'SP Alu1 Combi','навивной','НФ','НГ',80,120,-200,650,6,1420,90,150,1000,null,0.038,0.052,null,true,'шип-паз продольный',false,'Для температур выше 250°C, муллитокремнеземистая вставка',true),
((select id from m where name_ru='XOTPIPE'),'SP 100 ALU (Г1)','навивной','АФ','Г1',80,120,-200,550,6,1420,20,150,1000,null,0.037,0.051,null,true,'шип-паз продольный',false,null,true),

-- BOS (6)
((select id from m where name_ru='BOS'),'BOS-PIPE без обкладки','вырезной','без покрытия','НГ',80,150,-60,900,10,1020,20,120,1000,null,0.037,0.046,0.089,true,'шип-паз',false,'λ зависит от плотности: 80/100/120кг',true),
((select id from m where name_ru='BOS'),'BOS-PIPE НФ','вырезной','НФ','НГ',80,120,-60,900,10,1020,20,120,1000,null,0.037,0.046,0.089,true,'шип-паз',false,null,true),
((select id from m where name_ru='BOS'),'BOS-PIPE АФ','вырезной','АФ','Г1',80,120,-60,900,10,1020,20,120,1000,null,0.037,0.046,0.089,true,'шип-паз',false,null,true),
((select id from m where name_ru='BOS'),'BOS-PIPE в обкладке стеклотканью','вырезной','СТ','НГ',80,120,-60,900,10,1020,20,120,1000,null,0.037,0.046,0.089,true,'шип-паз',false,null,true),
((select id from m where name_ru='BOS'),'BOS-PIPE в обкладке базальтовой тканью','вырезной','БТ','НГ',80,120,-60,900,10,1020,20,120,1000,null,0.037,0.046,0.089,true,'шип-паз',false,null,true),
((select id from m where name_ru='BOS'),'BOS-LPIPE ламельный','навивной','без покрытия','НГ',50,80,-60,900,60,820,30,120,1000,null,0.038,0.050,0.090,false,null,false,null,true),

-- ISOTEC Shell + Section AL2 (5)
((select id from m where name_ru='ISOTEC'),'Shell без покрытия','вырезной','без покрытия','НГ',90,90,-180,600,18,1020,30,170,1000,0.039,0.046,0.067,0.110,true,'шип-паз',false,null,true),
((select id from m where name_ru='ISOTEC'),'Shell-AL','вырезной','AL','Г1',90,90,-180,600,18,1020,30,170,1000,0.039,0.046,0.067,0.110,true,'шип-паз',false,'Фольга выдерживает максимум 100°C на поверхности',true),
((select id from m where name_ru='ISOTEC'),'Section AL2 20мм','термонавивной','AL2','НГ',160,160,-180,680,18,273,20,20,1200,0.036,0.038,0.048,0.087,false,null,false,'Подходит для котельных и ИТП, можно уменьшить толщину до 30%',true),
((select id from m where name_ru='ISOTEC'),'Section AL2 30мм','термонавивной','AL2','НГ',125,125,-180,640,18,273,30,30,1200,0.036,0.039,0.049,0.089,false,null,false,'Подходит для котельных и ИТП',true),
((select id from m where name_ru='ISOTEC'),'Section AL2 70-100мм','термонавивной','AL2','НГ',100,100,-180,620,18,273,70,100,1200,0.036,0.039,0.050,0.090,false,null,false,'Подходит для котельных и ИТП',true),

-- CUTWOOL (4)
((select id from m where name_ru='CUTWOOL'),'CL без покрытия','вырезной','без покрытия','НГ',80,120,-180,600,18,1020,20,120,1000,null,0.038,0.050,0.090,true,'шип-паз',false,null,true),
((select id from m where name_ru='CUTWOOL'),'CL AL','вырезной','AL','Г1',80,120,-180,600,18,1020,20,120,1000,null,0.038,0.050,0.090,true,'шип-паз',false,null,true),
((select id from m where name_ru='CUTWOOL'),'CL Protect','вырезной','НГ арм.базальтом','КМ0',100,130,-180,250,18,1020,20,120,1000,null,0.032,0.041,0.072,true,'U-замок',false,'Армирование базальтовой тканью, повышенная механическая стойкость',true),
((select id from m where name_ru='CUTWOOL'),'CL Protect OUTSIDE','вырезной','НГ арм.базальтом','НГ',100,130,-180,250,18,1020,20,120,1000,null,0.032,0.041,0.072,true,'U-замок',true,'Специально для открытого воздуха',true),

-- ROCKWOOL (2)
((select id from m where name_ru='ROCKWOOL'),'RWL 100','навивной','без покрытия','НГ',114,114,-180,650,18,1020,20,120,1000,null,0.040,0.052,0.090,false,null,false,'Для промышленных трубопроводов, высокая вибростойкость',true),
((select id from m where name_ru='ROCKWOOL'),'RWL 150','навивной','без покрытия','НГ',145,145,-180,650,18,1020,20,120,1000,null,0.041,0.053,0.091,false,null,false,null,true);

-- Certificates
insert into public.certificates (product_id, cert_type, cert_number, valid_until, issuer, notes)
values
((select p.id from public.products p join public.manufacturers m on p.manufacturer_id=m.id where m.name_ru='ROCKWOOL' and p.name='RWL 100' limit 1),'пожарный','RU C-RU.ЧС13.В.00455/25','2030-04-15','ОС «ПОЖТЕСТ» ФГБУ ВНИИПО МЧС России',null),
((select p.id from public.products p join public.manufacturers m on p.manufacturer_id=m.id where m.name_ru='ЭКОРОЛЛ' and p.name='КВ-80 без покрытия' limit 1),'пожарный','C-RU.ПБ 68.В.01732 №0454693','2028-07-31',null,'цилиндры'),
((select p.id from public.products p join public.manufacturers m on p.manufacturer_id=m.id where m.name_ru='ЭКОРОЛЛ' and p.name='КВ-100 без покрытия' limit 1),'СС','РОСС RU.ПБ44.Н17238 №1472226','2027-05-12',null,'цилиндры'),
((select p.id from public.products p join public.manufacturers m on p.manufacturer_id=m.id where m.name_ru='ЭКОРОЛЛ' and p.name='КВ-120 без покрытия' limit 1),'СС','РОСС RU.ПБ44.Н16854','2027-03-18',null,'оболочки'),
((select p.id from public.products p join public.manufacturers m on p.manufacturer_id=m.id where m.name_ru='ЭКОРОЛЛ' and p.name='КВ-80 Ф' limit 1),'пожарный','RU C-RU.ПБ37.В.01115/23','2028-11-30',null,'ПС'),
((select p.id from public.products p join public.manufacturers m on p.manufacturer_id=m.id where m.name_ru='BOS' and p.name='BOS-PIPE без обкладки' limit 1),'пожарный','RU C-RU.ЧС13.В.00411/23','2028-02-09',null,null),
((select p.id from public.products p join public.manufacturers m on p.manufacturer_id=m.id where m.name_ru='BOS' and p.name='BOS-PIPE НФ' limit 1),'пожарный','RU C-RU.ЧС13.В.00412/23','2028-02-09',null,null),
((select p.id from public.products p join public.manufacturers m on p.manufacturer_id=m.id where m.name_ru='BOS' and p.name='BOS-PIPE АФ' limit 1),'СС','№04ИДЮ0.117.RU.Н.00157','2027-11-14',null,'добровольный'),
((select p.id from public.products p join public.manufacturers m on p.manufacturer_id=m.id where m.name_ru='BOS' and p.name='BOS-PIPE без обкладки' limit 1),'декларация','РОСС RU Д-RU.PA01.В.33338/23','2026-08-28',null,null),
((select p.id from public.products p join public.manufacturers m on p.manufacturer_id=m.id where m.name_ru='BOS' and p.name='BOS-PIPE НФ' limit 1),'морской регистр','№20.51206.130','2025-11-16',null,null),
((select p.id from public.products p join public.manufacturers m on p.manufacturer_id=m.id where m.name_ru='ISOTEC' and p.name='Shell без покрытия' limit 1),'декларация','РОСС RU Д-RU.PA02.В.14699/21','2026-12-29',null,null),
((select p.id from public.products p join public.manufacturers m on p.manufacturer_id=m.id where m.name_ru='ISOTEC' and p.name='Section AL2 20мм' limit 1),'пожарный','RU C-RU.ПБ37.В.00347/20','2025-09-17',null,'АЛ2');

-- Diameter conversion
insert into public.diameter_conversion (du, outer_diameter_steel, outer_diameter_copper, insulation_diameter_mineral)
values
  (6,10,10,10),(8,13.5,13.5,14),(10,17.2,17.2,18),(15,21.3,22,22),(20,26.9,28,28),
  (25,33.7,35,35),(32,42.4,42,42),(40,48.3,54,48),(50,60.3,64,60),(65,76.1,76,76),
  (80,88.9,89,89),(100,114.3,108,114),(125,139.7,133,140),(150,168.3,159,168),
  (200,219.1,219,219),(250,273,273,273),(300,323.9,325,324),(350,355.6,355,356),
  (400,406.4,406,406),(500,508,508,508)
on conflict (du) do update set
  outer_diameter_steel=excluded.outer_diameter_steel,
  outer_diameter_copper=excluded.outer_diameter_copper,
  insulation_diameter_mineral=excluded.insulation_diameter_mineral;

-- Selection rules
insert into public.selection_rules (rule_name, condition, rule_text, priority, is_prohibition)
values
('Фольга + оцинковка — ЗАПРЕТ','фольга+оцинковка','Категорически запрещено комбинировать любую фольгу (НФ, АФ, Ф, ФА, AL, AL2) с оцинкованной окожушкой. Нарушение паробарьера приводит к коррозии трубы.',1,true),
('Г1 в котельных — ЗАПРЕТ','котельная','В котельных, шахтах лифтов и зонах с повышенными требованиями пожарной безопасности допускается только НГ покрытие. Г1 запрещено.',1,true),
('Г1 на улице — ЗАПРЕТ','улица','Цилиндры с покрытием Г1 (армированная фольга) запрещены к применению на открытом воздухе.',1,true),
('НФ фольга не под оцинковку','НФ+оцинковка','Неармированная фольга НГ не ставится под оцинкованную окожушку. Это нарушает паробарьер.',1,true),
('Улица только ФТ-У или OUTSIDE','улица без доп.защиты','На открытом воздухе без дополнительной механической защиты допускается: ЭКОРОЛЛ ФТ-У, CUTWOOL CL Protect OUTSIDE. Остальные серии требуют оцинкованной окожушки или BOS-PROTECTION ФА.',2,false),
('ИТП и тепловые пункты — НГ обязательно','ИТП ЦТП тепловой пункт','Согласно СП 41-101-95 в тепловых пунктах обязательна негорючая (НГ) изоляция. Подходят: ISOTEC Section AL2, XOTPIPE SP Alu1, BOS-PIPE НФ, ЭКОРОЛЛ Ф или без покрытия.',1,false),
('Лента к НГ фольге','НГ фольга монтаж','К цилиндрам с НГ фольгой (неармированной) использовать алюминиевую ленту НЕАРМИРОВАННУЮ самоклеящуюся.',3,false),
('Лента к Г1 фольге','Г1 фольга монтаж','К цилиндрам с Г1 фольгой (армированной) использовать алюминиевую ленту АРМИРОВАННУЮ самоклеящуюся.',3,false),
('Проволока вязальная — всегда','любой монтаж','В каждое КП добавлять проволоку вязальную оцинкованную d=1.2мм. Расход: 2м на 1 п.м. изоляции.',3,false),
('При ДУ/DN пересчитывать диаметр','ДУ DN указан в заявке','Если в заявке указан ДУ или DN — это условный проход, не наружный диаметр трубы. Необходимо перевести через таблицу diameter_conversion в наружный диаметр трубы, а затем подобрать цилиндр с соответствующим внутренним диаметром.',1,false),
('Толщина изоляции по назначению','подбор толщины','Ориентировочные толщины: отопление до 95°C = 30-50мм; ГВС до 75°C = 40-50мм; ХВС = 20-40мм; пар до 200°C = 60-100мм; улица = 80-120мм.',2,false),
('ISOTEC AL2 экономия толщины','ISOTEC AL2','Термонавивная технология ISOTEC Section AL2 позволяет уменьшить толщину стенки до 30% по сравнению с вырезными цилиндрами за счёт большей плотности и равномерного распределения теплопроводности.',2,false);

-- Accessories
insert into public.accessories (name, description, apply_with, manufacturer_id)
values
('Проволока вязальная оцинкованная d=1.2мм','Для фиксации цилиндров при монтаже',array['НГ','Г1','без покрытия'],null),
('Лента алюминиевая самоклеящаяся неармированная 50мм','Для НГ фольги',array['НГ'],null),
('Лента алюминиевая самоклеящаяся армированная 50мм','Для Г1 фольги',array['Г1'],null),
('Хомуты металлические BOS-Buckle','Металлические хомуты для фиксации',array['НГ','Г1','без покрытия'],(select id from public.manufacturers where name_ru='BOS' limit 1)),
('BOS-PROTECTION ФА (покрытие для улицы)','Защитное покрытие для наружной эксплуатации',array['без покрытия'],(select id from public.manufacturers where name_ru='BOS' limit 1)),
('Кожух оцинкованный','Дополнительная механическая защита',array['без покрытия'],null);

commit;

# Insulation Knowledge Base

Обновлённый набор для AI-подбора и интеграции с n8n:

- `001_knowledge_base_schema.sql` — основная схема (enum, категории, связи, синхронизация чанков, RPC).
- `002_seed_data.sql` — начальные производители/категории/SKU.
- `003_api_context_route.ts` — новый пример `GET /api/ai-context` с фильтрами.

## Порядок запуска после миграции

1. Применить SQL схему:
```sql
-- в Supabase SQL Editor
-- выполнить содержимое 001_knowledge_base_schema.sql
```

2. Применить seed:
```sql
-- выполнить содержимое 002_seed_data.sql
```

3. Проверить синхронизацию чанков:
```sql
-- массовая синхронизация существующих документов
update public.documents
set extracted_text = extracted_text
where coalesce(extracted_text, '') <> '';
```

4. Проверить RPC для n8n:
```sql
select * from public.get_ai_context(
  p_query := 'цилиндр du 108 фольга',
  p_intents := array['selection','manager'],
  p_doc_types := array['script','tds'],
  p_product_id := null,
  p_limit := 10
);
```

## Новый `/api/ai-context`

Поддерживаемые query-параметры:

- `query` или `q` — текст вопроса.
- `intent=selection,manager` — фильтр по intent tags.
- `doc_types=script,tds` — фильтр по типам документа.
- `product_id=<uuid>` — жёсткий фильтр по продукту.
- `limit=12` — лимит элементов контекста.

## intent_tags по типам вопросов

| Тип вопроса | intent_tags |
|---|---|
| Подбор SKU | `selection` |
| Что сказать клиенту | `manager`, `script` |
| Сравнение брендов | `comparison` |
| Совместимость узлов | `compatibility` |
| Цена/смета | `price` |
| Доставка/сроки | `delivery` |
| Сертификаты/ТУ | `certificate` |
| FAQ / возражения | `faq` |

## Что важно для n8n

- n8n может вызывать `RPC get_ai_context` напрямую через Supabase.
- Либо использовать route `/api/ai-context` (пример в `003_api_context_route.ts`).
- Внизу `003_api_context_route.ts` уже есть `SYSTEM_PROMPT_N8N` с правилами:
  - приоритет кода товара,
  - правила подбора,
  - допродажи (upsell/cross-sell).

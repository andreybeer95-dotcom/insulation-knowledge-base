# Insulation Knowledge Base

Веб-приложение базы знаний по теплоизоляционным цилиндрам на `Next.js + Supabase + Tailwind CSS`.

## Реализовано

- Supabase схема и миграции (10 таблиц, индексы, RLS, FTS, storage bucket `documents`).
- Seed-данные в `supabase/seed.sql`.
- API routes:
  - `/api/products` (GET, POST), `/api/products/[id]` (GET, PUT, DELETE)
  - `/api/search`
  - `/api/diameter-convert`
  - `/api/certificates`
  - `/api/ai-context`
  - `/api/rules` (GET, POST, PUT)
  - `/api/manufacturers` (GET, POST)
  - `/api/documents` (GET, POST)
  - `/api/documents/extract` (POST, `pdf-parse`)
  - `/api/notes` (GET, POST, PUT, DELETE)
  - `/api/prices` (GET, POST)
- Admin UI:
  - `/admin/products`, `/admin/products/new`, `/admin/products/edit/[id]`
  - `/admin/documents`, `/admin/notes`, `/admin/certificates`
  - `/admin/rules`, `/admin/prices`, `/admin/changelog`, `/admin/manufacturers`
- Базовая auth-защита `/admin` через Supabase session cookies + страница `/login`.

## 1) Как запустить миграции в Supabase

1. Установите [Supabase CLI](https://supabase.com/docs/guides/cli).
2. В корне проекта выполните:

```bash
supabase login
supabase link --project-ref <YOUR_PROJECT_REF>
supabase db push
```

Альтернатива: открыть SQL Editor в Supabase и выполнить по очереди SQL из:
- `supabase/migrations/20260415162000_init_knowledge_base.sql`
- `supabase/migrations/20260415170000_expand_product_coating_values.sql`

## 2) Как залить seed-данные

Вариант A (через CLI):

```bash
supabase db reset
```

`db reset` применит миграции и `supabase/seed.sql`.

Вариант B (через SQL Editor):
- Выполните содержимое `supabase/seed.sql` вручную после миграций.

## 3) Как запустить проект локально

1. Установите зависимости:

```bash
npm install
```

2. Создайте `.env.local` (можно скопировать `.env.local.example`) и заполните:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

3. Запустите dev-сервер:

```bash
npm run dev
```

4. Откройте:
- `http://localhost:3000`
- `http://localhost:3000/admin`

## 4) Как подключить n8n к `/api/ai-context`

1. В n8n создайте `HTTP Request` node:
   - Method: `GET`
   - URL: `http://localhost:3000/api/ai-context`
   - Query param: `query={{$json.user_query}}`

2. Формат ответа endpoint:
- `detected` (производители, ДУ, ключевые слова)
- `relevant_products`
- `applicable_rules`
- `relevant_notes`
- `current_prices`
- `formatted_context` (готовый контекст для Claude API как system/input prompt)

3. Дальше передайте `formatted_context` в node с LLM (Claude/OpenAI) как системный контекст.

## Примечания

- Для загрузки документов используйте bucket `documents`.
- Для write-операций в `/api/products` требуется `Authorization: Bearer <access_token>`.

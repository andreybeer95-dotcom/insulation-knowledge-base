-- Создаём таблицу document_chunks
CREATE TABLE IF NOT EXISTS document_chunks (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  content text NOT NULL,
  chunk_index integer NOT NULL DEFAULT 0,
  metadata jsonb DEFAULT '{}',
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('russian', content)
  ) STORED,
  created_at timestamptz DEFAULT now()
);

-- Индексы
CREATE INDEX IF NOT EXISTS idx_document_chunks_document_id
  ON document_chunks(document_id);

CREATE INDEX IF NOT EXISTS idx_document_chunks_search_vector
  ON document_chunks USING gin(search_vector);

-- RLS
ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access"
  ON document_chunks FOR ALL
  USING (true)
  WITH CHECK (true);

-- RPC функция для поиска с ts_rank
CREATE OR REPLACE FUNCTION search_chunks_ranked(
  search_query text,
  result_limit integer DEFAULT 15
)
RETURNS TABLE (
  id uuid,
  content text,
  chunk_index integer,
  document_id uuid,
  metadata jsonb,
  rank real,
  documents jsonb
)
LANGUAGE sql STABLE AS $$
  SELECT
    dc.id,
    dc.content,
    dc.chunk_index,
    dc.document_id,
    dc.metadata,
    ts_rank(dc.search_vector, to_tsquery('russian', search_query)) AS rank,
    jsonb_build_object(
      'id',   d.id,
      'name', d.name,
      'manufacturers', CASE
        WHEN m.id IS NOT NULL THEN jsonb_build_object('name', m.name)
        ELSE NULL
      END
    ) AS documents
  FROM document_chunks dc
  JOIN documents d ON d.id = dc.document_id
  LEFT JOIN manufacturers m ON m.id = d.manufacturer_id
  WHERE dc.search_vector @@ to_tsquery('russian', search_query)
  ORDER BY rank DESC
  LIMIT result_limit;
$$;


ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS documents_file_hash_idx ON documents(file_hash);

-- Titan v2 embeddings are derived data; rebuilding them changes no saved content.
CREATE TABLE search_vectors (
  user_id text NOT NULL,
  id text NOT NULL,
  embedding vector(1024) NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}',
  search_text text NOT NULL DEFAULT '',
  search_document tsvector GENERATED ALWAYS AS (to_tsvector('english', search_text)) STORED,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX search_vectors_cosine ON search_vectors USING hnsw (embedding vector_cosine_ops);
CREATE INDEX search_vectors_full_text ON search_vectors USING gin (search_document);
ALTER TABLE search_vectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_vectors FORCE ROW LEVEL SECURITY;
CREATE POLICY search_vectors_read ON search_vectors FOR SELECT TO kody_reader, kody_writer
  USING (user_id = current_setting('app.user_id', true) OR user_id = '__kody_builtin__');
CREATE POLICY search_vectors_insert ON search_vectors FOR INSERT TO kody_writer
  WITH CHECK (user_id = current_setting('app.user_id', true) AND user_id <> '__kody_builtin__');
CREATE POLICY search_vectors_update ON search_vectors FOR UPDATE TO kody_writer
  USING (user_id = current_setting('app.user_id', true) AND user_id <> '__kody_builtin__')
  WITH CHECK (user_id = current_setting('app.user_id', true) AND user_id <> '__kody_builtin__');
CREATE POLICY search_vectors_delete ON search_vectors FOR DELETE TO kody_writer
  USING (user_id = current_setting('app.user_id', true) AND user_id <> '__kody_builtin__');
GRANT SELECT ON search_vectors TO kody_reader;
GRANT SELECT, INSERT, UPDATE, DELETE ON search_vectors TO kody_writer;

-- The builtin indexer has no privileges on user-owned application tables.
CREATE ROLE kody_indexer NOLOGIN;
GRANT USAGE ON SCHEMA public TO kody_indexer;
GRANT SELECT, INSERT, UPDATE, DELETE ON search_vectors TO kody_indexer;
CREATE POLICY search_vectors_builtin_indexer ON search_vectors TO kody_indexer
  USING (user_id = '__kody_builtin__') WITH CHECK (user_id = '__kody_builtin__');

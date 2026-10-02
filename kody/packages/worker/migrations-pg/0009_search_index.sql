-- Builtin capability reindex runs as kody_indexer. Its embed skip cache is the
-- builtin owner's fingerprint rows only; user fingerprints stay under owner RLS.
GRANT SELECT, INSERT, UPDATE, DELETE ON vector_embed_fingerprints TO kody_indexer;
CREATE POLICY vector_embed_fingerprints_builtin_indexer ON vector_embed_fingerprints TO kody_indexer
  USING (user_id = '__kody_builtin__') WITH CHECK (user_id = '__kody_builtin__');

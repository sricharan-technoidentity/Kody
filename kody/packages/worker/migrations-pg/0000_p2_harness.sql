CREATE EXTENSION IF NOT EXISTS vector;
CREATE ROLE kody_writer NOLOGIN;
CREATE ROLE kody_reader NOLOGIN;

-- P2's smallest relational fixture. P3 adds the application schema.
CREATE TABLE isolation_probe (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  value text NOT NULL
);
ALTER TABLE isolation_probe ENABLE ROW LEVEL SECURITY;
ALTER TABLE isolation_probe FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation_probe_owner ON isolation_probe
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));
GRANT USAGE ON SCHEMA public TO kody_writer, kody_reader;
GRANT SELECT, INSERT, UPDATE, DELETE ON isolation_probe TO kody_writer;
GRANT SELECT ON isolation_probe TO kody_reader;

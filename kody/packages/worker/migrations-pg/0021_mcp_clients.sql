-- Remote MCP registrations and non-secret episode state; OAuth material is in Identity.
CREATE TABLE mcp_client_hubs (
  user_id TEXT PRIMARY KEY,
  version BIGINT NOT NULL DEFAULT 0,
  rows_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE mcp_client_values (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT,
  credential BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, key)
);
ALTER TABLE mcp_client_hubs ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_client_hubs FORCE ROW LEVEL SECURITY;
ALTER TABLE mcp_client_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_client_values FORCE ROW LEVEL SECURITY;
CREATE POLICY mcp_client_hubs_owner ON mcp_client_hubs TO kody_reader, kody_writer
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));
CREATE POLICY mcp_client_values_owner ON mcp_client_values TO kody_reader, kody_writer
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));
GRANT SELECT ON mcp_client_hubs, mcp_client_values TO kody_reader;
GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_client_hubs, mcp_client_values TO kody_writer;

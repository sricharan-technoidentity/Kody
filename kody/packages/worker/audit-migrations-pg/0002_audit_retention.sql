-- Audit events stay append-only for the runtime roles; only the retention lane's NOLOGIN
-- role may delete, and it reads nothing beyond the id and timestamp it prunes by.
CREATE ROLE kody_audit_retention NOLOGIN;
GRANT USAGE ON SCHEMA public TO kody_audit_retention;
GRANT SELECT (id, timestamp), DELETE ON audit_events TO kody_audit_retention;

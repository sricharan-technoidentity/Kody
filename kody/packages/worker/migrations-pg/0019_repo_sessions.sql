-- Reconciliation lists repository metadata fleet-wide, then mutates each source
-- with its owner's writer. This grants no repository files or credentials.
GRANT SELECT ON entity_sources TO kody_admin;

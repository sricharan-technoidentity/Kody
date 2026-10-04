# MCP client servers

Kody dials out to owner-added HTTP MCP servers. Their tools become synthesized
capabilities callable through `kody.mcp[serverName].tool(input)` inside execute.
This is distinct from Kody's inbound `/mcp` endpoint, whose public tools remain
`search` and `execute`.

`mcp-client/service.ts` scopes every operation by stable user ID and serializes
one owner's local operations. `mcp-client/storage.ts` checks the PostgreSQL
owner before loading versioned registration/state rows from `mcp_client_hubs`;
optimistic version checks reject concurrent catalog writes.
`mcp_server_settings` retains enabled state, usage-mode/package allowlists and
sanitized connection errors. Credential data goes through the vault port and
does not enter the SQL registration catalog.

The installed manager needs synchronous SQL, so an in-memory SQLite
compatibility catalog bridges the SDK during an operation, then flushes to
PostgreSQL before the hub closes. This ephemeral cache is not durable authority.
Existing provider class and `cf_agents_*` table names remain compatibility
contracts; there is no deployed per-user Durable Object in the Node POC.

Connection maintenance runs through owner/server `McpServerConnection`
workflows. Signals handle reconnect/removal, Temporal carries backoff across
worker restarts, and the existing hub methods keep discovery, OAuth callback and
callTool behavior. Front-door read paths proxy mutation-capable manager
operations to scoped Temporal activities. Usage mode still controls execute
versus package access; unknown/cross-user registrations cannot authorize tool
use.

Server names retain their format and URLs require HTTPS except allowed loopback
fixtures. Static authorization headers and provider tokens are secret data:
list, snapshot and error responses must remain sanitized. Account
export/deletion uses the existing settings and owner hub inventories. Lifecycle
notifications remain owner-scoped package subscription events.

The local demo uses an imported-token vault fake and does not contact external
MCP hosts. Live AgentCore Identity requires an existing workload/user/provider
with prior authorization; the provisioning and consent bridge remain deferred. A
real Identity token retrieval proof is independent of hosted MCP deployment. See
[the AWS prerequisites](../../poc/aws.md) and
[known limits](../../migration/p8-shortcuts.md). Historical hub/Worker
deployment notes remain in
[the audit archive](../../audits/migration-2026-10-04/index.md).

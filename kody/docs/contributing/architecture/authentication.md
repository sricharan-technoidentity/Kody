# Authentication

Kody establishes a stable account identity before reading or writing private
data. Browser cookies and OAuth bearer tokens retain their existing public
contracts. The Node front door resolves these credentials into PostgreSQL owner
scope; private application state stays isolated even when a caller knows another
account's IDs. See [authorization](./authorization.md) for roles/permissions and
the deliberate operator exceptions.

Browser sessions use the signed `kody_session` cookie, HttpOnly and
SameSite=Lax. The v2 payload carries `stableUserId`, email, `issuedAt` and
`rememberMe`. Ordinary sessions last seven days; remembered sessions last 30
days and renew after 14 days. Session resolution rejects missing/expired issue
times and credentials invalidated by `users.password_changed_at`. Numeric
`users.id` is internal; the stable ID crosses the application boundary. The
source of these checks is `app/auth-session.ts` and `front-door/env.ts`.

Login, signup, email verification, reset, passkey and linked-provider flows
preserve the existing handlers. Signed-out token flows resolve an owner through
narrow PostgreSQL definers and continue on that owner's writer. Front-door
mutations run as Temporal activities with one attempt; read-after-write routing
uses the signed cookie marker. Password reset/change invalidates old cookies and
OAuth grants; reset also clears the existing second-factor and linked-provider
state according to the application handler contract.

MCP clients register and authorize through the existing OAuth endpoints. Grants,
PKCE, redirect checks and refresh-family protections remain in the OAuth
compatibility implementation. DynamoDB-backed `OAUTH_KV` preserves key strings.
The Node-compatible provider build and isolated legacy SDK APIs are required
compatibility dependencies. The published MCP tools remain `search` and
`execute`; capabilities do not introduce separate OAuth scopes.

Published package apps retain owner subdomains and the narrow app-origin handoff
credential. It is not a general account session. Package use grants and publish
locks retain their accepted semantics; app-origin checks remain enforced by the
existing handlers and cookie helpers. Local development uses the printed
application origin, with synthetic credentials.

A webhook URL authenticates through its secret. The host resolves only public
username metadata before scoping the owner database, then checks the endpoint's
secret before dispatching or exposing private results. A caller's browser cookie
does not substitute for that URL secret. Signed broker tokens bind owner, run,
expiry and module provenance on every sandbox capability call; egress resolves
secrets and connector tokens on the trusted host.

SES is the outbound provider port. Local verification/mail delivery is a
synthetic outbox; live SES verification is separate. Connector Identity token
import and provider consent bridging remain POC limits. The local demo does not
establish a production sign-in deployment or existing external connections.

Use [presenter instructions](../../poc/demo.md),
[the service matrix](../../poc/architecture.md) and
[live proof prerequisites](../../poc/aws.md). Detailed historical Worker/OAuth
and deployment notes remain in
[the audit archive](../../audits/migration-2026-10-04/index.md).

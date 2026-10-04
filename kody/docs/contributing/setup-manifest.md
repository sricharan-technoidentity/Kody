# POC setup manifest

Local: Node 26+, npm dependencies, native workerd, Temporal CLI, available
loopback ports and temporary-directory write access. No `.env` or cloud account
is required. PGlite loads checked-in PostgreSQL migrations including pgvector
and RLS.

Sandbox proofs require independently configured existing resources and the AWS
credential provider chain. See [AWS proofs](../poc/aws.md). No resources are
provisioned or migrated by these commands.

# Typed management services

`@golem/tracker` owns the management service boundary for roles, assignments,
human gates, ideas, ticket-bound assets, communications, and control requests.
The service receives only the owner-backed `managementStorage()` capability and
canonical ticket service plus a narrow read-only runtime identity port for
project/session/generation ownership checks; it cannot open SQLite, mutate
runtime lifecycle, or deliver native transport.

`tracker/004-management-services` adds idempotent management records, audit, and
outbox rows. Every write is validated before storage and audit/payload JSON
redacts credential-shaped keys. Asset bytes are limited, MIME constrained,
written below a configured project/ticket root with atomic rename, and read only
after project/ticket/size/hash and no-follow ancestor/root checks. Gate verdicts
require the assignee (with the explicit shared `human` authority policy), and
identical role retries return the existing revision without an audit mutation.
Audit rows persist the redacted canonical mutation actor.

The control plane registers `/api/v1/management/*` behind bearer auth and emits
the stable `golem.management/v1` result shape plus `golem.api-error/v1` errors.
Generated clients are refreshed through the existing API generation/check path.
Compatibility callers should delegate to this service; runtime and native
transport remain separate adapter-owned boundaries.

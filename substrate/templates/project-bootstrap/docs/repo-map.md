# Repo Map

Agent's table of contents. Directory → purpose → key files. Lets agents answer "where would I find X?" without grepping the tree.

Maintenance modes:
- **At bring-up** — Substrator generates a stub from Tech Architect's scaffold.
- **On structural changes** — Engineer or Tech Architect updates the affected section in the same commit that introduces the change.
- **On Documentarian sweep** — full regeneration (or diff-and-update) post-merge for changed paths.

<!-- Replace below with the project's actual layout once Tech Architect
     has scaffolded. -->

## src/

The application code.

<!-- Add subsections per top-level directory under src/, e.g.

### src/api/
HTTP layer. Endpoints, request/response models.
- src/api/routes/ — endpoints grouped by resource.
- src/api/middleware/ — auth, logging, rate-limit.

### src/services/
Business logic.

### src/db/
Persistence. Models, migrations, repository functions.
-->

## tests/

<!-- Or wherever tests live, per the project's conventions. -->

## docs/

This directory.

## tracker/

Per-ticket markdown files in `triage/`, `open/`, `in-progress/`, `review/`, `blocked/`, `done/`.

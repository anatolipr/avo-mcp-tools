---
id: "skill-bucket-v0-scaffold-plan"
key: "MEMORY-BUCKET-V0"
key_type: "freeform"
description: "Initial scaffold of packages/mcp-memory-bucket from the V0 plan"
doc_type: "plan"
tags: ["scaffold"]
status: "active"
related_to: null
---

Scaffolded `packages/mcp-memory-bucket` as a standalone MCP server
(StreamableHTTP, stateless mode) exposing `skill_*`/`memory_*`/`relocate`
tools, per `skill-bucket-v0-plan.md` with the following deviations agreed
during scaffolding:

- Package renamed skill-bucket → memory-bucket.
- Skipped `@avo-mcp-tools/mcp-tenant-server` for V0 — no UI/live browser
  state needed yet (that's fast-follow 3); plain
  `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk` instead.
- `better-sqlite3` chosen over `node:sqlite` per user preference.
- Added optional `folder` param to `skill_create`/`memory_create`/`relocate`
  overrides so authored files can be organized into subdirectories
  (e.g. `frontend/lit-dropdown.md`) on creation, not just discovered there
  — subdirectory discovery (list/get/update/delete) already worked via
  recursive scan + chokidar `depth`, this only affects where new files land.

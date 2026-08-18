---
id: "memory-bucket-v1-multitenancy-idea"
key: "MEMORY-BUCKET-V1-IDEAS"
key_type: "freeform"
description: "Multi-tenant / team-scoped skill-memory repo idea, and bulk-importing external skill packs (e.g. superpowers)"
doc_type: "discovery"
tags: ["idea", "v1", "not-scheduled"]
status: "active"
related_to: "skill-bucket-v0-scaffold-plan"
---

Raised during V0 scaffolding, explicitly deferred — not acted on yet.

## The idea

Structure the skills/memory repo as a monorepo where top-level folders
represent teams or intents, e.g.:

```
skills/
  company/          # shared across everyone
  team-frontend/
  team-backend/
memory/
  team-frontend/
  team-backend/
```

Two motivating use cases:

1. **Bulk-importing an external skill pack** (e.g. downloading
   "superpowers" and embedding it as a set of skills) so anyone using this
   repo/server gets that capability automatically, without hand-authoring
   each skill.
2. **Multi-tenant team separation** — 3 teams either sharing skills/memory
   or keeping them in separate directories, with some notion of which
   teams see which folders.

## What already supports this today

- `skill_sources` / `memory_sources` in `memory-bucket.config.json` are
  already *lists* of paths (see `config.ts`), designed from V0 for
  exactly this kind of multi-source setup — team folders could already be
  configured as separate source entries.
- Subdirectory discovery already works recursively for both skills and
  memory (`sync.ts`'s `walkMarkdownFiles` + chokidar `depth`), and
  `skill_create`/`memory_create`/`relocate` already accept an optional
  `folder` param — so "root folders = teams" is expressible today as
  plain subdirectories under one source, no format change needed.
- Skills are already the portable agentskills.io folder format, so
  importing an external pack (like superpowers, if it also publishes
  SKILL.md-shaped folders) is plausibly just a copy/relocate operation,
  not a schema conversion.

## What's missing (this is the real V1 work)

- **No access control or resolution logic** between folders/sources yet —
  everything indexed is visible to every caller. Team-scoped visibility
  ("team-frontend agents shouldn't see team-backend's memory") isn't
  designed.
- This is effectively the same problem as the plan's already-deferred
  `extends`/squad-vs-company overlay resolution (Fast Follow 1 in
  `skill-bucket-v0-plan.md` §10) — "team folders" and "overlay resolution"
  are two framings of the same underlying need. Worth designing them
  together rather than as separate features.
- A bulk-import/sync tool for pulling in an external skill pack doesn't
  exist yet — `relocate` handles one local file at a time. An external
  pack import would need either a bulk-relocate wrapper or a new
  `skill_import(source_url_or_path)`-shaped tool, plus a decision on
  whether imported skills get re-synced on pack updates or are a one-time
  copy.

## Not scheduled

No commitment to build this — captured so the idea isn't lost before V1
planning. Revisit once V0 dogfooding (per §9 of the plan) surfaces real
friction around sharing or separating skills across teams.

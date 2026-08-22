# avo-mcp-tools

## MCP tool descriptions: tokens matter

Every tool `description` (and each Zod field's `.describe()`) in this repo is sent to the model on every
`tools/list` call, for every session — it is pure fixed overhead, not something read once and discarded.
When writing or editing a tool description:

- State each rule/instruction exactly once. Do not restate the same guidance in the tool's main description,
  in a numbered "how to use" list, in a per-parameter `.describe()`, AND in a separate callout section — pick
  the single best place for it.
- Prefer one dense, well-structured paragraph or short list over multiple sections that each re-explain the
  same behavior from a different angle.
- Before adding a new sentence, ask whether it's covered elsewhere in the same description. When strengthening
  an instruction (e.g. adding `MUST`), overwrite/replace the weaker phrasing that said the same thing — don't
  add the strengthened version alongside the original.
- When editing an existing tool, periodically re-read the whole description for restated content, not just the
  section being changed. Iterative patching over a session tends to accumulate redundancy invisibly since each
  individual edit looks small.

If you're unsure whether a description is bloated, measure it rather than guessing: build the package
(`npm run build`) and check `description.length` (roughly `chars / 4` gives a token estimate) for the tool(s)
you touched. As a rough reference point, most single-purpose tools in this repo describe themselves in
150–400 tokens; a tool description running past ~800–1000 tokens is worth a trim pass before considering
it done.

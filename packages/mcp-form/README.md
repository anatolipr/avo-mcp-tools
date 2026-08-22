# mcp-form

An MCP server that gives an agent a live, in-browser form for collecting structured input from
the user — instead of asking a string of questions in chat. The agent defines fields, the user
fills them in a browser tab backed by a tiny Lit web component, and the agent reads back the
submitted values as tool results.

## Why

Chat is a poor UI for anything beyond one or two quick questions. Rankings, preferences,
multi-field profiles, and "add as many as you like" data are all easier for a user to fill in a
real form — and easier for the agent to get reliably structured answers from — than to extract
from free text turn by turn.

## Usage

```
npx mcp-form
```

Starts the server (default port `8765`) and prints a URL for the live form UI. Point an MCP
client at the same server (stdio via the `mcp-form` bin, or HTTP — see below) so it can call the
form tools.

Environment variables:

- `PORT` — HTTP port to listen on (default `8765`).

Useful scripts (from the package directory):

```
npm run dev     # watch-mode client + server
npm start        # build then run once
npm run stop     # kill whatever is listening on $PORT
```

## How it works

Each MCP session gets its own **tenant** — an isolated form schema, field values, and browser
tab (`http://localhost:<port>/t/<id>`), so multiple agents/users can drive independent forms
against the same server without stepping on each other. Field edits from the browser are pushed
to the agent live over a WebSocket, and idle tenants are swept automatically.

## MCP tools

- **`define_form`** — sets the form's title and fields and returns immediately (does not
  block) by default. The response always includes `formUrl` — share it with the user in chat
  right after this call, before doing anything else, since that's the only chance to hand it
  over if you're about to block on `wait_for_submit` next. Pass `wait: true` only when the URL
  was already shared earlier (e.g. later steps of a multi-step form) — it folds `wait_for_submit`
  into the same call, which means the tool never returns until the user submits and the agent
  gets no opportunity to say anything first.
- **`wait_for_submit`** — blocks until the user clicks Submit (`status: "submitted"`) or
  "Update form" (`status: "interrupted"`, used to revise the form mid-flow), returning
  `formUrl` plus all current field values either way. Returns immediately, without blocking,
  if the user already clicked Submit before this was called. Call this as a separate step
  after `define_form` (rather than `wait: true`) whenever the user needs to be told the form
  is ready first.
- **`get_form_url`** — returns the tenant's form URL on its own. Rarely needed directly since
  `define_form` and `wait_for_submit` already include it in their responses.
- **`list_fields`** — `{submitted, fields}` for the active form: `submitted` is true once the
  user has clicked Submit, independent of whether any tool call is currently waiting on it.
  The form URL works standalone in a browser, so waiting is never required: if the agent
  wasn't blocked on `wait_for_submit` (e.g. it was stopped, or the user just says "I filled
  it in"), call this to read current values and check `submitted` instead of re-defining the
  form or blocking fresh. The browser UI itself shows whether an agent is currently waiting,
  so the user always knows if a wait call needs to be nudged into place.
- **`get_field`** / **`set_field`** — read or programmatically set one field's value (e.g. to
  pre-fill a suggestion the user can still edit).

## Field types

`text`, `number`, `textarea`, `select`, `checkbox`, `radio`, `date`, `datetime`, `range`,
`multiselect`, `color`, `file`, `list`, and `html_output`.

Highlights:

- **`list`** — a repeatable group of sub-fields the user can add/remove rows of, for
  open-ended structured data (team members, addresses, a reading list). Submitted as a JSON
  array of objects.
- **`multiselect`** — checkbox group over a fixed `options[]` set; submitted as a JSON array
  string.
- **`file`** — upload button; the submitted value is the absolute server path, ready to pass to
  the agent's `Read` tool.
- **`html_output`** — a read-only, theme-aware HTML block (no value, excluded from submission)
  for previews, summaries, or confirmations shown alongside real inputs.

Fields support validation (`required`, `pattern` + `patternMessage`, `minLength`/`maxLength`,
`min`/`max`) enforced client-side before submit.

## Multi-step forms

Call `define_form` with `wait: true` repeatedly — once per step — reusing the same tenant/tab.
Prefer splitting into steps once a form would otherwise carry more than ~6-8 fields or spans
clearly distinct sections (e.g. "your info" → "your preferences" → "confirmation").

## Development

```
npm test         # tenant isolation tests
npm run typecheck
```

`config/fields.json` defines the fallback schema used for plain browser access with no MCP
session attached (the `default` tenant).

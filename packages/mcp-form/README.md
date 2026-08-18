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

- **`get_form_url`** — returns the tenant's form URL. Call this first and share the link with
  the user before defining a form.
- **`define_form`** — sets the form's title and fields. Pass `wait: true` to block and get the
  submitted values back in one call; omit it if you need to `set_field` some defaults before
  waiting.
- **`wait_for_submit`** — blocks until the user clicks Submit (`status: "submitted"`) or
  "Update form" (`status: "interrupted"`, used to revise the form mid-flow), returning all
  current field values either way.
- **`list_fields`** — full schema + current values for the active form.
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

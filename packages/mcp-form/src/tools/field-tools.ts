import { z } from 'zod';
import type { ToolDef } from './form-tools.js';

const listFields: ToolDef = {
  name: 'list_fields',
  description:
    'Returns the currently active form\'s state: {submitted, fields}. ' +
    '"submitted" — true once the user has clicked Submit in the browser, regardless of whether any agent ' +
    'tool call is (or ever was) actively waiting on it — this is the reliable "are they done" signal for the no-wait pattern below. ' +
    '"fields" — every field with its name, label, type, options (if select), and current value. ' +
    'Use this to inspect what the user has filled in so far without waiting for a full submit, ' +
    'or to verify the form structure after calling define_form. ' +
    '\n\n' +
    'NO-WAIT PATTERN: the form URL works standalone in a browser — the user does not need the agent to be ' +
    'actively waiting (wait_for_submit / define_form wait:true) in order to open it and fill it in. ' +
    'If the agent was stopped or the turn ended before a wait call was made, or the user says something like ' +
    '"I filled it in" / "I\'m ready, get my answers" / "check the form" without the agent having called wait, ' +
    'call list_fields directly to read the current values instead of assuming nothing was submitted or that ' +
    'a fresh define_form is needed. Check "submitted" to distinguish "user says done" from "still editing" — ' +
    'if it is false, the user has not clicked Submit yet even if some fields are already filled in.',
  schema: {},
  handler: async (_args, tenant) => ({
    content: [{
      type: 'text',
      text: JSON.stringify(
        {
          submitted: tenant().submitted,
          fields: tenant().schema.fields.map((f) => f.type === 'html_output'
            ? { name: f.name, type: 'html_output' }
            : { ...f, value: tenant().store.get(f.name) }
          ),
        },
        null, 2
      ),
    }],
  }),
};

const getField: ToolDef = {
  name: 'get_field',
  description:
    'Reads the current value of a single form field by its snake_case name. ' +
    'Use this to check one specific field without fetching the entire form state. ' +
    'Field must exist in the currently active form (use list_fields to see available names).',
  schema: { field: z.string().describe('snake_case field name as defined in the current form schema') },
  handler: async ({ field }, tenant) => {
    const t = tenant();
    if (!t.store.has(field)) {
      return { content: [{ type: 'text', text: `Error: field "${field}" does not exist in the current form` }], isError: true };
    }
    return { content: [{ type: 'text', text: String(t.store.get(field)) }] };
  },
};

const setField: ToolDef = {
  name: 'set_field',
  description:
    'Programmatically sets the value of a form field, updating the live browser UI immediately. ' +
    'Use this to pre-populate fields with sensible defaults or suggestions before the user fills the form — ' +
    'for example, pre-filling a "name" field from a previous session, or setting a default selection. ' +
    'The user can still edit the value before submitting. ' +
    'Field must exist in the currently active form (call define_form first).',
  schema: {
    field: z.string().describe('snake_case field name as defined in the current form schema'),
    value: z.string(),
  },
  handler: async ({ field, value }, tenant) => {
    const t = tenant();
    if (!t.store.has(field)) {
      return { content: [{ type: 'text', text: `Error: field "${field}" does not exist in the current form` }], isError: true };
    }
    t.store.set(field, value);
    return { content: [{ type: 'text', text: `${field} = ${value}` }] };
  },
};

export const fieldTools: ToolDef[] = [listFields, getField, setField];

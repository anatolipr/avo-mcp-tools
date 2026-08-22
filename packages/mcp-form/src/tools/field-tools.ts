import { z } from 'zod';
import type { ToolDef } from './form-tools.js';

const listFields: ToolDef = {
  name: 'list_fields',
  description:
    'Returns the CURRENT CHANNEL\'s form state: {submitted, fields}. ' +
    '"submitted" — true once the user has clicked Submit in the browser, regardless of whether any agent ' +
    'tool call is (or ever was) actively waiting on it — this is the reliable "are they done" signal for the no-wait pattern below. ' +
    '"fields" — every field with its name, label, type, options (if select), and current value. ' +
    'Use this to inspect what the user has filled in so far without waiting for a full submit, ' +
    'or to verify the form structure after calling define_form. ' +
    '\n\n' +
    'IMPORTANT — this only ever reflects the channel THIS session is on (default until join_channel is ' +
    'called). If asked about a specific named form (e.g. "the pets form") and this shows something unrelated, ' +
    'do NOT conclude it doesn\'t exist — use channel_find or list_channels + join_channel to find and switch to ' +
    'the right one first, then call list_fields again. ' +
    '\n\n' +
    'NO-WAIT PATTERN: the form URL works standalone in a browser — the user does not need the agent to be ' +
    'actively waiting (define_form, which blocks by default, or wait_for_submit) in order to open it and fill it in. ' +
    'If the agent was stopped or the turn ended before a wait call resolved, or the user says something like ' +
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
    'Field must exist in the form on THIS SESSION\'S CURRENT CHANNEL (use list_fields to see available names). ' +
    'If the field is missing and you expected a specific named form (e.g. "the pets form"), the session is ' +
    'probably on the wrong channel — see list_channels/join_channel.',
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
    'Field must exist in the form on THIS SESSION\'S CURRENT CHANNEL (call define_form first, or join_channel ' +
    'to an existing named channel that already has one — see list_channels).',
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

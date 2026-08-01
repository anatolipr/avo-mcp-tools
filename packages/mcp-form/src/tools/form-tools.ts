import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tenant, SubmitPayload } from '@avo-mcp-tools/mcp-tenant-server';

const fieldTypeEnum = z.enum(['text', 'number', 'textarea', 'select', 'checkbox', 'radio', 'date', 'datetime', 'range', 'multiselect', 'file', 'list', 'color', 'html_output']);
const subFieldTypeEnum = z.enum(['text', 'number', 'textarea', 'select', 'checkbox', 'radio', 'date', 'datetime', 'range', 'multiselect', 'color']);

const validationSchema = {
  required: z.boolean().optional().describe(
    'If true, the field must have a non-empty value before the form can be submitted. ' +
    'For checkbox, the box must be checked. For multiselect/list, at least one item must be present.'
  ),
  pattern: z.string().optional().describe(
    'A JavaScript-compatible regular expression string (without delimiters) that the value must match. ' +
    'Applied to text, textarea, and number fields. ' +
    'Examples: "^[a-zA-Z]+$" (letters only), "^[a-zA-Z0-9 ]+$" (alphanumeric), "^\\\\d{5}$" (5-digit ZIP), ' +
    '"^[^@\\\\s]+@[^@\\\\s]+\\\\.[^@\\\\s]+$" (email). ' +
    'Always pair with patternMessage so the user knows what format is expected.'
  ),
  patternMessage: z.string().optional().describe(
    'Human-readable error shown when the value does not match the pattern. ' +
    'Be specific: "Only letters allowed", "Enter a valid email address", "Must be a 5-digit ZIP code". ' +
    'Required whenever pattern is set.'
  ),
  minLength: z.number().optional().describe('Minimum character count for text and textarea fields.'),
  maxLength: z.number().optional().describe('Maximum character count for text and textarea fields.'),
};

const subFieldDefSchema = z.object({
  name: z.string().describe('Unique field identifier within a list row (snake_case)'),
  label: z.string().describe('Human-readable label shown above the input'),
  type: subFieldTypeEnum.default('text'),
  placeholder: z.string().optional(),
  options: z.array(z.string()).optional(),
  default: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  ...validationSchema,
});

const fieldDefSchema = z.object({
  name: z.string().describe('Unique field identifier (snake_case)'),
  label: z.string().describe('Human-readable label shown above the input'),
  type: fieldTypeEnum.default('text').describe(
    'Input type: text | number | textarea | select | checkbox | radio | date | datetime | range | multiselect. ' +
    '"checkbox" — boolean toggle, value is "true"/"false". ' +
    '"radio" — pick exactly one from a list; requires options[] array. ' +
    '"date" — date picker, value is ISO date string YYYY-MM-DD. ' +
    '"datetime" — date+time picker, value is ISO datetime string YYYY-MM-DDTHH:MM. ' +
    '"range" — slider; value is a number string. Use min/max/step to control bounds. ' +
    '"multiselect" — checkbox list allowing multiple selections; requires options[] array; value is a JSON array string e.g. "[\"a\",\"b\"]". ' +
    '"file" — file upload; value returned as the absolute path on the server where the file was saved. The agent can Read that path directly. ' +
    '"color" — color picker; value returned as a hex string e.g. "#ff0000". ' +
    '"list" — repeatable group of sub-fields; the user can add or remove rows with +/trash buttons. ' +
    'Requires a fields[] array defining the sub-schema for each row (supports all types except list). ' +
    'Value returned as a JSON array of objects e.g. \'[{"first_name":"Alice","last_name":"Smith"}]\'. ' +
    'Use this for collecting structured multi-entry data: team members, addresses, favorite movies with ratings, etc.'
  ),
  placeholder: z.string().optional().describe('Placeholder text for text/number/textarea'),
  options: z.array(z.string()).optional().describe('Required when type is "select", "radio", or "multiselect"'),
  default: z.string().optional().describe('Initial value. For checkbox use "true"/"false". For multiselect use a JSON array string e.g. "[\"option1\"]". For range use a number string.'),
  accept: z.string().optional().describe('For file type only: MIME type filter or file extension filter, e.g. ".pdf,.docx" or "image/*"'),
  fields: z.array(subFieldDefSchema).optional().describe(
    'Required when type is "list". Defines the sub-schema rendered inside each repeatable row card. ' +
    'Supports all field types except "list" (no nesting) and "file". ' +
    'Each entry follows the same shape as a top-level field: name (snake_case, unique within the row), label, type, and type-specific options. ' +
    'The submitted value for the list field will be a JSON array of objects, one per row, keyed by each sub-field name. ' +
    'Example: fields=[{name:"first_name",label:"First Name",type:"text"},{name:"role",label:"Role",type:"select",options:["Eng","PM"]}] ' +
    'produces values like [{first_name:"Alice",role:"Eng"},{first_name:"Bob",role:"PM"}].'
  ),
  min: z.number().optional().describe('Minimum value for range/number types. Also used as validation: number inputs below this value will be rejected.'),
  max: z.number().optional().describe('Maximum value for range/number types. Also used as validation: number inputs above this value will be rejected.'),
  step: z.number().optional().describe('Step increment for range type (default 1)'),
  html: z.string().optional().describe(
    'Required when type is "html_output". Raw HTML string to render inside the block. ' +
    'Can contain any HTML: headings, color swatches, tables, images, styled divs, etc. ' +
    'CSS in <style> tags here is NOT scoped — use the css field for scoped styles instead. ' +
    '\n\n' +
    'THEMING — the form auto-switches between light and dark mode based on the user\'s system preference. ' +
    'DO NOT set explicit text colors (e.g. color: black, color: #1a1a1a) on the elements in this HTML — ' +
    'leave text color unset so it inherits the block\'s theme-aware default, which already tracks light/dark. ' +
    'Setting an explicit dark text color will make it unreadable for users in dark mode (and vice versa). ' +
    'If you must set a background color (e.g. a swatch, a highlighted card), pick a color that works with ' +
    'readable text in BOTH themes — e.g. use the swatch/accent color itself only for small chips or borders, ' +
    'not as a full-bleed background behind body text, and prefer CSS that adapts, such as ' +
    '`background: light-dark(#fff, #222)` (with `color-scheme: light dark` set) or a ' +
    '`@media (prefers-color-scheme: dark)` override in the css field. ' +
    'When in doubt, use no background and no text color at all — the surrounding form already supplies both correctly.'
  ),
  css: z.string().optional().describe(
    'Optional CSS string to inject into the html_output block\'s shadow DOM. ' +
    'Styles are fully scoped to the block and cannot affect other fields. ' +
    'Example: "div { border-radius: 8px; padding: 0.5rem; }" or ":host { display: flex; gap: 1rem; }" ' +
    '\n\n' +
    'THEMING: do not hardcode text colors here either — omit `color` and let it inherit. ' +
    'For backgrounds/borders that need to differ between light and dark, wrap the override in ' +
    '`@media (prefers-color-scheme: dark) { ... }` rather than picking one fixed color for both themes.'
  ),
  ...validationSchema,
});

export interface ToolDef {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (args: any, tenant: () => Tenant, port: number) => Promise<any>;
}

const getFormUrl: ToolDef = {
  name: 'get_form_url',
  description:
    'Returns the URL of the live browser form UI (e.g. http://localhost:8765/t/<id>). ' +
    'Call this and share the URL with the user whenever you are about to collect input via define_form, ' +
    'so they know where to open the form before you call wait_for_submit.',
  schema: {},
  handler: async (_args, tenant, port) => {
    tenant();
    return { content: [{ type: 'text', text: `http://localhost:${port}/t/${tenant().id}` }] };
  },
};

const defineForm: ToolDef = {
  name: 'define_form',
  description:
    'PREFERRED method for collecting structured input from the user. ' +
    'Use this tool instead of asking questions inline in chat whenever you need to gather: ' +
    '(1) two or more pieces of information at once, ' +
    '(2) constrained choices (use type "select" with an options[] list), ' +
    '(3) longer free-text answers (use type "textarea"), or ' +
    '(4) any input where seeing all questions together helps the user give better answers. ' +
    '\n\n' +
    'WHEN TO PREFER THIS OVER CHAT: rankings, preferences, settings, profiles, ratings, ' +
    'multi-step wizard data, survey-style questions, form fills, onboarding info, ' +
    'search/filter criteria, or any time you would otherwise ask 2+ follow-up questions sequentially. ' +
    '\n\n' +
    'HOW TO USE: ' +
    '1. Call get_form_url and tell the user to open that URL in their browser. ' +
    '2. Call define_form with a clear title and well-labelled fields. Pass wait:true to block and receive submitted values in one step (preferred). ' +
    '   Omit wait (or pass false) only if you need to prefill fields with set_field before blocking. In that case call wait_for_submit separately afterward. ' +
    '\n\n' +
    'FIELD TYPES: ' +
    '"text" — single-line free input (names, titles, short answers). ' +
    '"number" — numeric input (age, quantity, rating 1-10). ' +
    '"textarea" — multi-line input (descriptions, feedback, long answers). ' +
    '"select" — dropdown from a fixed list; requires options[] array (yes/no, category, priority). ' +
    '"checkbox" — boolean toggle (agree to terms, enable feature, yes/no flags). ' +
    '"radio" — mutually exclusive choice shown as buttons; requires options[] array (better than select for ≤5 short options). ' +
    '"date" — date picker; value returned as YYYY-MM-DD (deadlines, birthdays, start dates). ' +
    '"datetime" — date+time picker; value returned as YYYY-MM-DDTHH:MM (scheduling, appointments). ' +
    '"range" — slider with min/max/step; value returned as a number string (ratings, confidence, budget). ' +
    '"multiselect" — checkbox list for picking multiple items from a fixed set; requires options[] array; ' +
    'value returned as a JSON array string e.g. \'["tag1","tag2"]\' — parse with JSON.parse() to get an array. ' +
    'Use when the set of choices is known in advance. Prefer "list" when the user supplies free-form entries. ' +
    '"color" — color picker; value returned as a hex string e.g. "#ff0000". Use for theme colors, label colors, or any color choice. ' +
    '"file" — file upload button; value returned as absolute server path the agent can Read directly (PDFs, images, documents). Use accept to restrict file types e.g. ".pdf" or "image/*". ' +
    '"html_output" — read-only display block; renders arbitrary HTML in a scoped shadow DOM. ' +
    'Not an input — has no value and is excluded from the submitted data. ' +
    'Use this to show context, previews, color swatches, summaries, or formatted data alongside input fields. ' +
    'Set html to the raw HTML string to render. Optionally set css with scoped stylesheet rules. ' +
    'Supports full HTML: headings, divs, tables, inline SVG, color swatches, images (data URIs), etc. ' +
    'Good uses: show a color chosen in a previous step above a related color input; display a summary of earlier answers before a confirmation submit; show a styled table of results; render a preview of a chosen palette. ' +
    'Example: {type:"html_output", name:"color_preview", html:"<div style=\'background:#ff5733;width:100%;height:40px;border-radius:6px\'></div><p>Your primary color: #ff5733</p>", css:"p{margin:0.3rem 0;font-size:0.85rem;color:#555}"}. ' +
    '"list" — repeatable group of sub-fields the user can add or remove rows of. ' +
    'Use this whenever you need one or more items of the same structure: people, addresses, tasks, movies, ingredients, etc. ' +
    'Requires a fields[] array (the sub-schema); each row renders as a card. Supports all field types inside a row except "list" (no nesting) and "file". ' +
    'Value returned as a JSON array of objects e.g. \'[{"first_name":"Alice","role":"Engineer"},{"first_name":"Bob","role":"PM"}]\' — parse with JSON.parse(). ' +
    'The array will always contain at least one entry (the model should filter out blank rows if the user left one empty). ' +
    '\n\n' +
    'VALIDATION (applies to any field type): ' +
    'required:true — blocks submit if empty; for checkbox the box must be checked; for multiselect/list at least one item must exist. ' +
    'pattern + patternMessage — regex the value must match; use for format constraints on text/textarea/number ' +
    '(e.g. pattern:"^[a-zA-Z ]+$", patternMessage:"Only letters and spaces allowed" for a name field). ' +
    'minLength / maxLength — character count bounds for text and textarea. ' +
    'min / max on number fields — numeric range validation (value must be between min and max). ' +
    'All validation rules apply equally to sub-fields inside a list type. ' +
    '\n\n' +
    'WHEN TO USE "list" vs OTHER TYPES: ' +
    'Use "list" when the number of entries is unknown in advance or the user should be able to add more. ' +
    'Use fixed fields (text × N) only when you know exactly how many entries are needed (e.g. exactly 3 references). ' +
    'Use "multiselect" only when picking from a predefined set, not for free-form entry. ' +
    '\n\n' +
    'EXAMPLES OF GOOD FORM USE: ' +
    '"What are your top 3 favourite movies?" → 1 list field (title + year) so the user can add exactly as many as they want. ' +
    '"Rate your experience 1-5 and leave a comment" → 1 range + 1 textarea. ' +
    '"Set up your profile (name, role, team, timezone)" → 4 text/select fields. ' +
    '"Which features do you want enabled?" → 1 multiselect field with the known feature options. ' +
    '"Add your team members" → 1 list field with sub-fields: first_name (text), last_name (text), role (select). ' +
    '"Enter your reading list with priority" → 1 list field with sub-fields: title (text), author (text), priority (radio: Low/Medium/High). ' +
    '"Choose complementary colors (primary was #ff5733 last session)" → 1 html_output showing a swatch of the previous color, then 1 color input for the new pick. ' +
    '"Confirm your choices before we proceed" → multiple html_output blocks summarizing earlier answers, no input fields, just a Submit to acknowledge. ' +
    '"Pick a font size (current preview)" → 1 html_output showing live-styled sample text, then a range input for size. ' +
    '\n\n' +
    'MULTI-STEP FORMS: prefer breaking a long or logically-grouped set of fields into several smaller forms ' +
    'shown one after another, rather than a single form with many fields. As a rough guideline, consider splitting ' +
    'once you would otherwise put more than ~6-8 fields on one screen, or whenever the fields fall into clearly ' +
    'distinct sections (e.g. "your info" then "your preferences" then "confirmation"). ' +
    'To do this: call define_form with wait:true for step 1 (title including "Step 1 of N"), read the returned values, ' +
    'then call define_form with wait:true again for step 2 using a fresh field set (title "Step 2 of N"), and so on — ' +
    'no need to call get_form_url again, the same browser tab updates in place. ' +
    'This is a soft preference, not a hard rule: a short, single-purpose form (e.g. one rating + one comment) should ' +
    'stay as one step. Do not split just to split — only when it genuinely improves readability or reflects distinct stages.',
  schema: {
    title: z.string().optional().describe(
      'Question or prompt shown at the top of the form. STRONGLY RECOMMENDED — always set a title. ' +
      'Without one the form is just a bare list of fields with no framing, which is confusing when the user ' +
      'has switched away from the chat to fill it in. Write it as a natural-language prompt or short heading ' +
      'the user will read before filling in fields, e.g. "Tell us about your top 3 favourite movies" ' +
      'or "Configure your project settings below." ' +
      'For a multi-step flow (see MULTI-STEP FORMS below), include the step in the title, ' +
      'e.g. "Step 1 of 3: Basic info". ' +
      'This is plain text rendered above the fields — do not use an html_output field just to render a title.'
    ),
    fields: z.array(fieldDefSchema).min(1),
    wait: z.boolean().optional().describe(
      'If true, immediately block after defining the form and return the submitted values once the user clicks Submit — ' +
      'equivalent to calling wait_for_submit right after. ' +
      'Use this for the common case where you do not need to prefill fields with set_field between defining and waiting. ' +
      'Omit (or set false) when you need to call set_field before waiting.'
    ),
  },
  handler: async ({ title, fields, wait }, tenant) => {
    tenant().applyFormDef({ title: title ?? '', fields });
    if (wait) {
      const raw = await new Promise<SubmitPayload>((resolve) => {
        tenant().submitBus.once('submit', resolve);
      });
      const { __interrupted, __disposed, ...values } = raw;
      if (__disposed) {
        return {
          content: [{ type: 'text', text: 'Error: the session was closed while waiting for submit' }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: __interrupted ? 'interrupted' : 'submitted', values }, null, 2) }],
      };
    }
    return {
      content: [{
        type: 'text',
        text: `Form updated with ${fields.length} field(s). Call wait_for_submit to wait for the user.`,
      }],
    };
  },
};

const waitForSubmit: ToolDef = {
  name: 'wait_for_submit',
  description:
    'Blocks until the user clicks Submit or clicks "Update form" (interrupt) on the live form UI. ' +
    'Always call define_form before this — wait_for_submit has no effect if no form has been defined. ' +
    '\n\n' +
    'RETURN SHAPE: a JSON object with two top-level keys: ' +
    '"status": either "submitted" (user clicked Submit — form is done) or "interrupted" (user clicked "Update form" — agent should read chat, adjust the form via define_form, then call wait_for_submit again). ' +
    '"values": object of all current field values at the moment of submission or interruption. ' +
    '\n\n' +
    'INTERRUPTION FLOW: when status is "interrupted", the form stays open in the browser with all values intact. ' +
    'The agent should read the user\'s latest chat message, optionally call define_form with updated/additional fields (existing values are preserved if field names match), then call wait_for_submit again. ' +
    '\n\n' +
    'RETURNED VALUE SHAPES BY FIELD TYPE: ' +
    'text / number / textarea / select / radio / date / datetime / range → plain string. ' +
    'checkbox → "true" or "false" string. ' +
    'multiselect → JSON array string e.g. \'["a","b"]\'; use JSON.parse() to get an array. ' +
    'list → JSON array-of-objects string e.g. \'[{"first_name":"Alice","role":"Engineer"}]\'; use JSON.parse() to get an array. ' +
    'Filter out list rows where all sub-field values are empty strings. ' +
    'file → absolute server path string; use the Read tool to access the file contents.',
  schema: {},
  handler: async (_args, tenant) => {
    const raw = await new Promise<SubmitPayload>((resolve) => {
      tenant().submitBus.once('submit', resolve);
    });
    const { __interrupted, __disposed, ...values } = raw;
    if (__disposed) {
      return {
        content: [{ type: 'text', text: 'Error: the session was closed while waiting for submit' }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({ status: __interrupted ? 'interrupted' : 'submitted', values }, null, 2) }],
    };
  },
};

export const formTools: ToolDef[] = [getFormUrl, defineForm, waitForSubmit];
export { fieldDefSchema, subFieldDefSchema, fieldTypeEnum, subFieldTypeEnum, validationSchema };

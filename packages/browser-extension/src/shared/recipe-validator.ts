// Validates a user-uploaded chat-relay recipe (see recipe-types.ts). Hand
// written rather than a schema library (zod isn't a dependency of this
// package, and no schema library is used anywhere else here) - the shape is
// small and flat enough that a ~1:1 field-by-field check is easy to keep
// correct.
//
// Rejects outright on any violation, collecting ALL errors (not just the
// first) so a human fixing a hand-authored recipe sees every problem at
// once. There is no "accept with warnings" path - a bad selector should
// fail loud at upload time, not silently at first use.
//
// Selector SYNTAX validation (document.createDocumentFragment().querySelector)
// only runs when `document` is available - i.e. when called from the popup,
// where recipes are always uploaded. Service workers have no DOM, so the
// background's own defense-in-depth re-validation on read from storage
// (see relay-recipes-storage.ts) skips that specific check and trusts it
// was already checked at upload time.
import type { CompletionStrategy, Recipe, SetViaStrategy } from './recipe-types.js';

const SET_VIA_VALUES: SetViaStrategy[] = ['native-value-setter', 'contenteditable-text'];
const COMPLETION_STRATEGIES: CompletionStrategy[] = ['idle-mutation', 'button-reappears', 'disabled-toggle'];
const MAX_WAIT_MS_CEILING = 10 * 60 * 1000; // 10 minutes

export type ValidateRecipeResult = { ok: true; recipe: Recipe } | { ok: false; errors: string[] };

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isValidHostname(hostname: string): boolean {
  if (hostname.includes('/') || hostname.includes(':')) return false;
  try {
    return new URL(`http://${hostname}`).hostname === hostname;
  } catch {
    return false;
  }
}

// `document` doesn't exist as a type at all under the background's
// webworker lib (tsconfig.background.json has no "dom" lib) - go through
// globalThis so this file type-checks under both tsconfig.json (popup, has
// "dom") and tsconfig.background.json (service worker, no "dom").
interface MinimalDocument {
  createDocumentFragment(): { querySelector(selector: string): unknown };
}

function isValidSelectorSyntax(selector: string): boolean {
  let doc = (globalThis as { document?: MinimalDocument }).document;
  if (!doc) return true; // background context - trust upload-time validation
  try {
    doc.createDocumentFragment().querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

function isPositiveNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

export function validateRecipe(input: unknown, existingIds?: Set<string>): ValidateRecipeResult {
  let errors: string[] = [];

  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['Recipe must be a JSON object.'] };
  }
  let r = input as Record<string, unknown>;

  if (r.schemaVersion !== 1) {
    errors.push(`Unsupported schemaVersion "${String(r.schemaVersion)}" - expected 1.`);
  }

  if (!isNonEmptyString(r.id)) {
    errors.push('"id" must be a non-empty string.');
  } else if (existingIds?.has(r.id)) {
    errors.push(`A recipe with id "${r.id}" already exists - delete or rename it before uploading this one.`);
  }

  if (!isNonEmptyString(r.hostname)) {
    errors.push('"hostname" must be a non-empty string.');
  } else if (!isValidHostname(r.hostname)) {
    errors.push(`"hostname" is not a valid hostname: "${r.hostname}" (no scheme, path, or port - e.g. "chat.deepseek.com").`);
  }

  if (r.displayName !== undefined && typeof r.displayName !== 'string') {
    errors.push('"displayName" must be a string if present.');
  }

  let input_ = r.input as Record<string, unknown> | undefined;
  if (typeof input_ !== 'object' || input_ === null) {
    errors.push('"input" must be an object.');
  } else {
    if (!isNonEmptyString(input_.selector)) {
      errors.push('"input.selector" must be a non-empty string.');
    } else if (!isValidSelectorSyntax(input_.selector)) {
      errors.push(`"input.selector" is not valid CSS selector syntax: "${input_.selector}"`);
    }
    if (!SET_VIA_VALUES.includes(input_.setVia as SetViaStrategy)) {
      errors.push(`"input.setVia" must be one of: ${SET_VIA_VALUES.join(', ')}.`);
    }
  }

  let submit = r.submit as Record<string, unknown> | undefined;
  if (typeof submit !== 'object' || submit === null) {
    errors.push('"submit" must be an object.');
  } else {
    if (!isNonEmptyString(submit.selector)) {
      errors.push('"submit.selector" must be a non-empty string.');
    } else if (!isValidSelectorSyntax(submit.selector)) {
      errors.push(`"submit.selector" is not valid CSS selector syntax: "${submit.selector}"`);
    }
  }

  let reply = r.reply as Record<string, unknown> | undefined;
  if (typeof reply !== 'object' || reply === null) {
    errors.push('"reply" must be an object.');
  } else {
    if (!isNonEmptyString(reply.containerSelector)) {
      errors.push('"reply.containerSelector" must be a non-empty string.');
    } else if (!isValidSelectorSyntax(reply.containerSelector)) {
      errors.push(`"reply.containerSelector" is not valid CSS selector syntax: "${reply.containerSelector}"`);
    }
    if (reply.pick !== 'last') {
      errors.push(`"reply.pick" must be "last" (${reply.pick === 'nth' ? '"nth" is reserved but not yet implemented' : `got "${String(reply.pick)}"`}).`);
    }
  }

  let completion = r.completion as Record<string, unknown> | undefined;
  if (typeof completion !== 'object' || completion === null) {
    errors.push('"completion" must be an object.');
  } else if (!COMPLETION_STRATEGIES.includes(completion.strategy as CompletionStrategy)) {
    errors.push(`"completion.strategy" must be one of: ${COMPLETION_STRATEGIES.join(', ')}.`);
  } else {
    if (!isPositiveNumber(completion.maxWaitMs) || (completion.maxWaitMs as number) > MAX_WAIT_MS_CEILING) {
      errors.push(`"completion.maxWaitMs" must be a positive number no greater than ${MAX_WAIT_MS_CEILING} (10 minutes).`);
    }
    if (completion.strategy === 'idle-mutation') {
      if (!isNonEmptyString(completion.observe)) errors.push('"completion.observe" must be a non-empty string for strategy "idle-mutation".');
      else if (!isValidSelectorSyntax(completion.observe)) errors.push(`"completion.observe" is not valid CSS selector syntax: "${completion.observe}"`);
      if (!isPositiveNumber(completion.idleMs)) errors.push('"completion.idleMs" must be a positive number for strategy "idle-mutation".');
    } else if (completion.strategy === 'button-reappears' || completion.strategy === 'disabled-toggle') {
      if (!isNonEmptyString(completion.watchSelector)) {
        errors.push(`"completion.watchSelector" must be a non-empty string for strategy "${completion.strategy}".`);
      } else if (!isValidSelectorSyntax(completion.watchSelector)) {
        errors.push(`"completion.watchSelector" is not valid CSS selector syntax: "${completion.watchSelector}"`);
      }
    }
  }

  if (r.callBlock !== undefined) {
    if (typeof r.callBlock !== 'object' || r.callBlock === null) {
      errors.push('"callBlock" must be an object if present.');
    } else {
      let cb = r.callBlock as Record<string, unknown>;
      if (cb.startSentinel !== undefined && typeof cb.startSentinel !== 'string') errors.push('"callBlock.startSentinel" must be a string if present.');
      if (cb.endSentinel !== undefined && typeof cb.endSentinel !== 'string') errors.push('"callBlock.endSentinel" must be a string if present.');
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, recipe: input as Recipe };
}

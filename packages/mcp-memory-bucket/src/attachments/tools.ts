import { z } from 'zod';
import fs from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AttachmentRepository } from './repository.js';
import { ATTACHMENT_MAX_BYTES } from './storage.js';

const kindSchema = z.enum(['memory', 'skill']);

/** Cheap pre-check so we never read a too-large file's bytes into memory before rejecting it. */
function assertFileSizeOk(file_path: string): void {
  const { size } = fs.statSync(file_path);
  if (size > ATTACHMENT_MAX_BYTES) {
    throw new Error(`file "${file_path}" (${size} bytes) exceeds the ${ATTACHMENT_MAX_BYTES}-byte limit`);
  }
}

export function registerAttachmentTools(mcp: McpServer, attachRepo: AttachmentRepository): void {
  mcp.tool(
    'attachment_add',
    'Attaches a raw file (JSON, image, XML, etc.) to a memory doc or skill. Auto-renames on filename collision.',
    {
      kind: kindSchema,
      doc: z.string().describe('memory doc id or skill name'),
      filename: z.string(),
      file_path: z.string().describe('local filesystem path to the file to attach'),
    },
    async ({ kind, doc, filename, file_path }: any) => {
      try {
        assertFileSizeOk(file_path);
        const data = fs.readFileSync(file_path);
        const entry = attachRepo.add(kind, doc, filename, data);
        const absolute_path = attachRepo.absolutePathFor(kind, doc, entry.filename);
        return { content: [{ type: 'text', text: JSON.stringify({ ...entry, absolute_path }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );

  mcp.tool(
    'attachment_get',
    'Returns the on-disk path (not content) of an attachment, plus its metadata. Use Read on the returned absolute_path for the content.',
    { kind: kindSchema, doc: z.string(), filename: z.string() },
    async ({ kind, doc, filename }: any) => {
      try {
        const entry = attachRepo.get(kind, doc, filename);
        if (!entry) throw new Error(`attachment "${filename}" not found`);
        const absolute_path = attachRepo.absolutePathFor(kind, doc, entry.filename);
        return { content: [{ type: 'text', text: JSON.stringify({ ...entry, absolute_path }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );

  mcp.tool(
    'attachment_update',
    "Replaces an attachment's content in place.",
    { kind: kindSchema, doc: z.string(), filename: z.string(), file_path: z.string() },
    async ({ kind, doc, filename, file_path }: any) => {
      try {
        assertFileSizeOk(file_path);
        const data = fs.readFileSync(file_path);
        const entry = attachRepo.update(kind, doc, filename, data);
        const absolute_path = attachRepo.absolutePathFor(kind, doc, entry.filename);
        return { content: [{ type: 'text', text: JSON.stringify({ ...entry, absolute_path }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );

  mcp.tool(
    'attachment_remove',
    'Deletes an attachment from a memory doc or skill.',
    { kind: kindSchema, doc: z.string(), filename: z.string() },
    async ({ kind, doc, filename }: any) => {
      try {
        attachRepo.remove(kind, doc, filename);
        return { content: [{ type: 'text', text: `removed "${filename}"` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );

  mcp.tool(
    'attachment_list',
    'Lists all attachments on a memory doc or skill, each with its absolute on-disk path.',
    { kind: kindSchema, doc: z.string() },
    async ({ kind, doc }: any) => {
      try {
        const entries = attachRepo.list(kind, doc);
        const withPaths = entries.map((entry) => ({
          ...entry,
          absolute_path: attachRepo.absolutePathFor(kind, doc, entry.filename),
        }));
        return { content: [{ type: 'text', text: JSON.stringify(withPaths, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );

  mcp.tool(
    'attachment_reconcile',
    "Compares a doc's declared attachments against what is actually on disk; reports orphans (declared but missing) and unlisted files (present but not declared). Report-only, does not repair.",
    { kind: kindSchema, doc: z.string() },
    async ({ kind, doc }: any) => {
      try {
        const result = attachRepo.reconcile(kind, doc);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );
}

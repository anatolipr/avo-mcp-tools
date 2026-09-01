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
  const folderSchema = { folder: z.string().optional().describe('which configured folder the doc lives in — required when more than one is configured') };

  mcp.tool(
    'attachment_add',
    'Attaches a raw file (JSON, image, XML, etc.) to a memory doc or skill. Auto-renames on filename collision.',
    {
      kind: kindSchema,
      ...folderSchema,
      doc: z.string().describe('memory doc filename or skill name'),
      filename: z.string().describe('filename to store it under — may include a relative subpath (e.g. "references/foo.md") to nest it inside attachments/'),
      file_path: z.string().describe('local filesystem path to the file to attach'),
    },
    async ({ kind, folder, doc, filename, file_path }: any) => {
      try {
        assertFileSizeOk(file_path);
        const data = fs.readFileSync(file_path);
        const entry = await attachRepo.add(kind, folder, doc, filename, data);
        const absolute_path = await attachRepo.absolutePathFor(kind, folder, doc, entry.filename);
        return { content: [{ type: 'text', text: JSON.stringify({ ...entry, absolute_path }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );

  mcp.tool(
    'attachment_get',
    'Returns the on-disk path (not content) of an attachment, plus its metadata. Use Read on the returned absolute_path for the content.',
    { kind: kindSchema, ...folderSchema, doc: z.string(), filename: z.string() },
    async ({ kind, folder, doc, filename }: any) => {
      try {
        const entry = await attachRepo.get(kind, folder, doc, filename);
        if (!entry) throw new Error(`attachment "${filename}" not found`);
        const absolute_path = await attachRepo.absolutePathFor(kind, folder, doc, entry.filename);
        return { content: [{ type: 'text', text: JSON.stringify({ ...entry, absolute_path }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );

  mcp.tool(
    'attachment_update',
    "Replaces an attachment's content in place.",
    { kind: kindSchema, ...folderSchema, doc: z.string(), filename: z.string().describe('may include a relative subpath (e.g. "references/foo.md")'), file_path: z.string() },
    async ({ kind, folder, doc, filename, file_path }: any) => {
      try {
        assertFileSizeOk(file_path);
        const data = fs.readFileSync(file_path);
        const entry = await attachRepo.update(kind, folder, doc, filename, data);
        const absolute_path = await attachRepo.absolutePathFor(kind, folder, doc, entry.filename);
        return { content: [{ type: 'text', text: JSON.stringify({ ...entry, absolute_path }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );

  mcp.tool(
    'attachment_remove',
    'Deletes an attachment from a memory doc or skill.',
    { kind: kindSchema, ...folderSchema, doc: z.string(), filename: z.string() },
    async ({ kind, folder, doc, filename }: any) => {
      try {
        await attachRepo.remove(kind, folder, doc, filename);
        return { content: [{ type: 'text', text: `removed "${filename}"` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );

  mcp.tool(
    'attachment_list',
    'Lists all attachments on a memory doc or skill, each with its absolute on-disk path.',
    { kind: kindSchema, ...folderSchema, doc: z.string() },
    async ({ kind, folder, doc }: any) => {
      try {
        const entries = await attachRepo.list(kind, folder, doc);
        const withPaths = await Promise.all(
          entries.map(async (entry) => ({
            ...entry,
            absolute_path: await attachRepo.absolutePathFor(kind, folder, doc, entry.filename),
          }))
        );
        return { content: [{ type: 'text', text: JSON.stringify(withPaths, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );

  mcp.tool(
    'attachment_reconcile',
    "Compares a doc's declared attachments against what is actually on disk; reports orphans (declared but missing) and unlisted files (present but not declared). Report-only, does not repair.",
    { kind: kindSchema, ...folderSchema, doc: z.string() },
    async ({ kind, folder, doc }: any) => {
      try {
        const result = await attachRepo.reconcile(kind, folder, doc);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );
}

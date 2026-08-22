export interface AttachmentEntry {
  filename: string;
  path: string; // relative to the doc's directory, e.g. "attachments/foo.json"
  mime_type: string;
  size: number;
  added_at: string; // ISO date string
}

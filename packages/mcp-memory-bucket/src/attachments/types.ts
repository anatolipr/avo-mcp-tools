export interface AttachmentEntry {
  filename: string;
  path: string; // relative to the doc's directory, e.g. "attachments/foo.json"
  added_at: string; // ISO date string
}

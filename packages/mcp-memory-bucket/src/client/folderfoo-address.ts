// Parses the opaque address string folderfoo's own File Open dialog sends
// in its "folderfoo-file-open" CustomEvent's detail.name — the exact same
// grammar folderfoo's server-side parseFolderFilenameParam (folders.js)
// expects, built by that widget's own addressFile() helper:
//   "name"                      - own file, root folder
//   "folder/path:name"          - own file, nested folder (unambiguous: contains "/")
//   ":folder:name"              - own file, single-segment folder (explicit empty-owner slot)
//   "owner:name"                - shared file, root folder
//   "owner:folder/path:name"    - shared file, nested folder
// ":" never appears in a folder path or filename itself (both are
// restricted to a safe charset server-side), so splitting on ":" is
// unambiguous once the segment count is known.
export interface ParsedFolderfooAddress {
  owner?: string;
  folderPath: string; // '' for root
  name: string;
}

export function parseFolderfooAddress(raw: string): ParsedFolderfooAddress {
  const parts = raw.split(':');
  if (parts.length === 1) {
    return { folderPath: '', name: parts[0]! };
  }
  if (parts.length === 2) {
    const [first, name] = parts as [string, string];
    if (first.includes('/')) {
      return { folderPath: first, name };
    }
    // Single-segment case: ambiguous with "owner:name" - by convention
    // (matching folders.js), treat a bare 2-part split as owner:name here.
    // A single-segment OWN folder always uses the 3-part empty-owner form.
    return { owner: first, folderPath: '', name };
  }
  const [ownerRaw, folderPath, ...nameParts] = parts;
  return {
    owner: ownerRaw === '' ? undefined : ownerRaw,
    folderPath: folderPath!,
    name: nameParts.join(':'),
  };
}

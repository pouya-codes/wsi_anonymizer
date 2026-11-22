import { csvEscape } from './csv';

/**
 * Original → anonymized filename mapping export (CSV / JSON).
 *
 * The mapping is a re-identification key: it is only ever saved to the user's
 * machine via a browser download and is never sent to the server.
 */

export interface MappingRow {
  original: string;
  anonymized: string;
}

export function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

export function mappingRowsOf(mapping: Record<string, string>): MappingRow[] {
  return Object.entries(mapping)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([original, anonymized]) => ({ original, anonymized }));
}

export function downloadBlob(filename: string, contents: Blob | string, mime: string): void {
  const blob = contents instanceof Blob ? contents : new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoke after the click has been dispatched so large blobs are not cut off.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}


export function downloadMappingJson(
  mapping: Record<string, string>,
  filename = 'anonymize-filename-mapping.json',
  extra: Record<string, unknown> = {}
): void {
  const payload = {
    generated_at: new Date().toISOString(),
    ...extra,
    mapping,
    rows: mappingRowsOf(mapping),
  };
  downloadBlob(filename, `${JSON.stringify(payload, null, 2)}\n`, 'application/json');
}

export function downloadMappingCsv(
  mapping: Record<string, string>,
  filename = 'anonymize-filename-mapping.csv'
): void {
  const lines = ['original_path,anonymized_path,original_filename,anonymized_filename'];
  for (const row of mappingRowsOf(mapping)) {
    lines.push(
      [
        csvEscape(row.original),
        csvEscape(row.anonymized),
        csvEscape(basename(row.original)),
        csvEscape(basename(row.anonymized)),
      ].join(',')
    );
  }
  downloadBlob(filename, `${lines.join('\n')}\n`, 'text/csv;charset=utf-8');
}

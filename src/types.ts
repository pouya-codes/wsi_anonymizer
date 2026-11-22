/** One local file the user selected, keyed by its sanitized relative path. */
export interface LocalFile {
  path: string;
  size: number;
  file: File;
}

/** A client-side grouping of local files into one slide (main file + companions). */
export interface LocalFileset {
  index: number;
  main: string;
  files: LocalFile[];
  size: number;
}

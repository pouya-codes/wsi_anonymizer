/**
 * File System Access API pieces not yet in TypeScript's lib.dom
 * (Chromium-only: Chrome / Edge / Opera). Used by the local Anonymize view to
 * write scrubbed slides into a folder the user picks.
 */
export {};

declare global {
  type FileSystemPermissionMode = 'read' | 'readwrite';

  interface FileSystemHandle {
    queryPermission?(descriptor?: { mode?: FileSystemPermissionMode }): Promise<PermissionState>;
    requestPermission?(descriptor?: { mode?: FileSystemPermissionMode }): Promise<PermissionState>;
  }

  interface DirectoryPickerOptions {
    id?: string;
    mode?: FileSystemPermissionMode;
    startIn?: FileSystemHandle | 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';
  }

  interface Window {
    showDirectoryPicker?(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
  }
}

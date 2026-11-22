declare module '@empaia/wsi-anon' {
  export default class AnonymizedStream {
    static create(file: File, chunkSize: number, path: string): AnonymizedStream;
    static exists(path: string): boolean;
    static retrieve(path: string): AnonymizedStream;
    static destroy(path: string): void;
    static ready: Promise<void>;
    static VERSION?: string;
    size: number;
    anonymize(): Promise<void>;
    getAnonymizedChunk(offset: number, size: number): Promise<ArrayBuffer>;
    read(): Promise<{ value?: Blob; done: boolean }>;
  }
}

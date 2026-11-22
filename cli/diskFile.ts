/**
 * A read-only, file-backed Blob look-alike for the command-line tool.
 *
 * The browser code (WSI-anon wrapper, label extraction, metadata scrub) only
 * uses `size`, `name`, `slice(start, end)` and `arrayBuffer()`, so this lets it
 * read multi-GB slides from disk in small pieces without loading them.
 * Works the same under Node, Deno and Bun.
 */
import * as fs from 'node:fs';

class Handle {
  private fd: number | null = null;
  constructor(readonly path: string) {}

  read(offset: number, length: number): ArrayBuffer {
    if (this.fd == null) this.fd = fs.openSync(this.path, 'r');
    const buf = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const n = fs.readSync(this.fd, buf, done, length - done, offset + done);
      if (n <= 0) break;
      done += n;
    }
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + done) as ArrayBuffer;
  }

  close(): void {
    if (this.fd != null) fs.closeSync(this.fd);
    this.fd = null;
  }
}

export class DiskFile {
  readonly type = '';
  readonly lastModified = 0;

  private constructor(
    private readonly handle: Handle,
    readonly name: string,
    private readonly start: number,
    readonly size: number
  ) {}

  static open(path: string, name: string): DiskFile {
    const size = fs.statSync(path).size;
    return new DiskFile(new Handle(path), name, 0, size);
  }

  slice(start = 0, end = this.size): DiskFile {
    const clamp = (v: number) => Math.max(0, Math.min(this.size, v < 0 ? this.size + v : v));
    const a = clamp(start);
    const b = Math.max(a, clamp(end));
    return new DiskFile(this.handle, this.name, this.start + a, b - a);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.handle.read(this.start, this.size);
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(await this.arrayBuffer());
  }

  close(): void {
    this.handle.close();
  }

  /** Use where the shared code expects a browser File. */
  asFile(): File {
    return this as unknown as File;
  }
}

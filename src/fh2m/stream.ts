// Big-endian binary streams matching fheroes2's IStreamBase / OStreamBase.
// Strings and containers are prefixed with a uint32 element count.

export class Reader {
  private pos = 0;
  private readonly view: DataView;
  private readonly buf: Uint8Array;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get offset(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new Error('Unexpected end of stream');
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }
  i8(): number {
    this.need(1);
    return this.view.getInt8(this.pos++);
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }
  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.pos);
    this.pos += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos);
    this.pos += 4;
    return v;
  }

  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  rest(): Uint8Array {
    return this.bytes(this.remaining);
  }

  // Map strings are raw bytes in the code page of the map language (e.g. cp1251 for Russian),
  // not UTF-8. They are kept as one char per byte so that decode/encode is lossless.
  string(): string {
    return Buffer.from(this.bytes(this.u32())).toString('latin1');
  }

  vec<T>(item: (r: Reader) => T): T[] {
    const n = this.u32();
    const out: T[] = [];
    for (let i = 0; i < n; i++) out.push(item(this));
    return out;
  }

  // std::array: the size is serialized too and must match.
  array<T>(size: number, item: (r: Reader) => T): T[] {
    const n = this.u32();
    if (n !== size) throw new Error(`Array size mismatch: expected ${size}, got ${n}`);
    const out: T[] = [];
    for (let i = 0; i < n; i++) out.push(item(this));
    return out;
  }

  map<K, V>(key: (r: Reader) => K, value: (r: Reader) => V): Map<K, V> {
    const n = this.u32();
    const out = new Map<K, V>();
    for (let i = 0; i < n; i++) {
      const k = key(this);
      out.set(k, value(this));
    }
    return out;
  }
}

export class Writer {
  private chunks: Uint8Array[] = [];
  private scratch = new DataView(new ArrayBuffer(4));

  private push4(n: number): void {
    this.chunks.push(new Uint8Array(this.scratch.buffer.slice(0, n)));
  }

  u8(v: number): this {
    this.scratch.setUint8(0, v);
    this.push4(1);
    return this;
  }
  i8(v: number): this {
    this.scratch.setInt8(0, v);
    this.push4(1);
    return this;
  }
  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }
  u16(v: number): this {
    this.scratch.setUint16(0, v);
    this.push4(2);
    return this;
  }
  i16(v: number): this {
    this.scratch.setInt16(0, v);
    this.push4(2);
    return this;
  }
  u32(v: number): this {
    this.scratch.setUint32(0, v);
    this.push4(4);
    return this;
  }
  i32(v: number): this {
    this.scratch.setInt32(0, v);
    this.push4(4);
    return this;
  }

  raw(b: Uint8Array): this {
    this.chunks.push(b);
    return this;
  }

  string(s: string): this {
    const b = Buffer.from(s, 'latin1');
    this.u32(b.length);
    return this.raw(b);
  }

  vec<T>(items: readonly T[], item: (w: Writer, v: T) => void): this {
    this.u32(items.length);
    for (const v of items) item(this, v);
    return this;
  }

  array<T>(size: number, items: readonly T[], item: (w: Writer, v: T) => void): this {
    if (items.length !== size) throw new Error(`Array size mismatch: expected ${size}, got ${items.length}`);
    return this.vec(items, item);
  }

  // std::map is ordered by key, so entries are written in ascending key order.
  map<K extends number, V>(m: ReadonlyMap<K, V>, key: (w: Writer, k: K) => void, value: (w: Writer, v: V) => void): this {
    this.u32(m.size);
    for (const k of [...m.keys()].sort((a, b) => a - b)) {
      key(this, k);
      value(this, m.get(k) as V);
    }
    return this;
  }

  toBytes(): Uint8Array {
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

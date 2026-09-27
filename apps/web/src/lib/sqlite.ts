/**
 * Reads the tables of an SQLite database file, and nothing more: no queries,
 * no indexes, no writing. Enough to bring in what another app kept, without a
 * wasm engine in the bundle. The format is sqlite.org/fileformat2.html.
 */

export type SqliteValue = null | number | string | Uint8Array;

export interface SqliteTable {
  name: string;
  rootPage: number;
  sql: string;
  columns: string[];
  /** The column that is the rowid (`INTEGER PRIMARY KEY`), whose value the record holds as null. */
  rowidColumn: number | null;
}

const MAGIC = "SQLite format 3\u0000";

export class SqliteFile {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private readonly pageSize: number;
  private readonly usable: number;
  private readonly pageCount: number;
  private readonly decoder: TextDecoder;
  readonly tables: Map<string, SqliteTable>;

  constructor(bytes: Uint8Array) {
    if (bytes.length < 100 || String.fromCharCode(...bytes.subarray(0, 16)) !== MAGIC) throw new Error("not an SQLite database");
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = this.view.getUint16(16);
    this.pageSize = size === 1 ? 65536 : size;
    this.usable = this.pageSize - this.view.getUint8(20);
    this.pageCount = Math.floor(bytes.length / this.pageSize);
    const encoding = this.view.getUint32(56);
    this.decoder = new TextDecoder(encoding === 2 ? "utf-16le" : encoding === 3 ? "utf-16be" : "utf-8");
    this.tables = new Map();
    for (const row of this.walk(1)) {
      const [type, name, , rootPage, sql] = row.values;
      if (type !== "table" || typeof name !== "string" || typeof rootPage !== "number" || typeof sql !== "string") continue;
      const { columns, rowidColumn } = parseColumns(sql);
      this.tables.set(name, { name, rootPage, sql, columns, rowidColumn });
    }
  }

  /** Every row of a table as an object by column name; a column added after the row was written reads as null. */
  *rows(name: string): Generator<Record<string, SqliteValue>> {
    const table = this.tables.get(name);
    if (!table) throw new Error(`no table ${name}`);
    for (const { rowid, values } of this.walk(table.rootPage)) {
      const row: Record<string, SqliteValue> = {};
      table.columns.forEach((column, i) => {
        row[column] = i === table.rowidColumn ? rowid : (values[i] ?? null);
      });
      yield row;
    }
  }

  /** The rows of a table b-tree, in rowid order. */
  private *walk(root: number): Generator<{ rowid: number; values: SqliteValue[] }> {
    const seen = new Set<number>();
    const stack = [root];
    while (stack.length) {
      const page = stack.pop()!;
      if (seen.has(page) || page < 1 || page > this.pageCount) throw new Error(`the database is damaged (page ${page})`);
      seen.add(page);
      const start = (page - 1) * this.pageSize;
      const header = page === 1 ? start + 100 : start;
      const kind = this.view.getUint8(header);
      const cells = this.view.getUint16(header + 3);
      if (kind === 0x05) {
        // Interior: children left to right, then the rightmost; pushed in reverse to come off in order.
        const children: number[] = [];
        for (let i = 0; i < cells; i++) children.push(this.view.getUint32(start + this.view.getUint16(header + 12 + i * 2)));
        children.push(this.view.getUint32(header + 8));
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
      } else if (kind === 0x0d) {
        for (let i = 0; i < cells; i++) yield this.leafCell(start + this.view.getUint16(header + 8 + i * 2));
      } else {
        throw new Error(`the database is damaged (page ${page} is of kind ${kind})`);
      }
    }
  }

  private leafCell(at: number): { rowid: number; values: SqliteValue[] } {
    const [size, n1] = this.varint(at);
    const [rowid, n2] = this.varint(at + n1);
    const local = at + n1 + n2;
    return { rowid, values: this.record(this.payload(local, size)) };
  }

  /** A cell's payload whole, following its overflow pages when it did not fit on its own. */
  private payload(at: number, size: number): Uint8Array {
    const max = this.usable - 35;
    if (size <= max) return this.bytes.subarray(at, at + size);
    const min = Math.floor(((this.usable - 12) * 32) / 255) - 23;
    const k = min + ((size - min) % (this.usable - 4));
    const here = k <= max ? k : min;
    const out = new Uint8Array(size);
    out.set(this.bytes.subarray(at, at + here));
    let filled = here;
    let next = this.view.getUint32(at + here);
    const seen = new Set<number>();
    while (filled < size) {
      if (next < 1 || next > this.pageCount || seen.has(next)) throw new Error(`the database is damaged (overflow page ${next})`);
      seen.add(next);
      const start = (next - 1) * this.pageSize;
      const take = Math.min(size - filled, this.usable - 4);
      out.set(this.bytes.subarray(start + 4, start + 4 + take), filled);
      filled += take;
      next = this.view.getUint32(start);
    }
    return out;
  }

  private record(payload: Uint8Array): SqliteValue[] {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const [headerSize, n] = varintAt(payload, 0);
    const types: number[] = [];
    for (let at = n; at < headerSize; ) {
      const [type, m] = varintAt(payload, at);
      types.push(type);
      at += m;
    }
    const values: SqliteValue[] = [];
    let at = headerSize;
    for (const type of types) {
      if (type === 0) values.push(null);
      else if (type >= 1 && type <= 6) {
        const width = [0, 1, 2, 3, 4, 6, 8][type]!;
        values.push(signed(payload, at, width));
        at += width;
      } else if (type === 7) {
        values.push(view.getFloat64(at));
        at += 8;
      } else if (type === 8 || type === 9) values.push(type - 8);
      else if (type >= 12) {
        const length = (type - (type % 2 ? 13 : 12)) / 2;
        const bytes = payload.subarray(at, at + length);
        values.push(type % 2 ? this.decoder.decode(bytes) : bytes.slice());
        at += length;
      } else throw new Error(`the database is damaged (serial type ${type})`);
    }
    return values;
  }

  private varint(at: number): [value: number, length: number] {
    return varintAt(this.bytes, at);
  }
}

/** A big-endian varint of up to nine bytes; the last one gives all eight of its bits. */
function varintAt(bytes: Uint8Array, at: number): [value: number, length: number] {
  let value = 0n;
  for (let i = 0; i < 9; i++) {
    const b = bytes[at + i] ?? 0;
    if (i === 8) return [Number((value << 8n) | BigInt(b)), 9];
    value = (value << 7n) | BigInt(b & 0x7f);
    if (b < 0x80) return [Number(value), i + 1];
  }
  return [Number(value), 9];
}

function signed(bytes: Uint8Array, at: number, width: number): number {
  let value = 0n;
  for (let i = 0; i < width; i++) value = (value << 8n) | BigInt(bytes[at + i] ?? 0);
  return Number(BigInt.asIntN(width * 8, value));
}

/** The column names of a `CREATE TABLE`, in order, and which of them is the rowid. */
export function parseColumns(sql: string): { columns: string[]; rowidColumn: number | null } {
  const body = sql.slice(sql.indexOf("(") + 1, sql.lastIndexOf(")"));
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const ch of body) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "[") quote = "]";
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  const columns: string[] = [];
  let rowidColumn: number | null = null;
  for (const part of parts) {
    const def = part.trim();
    if (/^(constraint|primary|unique|check|foreign)\b/i.test(def)) continue;
    const match = /^(?:"((?:[^"]|"")*)"|`([^`]*)`|\[([^\]]*)\]|(\S+))\s*(.*)$/s.exec(def);
    if (!match) continue;
    const name = match[1]?.replace(/""/g, '"') ?? match[2] ?? match[3] ?? match[4] ?? "";
    const rest = match[5] ?? "";
    if (/^integer\b/i.test(rest) && /\bprimary\s+key\b/i.test(rest) && !/\bdesc\b/i.test(rest)) rowidColumn = columns.length;
    columns.push(name);
  }
  return { columns, rowidColumn };
}

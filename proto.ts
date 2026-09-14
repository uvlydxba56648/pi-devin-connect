/** Minimal protobuf encode/decode for Devin Connect wire types. */

export function encodeVarint(value: number | bigint): Buffer {
  const bytes: number[] = [];
  let v = BigInt(value);
  if (v < 0n) throw new RangeError("negative varint");
  while (v > 127n) {
    bytes.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

export function encodeTag(field: number, wire: number): Buffer {
  return encodeVarint((field << 3) | wire);
}

export function encodeString(field: number, value: string): Buffer {
  const buf = Buffer.from(value, "utf8");
  return Buffer.concat([encodeTag(field, 2), encodeVarint(buf.length), buf]);
}

export function encodeBytes(field: number, buf: Buffer): Buffer {
  return Buffer.concat([encodeTag(field, 2), encodeVarint(buf.length), buf]);
}

export function encodeMessage(field: number, body: Buffer): Buffer {
  return encodeBytes(field, body);
}

export function encodeVarintField(field: number, value: number | bigint): Buffer {
  return Buffer.concat([encodeTag(field, 0), encodeVarint(value)]);
}

export function encodeBool(field: number, value: boolean): Buffer {
  return encodeVarintField(field, value ? 1 : 0);
}

export function encodeDouble(field: number, value: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(value, 0);
  return Buffer.concat([encodeTag(field, 1), b]);
}

export interface ProtoField {
  num: number;
  wire: number;
  value: bigint | Buffer;
}

export function decodeVarint(buf: Buffer, offset: number): [bigint, number] {
  let res = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i++];
    res |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [res, i];
    shift += 7n;
  }
  throw new Error("truncated varint");
}

export function* iterFields(buf: Buffer): Generator<ProtoField> {
  let i = 0;
  while (i < buf.length) {
    const [tagBig, next] = decodeVarint(buf, i);
    i = next;
    const tag = Number(tagBig);
    const num = tag >> 3;
    const wire = tag & 0x7;
    if (wire === 0) {
      const [v, after] = decodeVarint(buf, i);
      i = after;
      yield { num, wire, value: v };
    } else if (wire === 1) {
      if (i + 8 > buf.length) return;
      yield { num, wire, value: buf.subarray(i, i + 8) };
      i += 8;
    } else if (wire === 2) {
      const [len, after] = decodeVarint(buf, i);
      i = after;
      const end = i + Number(len);
      if (end > buf.length) return;
      yield { num, wire, value: buf.subarray(i, end) };
      i = end;
    } else if (wire === 5) {
      if (i + 4 > buf.length) return;
      yield { num, wire, value: buf.subarray(i, i + 4) };
      i += 4;
    } else {
      return;
    }
  }
}

export function fieldString(field: ProtoField): string {
  return Buffer.isBuffer(field.value) ? field.value.toString("utf8") : "";
}

export function fieldBool(field: ProtoField): boolean {
  return typeof field.value === "bigint" ? field.value !== 0n : false;
}

export function fieldInt(field: ProtoField): number {
  return typeof field.value === "bigint" ? Number(field.value) : 0;
}

export function fieldBuf(field: ProtoField): Buffer {
  return Buffer.isBuffer(field.value) ? field.value : Buffer.alloc(0);
}

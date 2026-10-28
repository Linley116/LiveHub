// 腾讯 Tars 编解码：虎牙 WUP 与 WebSocket 弹幕都使用这套字段格式。
const TYPE = {
  BYTE: 0,
  SHORT: 1,
  INT: 2,
  LONG: 3,
  FLOAT: 4,
  DOUBLE: 5,
  STRING1: 6,
  STRING4: 7,
  MAP: 8,
  LIST: 9,
  STRUCT_BEGIN: 10,
  STRUCT_END: 11,
  ZERO: 12,
  SIMPLE_LIST: 13,
};

export const TARS_TYPE = TYPE;

export class TarsWriter {
  constructor() {
    this.buf = [];
  }

  /** Tars head: 高 4 位是 tag，低 4 位是类型；tag >= 15 使用扩展字节。 */
  head(type, tag) {
    if (tag < 0 || tag > 255) throw new RangeError(`Tars tag 超出范围：${tag}`);
    if (tag < 15) this.buf.push((tag << 4) | type);
    else this.buf.push((15 << 4) | type, tag);
    return this;
  }

  /** 按 Tars 规则使用可容纳该值的最窄整型；0 使用 ZERO_TAG。 */
  int(value, tag) {
    const v = Number.isFinite(value) ? Math.trunc(value) : 0;
    if (v === 0) return this.head(TYPE.ZERO, tag);
    if (v >= -128 && v <= 127) {
      this.head(TYPE.BYTE, tag);
      this.buf.push(v & 0xff);
    } else if (v >= -32768 && v <= 32767) {
      this.head(TYPE.SHORT, tag);
      this.pushInt(v, 2);
    } else if (v >= -2147483648 && v <= 2147483647) {
      this.head(TYPE.INT, tag);
      this.pushInt(v, 4);
    } else {
      this.head(TYPE.LONG, tag);
      this.pushInt(v, 8);
    }
    return this;
  }

  bool(value, tag) {
    return this.int(value ? 1 : 0, tag);
  }

  string(value, tag) {
    const bytes = Buffer.from(value == null ? '' : String(value), 'utf8');
    if (bytes.length <= 255) {
      this.head(TYPE.STRING1, tag);
      this.buf.push(bytes.length);
    } else {
      this.head(TYPE.STRING4, tag);
      this.pushInt(bytes.length, 4);
    }
    for (const b of bytes) this.buf.push(b);
    return this;
  }

  /** vector<byte>：元素类型头 + Tars 整数长度 + 原始字节。 */
  bytes(value, tag) {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
    this.head(TYPE.SIMPLE_LIST, tag);
    this.head(TYPE.BYTE, 0);
    this.int(buf.length, 0);
    for (const b of buf) this.buf.push(b);
    return this;
  }

  /** vector<string>，供虎牙 wsapi 的消息组订阅使用。 */
  stringList(values, tag) {
    this.head(TYPE.LIST, tag);
    this.int(values.length, 0);
    for (const value of values) this.string(value, 0);
    return this;
  }

  // 严格宽度写法用于 TUP RequestPacket 的协议字段。
  byte(value, tag) {
    this.head(TYPE.BYTE, tag);
    this.buf.push(value & 0xff);
    return this;
  }

  short(value, tag) {
    this.head(TYPE.SHORT, tag);
    this.pushInt(value, 2);
    return this;
  }

  int32(value, tag) {
    this.head(TYPE.INT, tag);
    this.pushInt(value, 4);
    return this;
  }

  int64(value, tag) {
    this.head(TYPE.LONG, tag);
    this.pushInt(value, 8);
    return this;
  }

  mapBytes(entries, tag) {
    this.head(TYPE.MAP, tag);
    this.int(entries.length, 0);
    for (const [key, buf] of entries) {
      this.string(key, 0);
      this.bytes(buf, 1);
    }
    return this;
  }

  emptyMap(tag) {
    this.head(TYPE.MAP, tag);
    this.int(0, 0);
    return this;
  }

  struct(writer, tag) {
    this.head(TYPE.STRUCT_BEGIN, tag);
    for (const b of writer.toBuffer()) this.buf.push(b);
    this.head(TYPE.STRUCT_END, 0);
    return this;
  }

  pushInt(value, size) {
    const b = Buffer.alloc(size);
    if (size === 8) b.writeBigInt64BE(BigInt(value));
    else if (size === 4) b.writeInt32BE(value);
    else if (size === 2) b.writeInt16BE(value);
    else if (size === 1) b.writeInt8(value);
    else throw new RangeError(`不支持的 Tars 整数宽度：${size}`);
    for (const byte of b) this.buf.push(byte);
  }

  toBuffer() {
    return Buffer.from(this.buf);
  }
}

export class TarsReader {
  constructor(buffer) {
    this.buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    this.pos = 0;
  }

  get done() {
    return this.pos >= this.buf.length;
  }

  head() {
    if (this.done) throw new RangeError('Tars 数据意外结束');
    const b = this.buf[this.pos++];
    const type = b & 0x0f;
    let tag = b >> 4;
    if (tag === 0x0f) {
      if (this.done) throw new RangeError('Tars 扩展 tag 不完整');
      tag = this.buf[this.pos++];
    }
    return { type, tag };
  }

  int(type) {
    switch (type) {
      case TYPE.ZERO: return 0;
      case TYPE.BYTE: {
        const v = this.buf.readInt8(this.pos);
        this.pos += 1;
        return v;
      }
      case TYPE.SHORT: {
        const v = this.buf.readInt16BE(this.pos);
        this.pos += 2;
        return v;
      }
      case TYPE.INT: {
        const v = this.buf.readInt32BE(this.pos);
        this.pos += 4;
        return v;
      }
      case TYPE.LONG: {
        const v = this.buf.readBigInt64BE(this.pos);
        this.pos += 8;
        return Number(v);
      }
      default:
        throw new Error(`未支持的 Tars 整数类型 ${type}`);
    }
  }

  string(type) {
    // 部分实现（虎牙 wsapi）会把空字符串写成 ZERO_TAG
    if (type === TYPE.ZERO) return '';
    let len;
    if (type === TYPE.STRING1) {
      if (this.done) throw new RangeError('Tars string1 缺少长度');
      len = this.buf[this.pos++];
    } else if (type === TYPE.STRING4) {
      if (this.pos + 4 > this.buf.length) throw new RangeError('Tars string4 缺少长度');
      len = this.buf.readUInt32BE(this.pos);
      this.pos += 4;
    } else {
      throw new Error(`未支持的 Tars 字符串类型 ${type}`);
    }
    if (this.pos + len > this.buf.length) throw new RangeError('Tars 字符串长度超出数据范围');
    const s = this.buf.toString('utf8', this.pos, this.pos + len);
    this.pos += len;
    return s;
  }

  /** 当前 SIMPLE_LIST 字段的元素类型头已在字段头之后，按 type 解析数据体。 */
  bytes(type) {
    if (type !== TYPE.SIMPLE_LIST) throw new Error(`Tars 字段不是 vector<byte>（type=${type}）`);
    const element = this.head();
    if (element.type !== TYPE.BYTE) throw new Error(`Tars vector<byte> 元素类型错误（type=${element.type}）`);
    const len = this.readIntField();
    if (len < 0 || this.pos + len > this.buf.length) throw new RangeError('Tars 字节数组长度超出数据范围');
    const out = Buffer.from(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return out;
  }

  readIntField() {
    const { type } = this.head();
    return this.int(type);
  }

  readStringField() {
    const { type } = this.head();
    return this.string(type);
  }

  readBytesField() {
    const { type } = this.head();
    return this.bytes(type);
  }

  readListSize(type) {
    if (type !== TYPE.LIST) throw new Error(`Tars 字段不是 list（type=${type}）`);
    const size = this.readIntField();
    if (size < 0 || size > 100_000) throw new RangeError(`Tars list 长度异常：${size}`);
    return size;
  }

  /** 跳过未知字段，支持容器、结构体和简单字节数组。 */
  skip(type) {
    switch (type) {
      case TYPE.ZERO:
      case TYPE.STRUCT_END:
        break;
      case TYPE.BYTE: this.pos += 1; break;
      case TYPE.SHORT: this.pos += 2; break;
      case TYPE.INT: this.pos += 4; break;
      case TYPE.LONG: this.pos += 8; break;
      case TYPE.FLOAT: this.pos += 4; break;
      case TYPE.DOUBLE: this.pos += 8; break;
      case TYPE.STRING1:
      case TYPE.STRING4: this.string(type); break;
      case TYPE.SIMPLE_LIST: this.bytes(type); break;
      case TYPE.LIST: {
        const size = this.readIntField();
        if (size < 0 || size > 100_000) throw new RangeError(`Tars list 长度异常：${size}`);
        for (let i = 0; i < size; i++) {
          const element = this.head();
          this.skip(element.type);
        }
        break;
      }
      case TYPE.MAP: {
        const size = this.readIntField();
        if (size < 0 || size > 100_000) throw new RangeError(`Tars map 长度异常：${size}`);
        for (let i = 0; i < size * 2; i++) {
          const field = this.head();
          this.skip(field.type);
        }
        break;
      }
      case TYPE.STRUCT_BEGIN:
        while (!this.done) {
          const field = this.head();
          if (field.type === TYPE.STRUCT_END) break;
          this.skip(field.type);
        }
        break;
      default:
        throw new Error(`无法跳过 Tars 类型 ${type}`);
    }
    if (this.pos > this.buf.length) throw new RangeError('Tars 字段长度超出数据范围');
  }
}

import { createDecipheriv, createHmac, pbkdf2Sync, timingSafeEqual } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";

const SQLITE_HEADER = Buffer.from("SQLite format 3\0");
const PAGE_SIZE = 4096;
const RESERVED = 80;
const DEFAULT_SQLCIPHER_KEY = "3605f6691095a993f03d5009c918352ef5be31ae31e8f000212b81ff058da773";
const CACHE_PAGES = 64;
const MAX_WAL_INDEX_PAGES = 1024 * 1024;

function makeError(message: string): Error {
  return new Error(`Cannot read TRAE international usage: ${message}`);
}

function makeTransientError(message: string): Error & { transient: true } {
  return Object.assign(makeError(message), { transient: true as const });
}

function statOptional(filePath: string) {
  try {
    return statSync(filePath, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return null;
    }

    throw error;
  }
}

function sameStat(a: ReturnType<typeof statOptional>, b: ReturnType<typeof statOptional>): boolean {
  if (!a || !b) {
    return a === b;
  }

  return a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.ino === b.ino;
}

function readExact(fd: number, target: Buffer, offset: number): Buffer {
  let bytesRead = 0;

  while (bytesRead < target.length) {
    const count = readSync(fd, target, bytesRead, target.length - bytesRead, offset + bytesRead);
    if (!count) {
      throw makeTransientError("database or WAL was truncated during the read; retry when Trae is idle.");
    }
    bytesRead += count;
  }

  return target;
}

function pageDecryptor(firstPage: Buffer) {
  const override = String(process.env.TRAE_INTL_SQLCIPHER_KEY ?? "").trim();
  const hex = override || DEFAULT_SQLCIPHER_KEY;

  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw makeError("TRAE_INTL_SQLCIPHER_KEY must contain 64 hex characters.");
  }

  const key = Buffer.from(hex, "hex");
  const salt = Buffer.from(firstPage.subarray(0, 16).map((byte) => byte ^ 0x3a));
  const hmacKey = pbkdf2Sync(key, salt, 2, 32, "sha512");
  salt.fill(0);

  return {
    decrypt(page: Buffer, pageNumber: number) {
      const start = pageNumber === 1 ? 16 : 0;
      const ivOffset = PAGE_SIZE - RESERVED;
      const pageId = Buffer.alloc(4);
      pageId.writeUInt32LE(pageNumber);
      const expected = createHmac("sha512", hmacKey)
        .update(page.subarray(start, ivOffset + 16))
        .update(pageId)
        .digest();

      if (!timingSafeEqual(expected, page.subarray(ivOffset + 16))) {
        throw makeError("SQLCipher authentication failed. The shared Trae key may have changed.");
      }

      const decipher = createDecipheriv("aes-256-cbc", key, page.subarray(ivOffset, ivOffset + 16));
      decipher.setAutoPadding(false);
      const decoded = decipher.update(page.subarray(start, ivOffset));
      decipher.final();
      page.fill(0);
      if (pageNumber === 1) {
        SQLITE_HEADER.copy(page);
      }
      decoded.copy(page, start);
      decoded.fill(0);

      if (pageNumber === 1 && (page.readUInt16BE(16) !== PAGE_SIZE || page[20] !== RESERVED)) {
        throw makeError("unsupported SQLCipher page format.");
      }

      return page;
    },
    dispose() {
      key.fill(0);
      hmacKey.fill(0);
    }
  };
}

function checksum(data: Buffer, bigEndian: boolean, state: [number, number] = [0, 0]): [number, number] {
  let [a, b] = state;

  for (let index = 0; index < data.length; index += 8) {
    const x = bigEndian ? data.readUInt32BE(index) : data.readUInt32LE(index);
    const y = bigEndian ? data.readUInt32BE(index + 4) : data.readUInt32LE(index + 4);
    a = (a + x + b) >>> 0;
    b = (b + y + a) >>> 0;
  }

  return [a, b];
}

function indexWal(fd: number | null, size: number, pageSize: number) {
  const pages = new Map<number, number>();

  if (fd == null || size === 0) {
    return { pages, pageCount: null as number | null };
  }

  if (size < 32) {
    throw makeTransientError("incomplete WAL header; retry when Trae is idle.");
  }

  const header = readExact(fd, Buffer.alloc(32), 0);
  const magic = header.readUInt32BE(0);
  if ((magic !== 0x377f0682 && magic !== 0x377f0683) || header.readUInt32BE(4) !== 3007000 || header.readUInt32BE(8) !== pageSize) {
    throw makeError("unsupported WAL format.");
  }

  const bigEndian = magic === 0x377f0683;
  let sum = checksum(header.subarray(0, 24), bigEndian);
  if (sum[0] !== header.readUInt32BE(24) || sum[1] !== header.readUInt32BE(28)) {
    throw makeError("WAL header checksum failed.");
  }

  let pageCount: number | null = null;
  let pending = new Map<number, number>();
  const frame = Buffer.alloc(24 + pageSize);

  for (let offset = 32; offset + frame.length <= size; offset += frame.length) {
    readExact(fd, frame, offset);

    if (!frame.subarray(8, 16).equals(header.subarray(16, 24))) {
      break;
    }

    sum = checksum(frame.subarray(24), bigEndian, checksum(frame.subarray(0, 8), bigEndian, sum));
    if (sum[0] !== frame.readUInt32BE(16) || sum[1] !== frame.readUInt32BE(20)) {
      break;
    }

    const pageNumber = frame.readUInt32BE(0);
    const commit = frame.readUInt32BE(4);
    if (!pageNumber || pageNumber === 0xffffffff || commit === 0xffffffff) {
      throw makeError("invalid WAL page number or database size.");
    }

    pending.set(pageNumber, offset + 24);
    if (pending.size + pages.size > MAX_WAL_INDEX_PAGES) {
      throw makeError("WAL index exceeds the bounded-memory limit; let Trae checkpoint its WAL and retry.");
    }

    if (commit) {
      for (const [page, position] of pending) {
        pages.set(page, position);
      }
      pending = new Map();
      pageCount = commit;
      for (const page of pages.keys()) {
        if (page > commit) {
          pages.delete(page);
        }
      }
    }
  }

  frame.fill(0);
  return { pages, pageCount };
}

export interface TraeSnapshot {
  byteLength: number;
  read(target: Uint8Array, offset: number): number;
  isStable(): boolean;
  close(): void;
}

export function openTraeSnapshot(databasePath: string): TraeSnapshot {
  const paths = [databasePath, `${databasePath}-wal`, `${databasePath}-journal`];
  const before = paths.map(statOptional);

  if (!before[0]) {
    throw makeError("database no longer exists.");
  }

  if (before.some((stat) => stat && (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER)))) {
    throw makeError("unsupported database file or size.");
  }

  const handles: number[] = [];
  const cache = new Map<number, Buffer>();
  let decryptor: ReturnType<typeof pageDecryptor> | null = null;

  const close = () => {
    for (const page of cache.values()) {
      page.fill(0);
    }
    cache.clear();

    if (decryptor) {
      decryptor.dispose();
      decryptor = null;
    }

    let failure: unknown;
    while (handles.length > 0) {
      try {
        closeSync(handles.pop() as number);
      } catch (error) {
        failure ??= error;
      }
    }

    if (failure) {
      throw failure;
    }
  };

  try {
    const dbFd = openSync(databasePath, "r");
    handles.push(dbFd);

    if (!sameStat(before[0], fstatSync(dbFd, { bigint: true }))) {
      throw makeTransientError("database changed while opening; retry when Trae is idle.");
    }

    let walFd: number | null = null;
    if (before[1]) {
      walFd = openSync(paths[1], "r");
      handles.push(walFd);

      if (!sameStat(before[1], fstatSync(walFd, { bigint: true }))) {
        throw makeTransientError("WAL changed while opening; retry when Trae is idle.");
      }
    }

    if (before[2] && before[2].size >= 8n) {
      const journalFd = openSync(paths[2], "r");
      handles.push(journalFd);
      if (readExact(journalFd, Buffer.alloc(8), 0).some((byte) => byte !== 0)) {
        throw makeError("a rollback transaction is active; retry when Trae is idle.");
      }
    }

    const size = Number(before[0].size);
    if (size < 100) {
      throw makeError("database is truncated.");
    }

    const header = readExact(dbFd, Buffer.alloc(100), 0);
    const encrypted = !header.subarray(0, 16).equals(SQLITE_HEADER);
    const encodedSize = encrypted ? PAGE_SIZE : header.readUInt16BE(16);
    const pageSize = encodedSize === 1 ? 65536 : encodedSize;
    if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0 || size % pageSize !== 0) {
      throw makeError("invalid database page size or truncated database.");
    }

    if (encrypted) {
      decryptor = pageDecryptor(header);
    }

    const { pages, pageCount } = indexWal(walFd, Number(before[1]?.size ?? 0n), pageSize);
    const finalPageCount = pageCount == null ? size / pageSize : pageCount;
    if (!finalPageCount || finalPageCount > 0xfffffffe) {
      throw makeError("invalid database size.");
    }

    const byteLength = finalPageCount * pageSize;
    const getPage = (pageNumber: number): Buffer => {
      const cached = cache.get(pageNumber);
      if (cached) {
        cache.delete(pageNumber);
        cache.set(pageNumber, cached);
        return cached;
      }

      const page = Buffer.alloc(pageSize);
      try {
        if (pages.has(pageNumber) && walFd != null) {
          readExact(walFd, page, pages.get(pageNumber) as number);
        } else {
          readExact(dbFd, page, (pageNumber - 1) * pageSize);
        }

        if (decryptor) {
          decryptor.decrypt(page, pageNumber);
        }

        if (pageNumber === 1) {
          page[18] = 1;
          page[19] = 1;
          page.writeUInt32BE(finalPageCount, 28);
          page.writeUInt32BE(page.readUInt32BE(24), 92);
        }
      } catch (error) {
        page.fill(0);
        throw error;
      }

      cache.set(pageNumber, page);
      if (cache.size > CACHE_PAGES) {
        const oldest = cache.keys().next().value as number;
        const oldestPage = cache.get(oldest);
        if (oldestPage) {
          oldestPage.fill(0);
        }
        cache.delete(oldest);
      }

      return page;
    };

    return {
      byteLength,
      read(target: Uint8Array, offset: number): number {
        if (!Number.isSafeInteger(offset) || offset < 0) {
          throw makeError("invalid read offset.");
        }

        target.fill(0);
        const count = Math.min(target.length, Math.max(0, byteLength - offset));
        let copied = 0;

        while (copied < count) {
          const position = offset + copied;
          const pageOffset = position % pageSize;
          const length = Math.min(count - copied, pageSize - pageOffset);
          const page = getPage(Math.floor(position / pageSize) + 1);
          target.set(page.subarray(pageOffset, pageOffset + length), copied);
          copied += length;
        }

        return count;
      },
      isStable(): boolean {
        return paths.map(statOptional).every((stat, index) => sameStat(before[index], stat));
      },
      close
    };
  } catch (error) {
    close();
    throw error;
  }
}

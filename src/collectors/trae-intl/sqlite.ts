import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { openTraeSnapshot, type TraeSnapshot } from "./snapshot.js";

let enginePromise: Promise<any> | undefined;
let queryQueue = Promise.resolve();
const require = createRequire(import.meta.url);

async function createEngine() {
  const [{ default: initialize }, sqlite, facadeModule] = await Promise.all([
    import("@journeyapps/wa-sqlite/dist/wa-sqlite.mjs"),
    import("@journeyapps/wa-sqlite"),
    import("@journeyapps/wa-sqlite/src/FacadeVFS.js")
  ]);

  const wasmPath = require.resolve("@journeyapps/wa-sqlite/dist/wa-sqlite.wasm");
  const module = await initialize({
    wasmBinary: readFileSync(wasmPath)
  });

  const api = sqlite.Factory(module);
  const snapshots = new Map<string, { snapshot: TraeSnapshot; error: unknown }>();
  const handles = new Map<number, { snapshot: TraeSnapshot; error: unknown }>();
  const { FacadeVFS } = facadeModule as { FacadeVFS: new (name: string, module: unknown) => any };

  class TraeVFS extends FacadeVFS {
    constructor() {
      super("ai-token-hall-trae", module);
    }

    jOpen(name: string, fileId: number, flags: number, outputFlags: DataView) {
      const state = snapshots.get(name);
      if (!state || !(flags & sqlite.SQLITE_OPEN_MAIN_DB)) {
        return sqlite.SQLITE_CANTOPEN;
      }

      handles.set(fileId, state);
      outputFlags.setInt32(0, sqlite.SQLITE_OPEN_READONLY, true);
      return sqlite.SQLITE_OK;
    }

    jRead(fileId: number, output: Uint8Array, offset: number) {
      const state = handles.get(fileId);
      if (!state) {
        return sqlite.SQLITE_IOERR_READ;
      }

      const buffer = Buffer.alloc(output.byteLength);
      try {
        const count = state.snapshot.read(buffer, offset);
        buffer.fill(0, count);
        output.set(buffer);
        return count === buffer.length ? sqlite.SQLITE_OK : sqlite.SQLITE_IOERR_SHORT_READ;
      } catch (error) {
        state.error ||= error;
        output.fill(0);
        return sqlite.SQLITE_IOERR_READ;
      } finally {
        buffer.fill(0);
      }
    }

    jFileSize(fileId: number, output: DataView) {
      const state = handles.get(fileId);
      if (!state) {
        return sqlite.SQLITE_IOERR_FSTAT;
      }

      output.setBigInt64(0, BigInt(state.snapshot.byteLength), true);
      return sqlite.SQLITE_OK;
    }

    jClose(fileId: number) {
      handles.delete(fileId);
      return sqlite.SQLITE_OK;
    }

    jAccess(name: string, _flags: number, output: DataView) {
      output.setInt32(0, snapshots.has(name) ? 1 : 0, true);
      return sqlite.SQLITE_OK;
    }

    jWrite() {
      return sqlite.SQLITE_READONLY;
    }

    jTruncate() {
      return sqlite.SQLITE_READONLY;
    }

    jDelete() {
      return sqlite.SQLITE_READONLY;
    }
  }

  const vfs = new TraeVFS();
  api.vfs_register(vfs as any, false);
  return { api, sqlite, snapshots, handles, vfs, nextId: 0 };
}

async function querySnapshot<T>(
  snapshot: TraeSnapshot,
  callback: (query: (sql: string) => Promise<Array<Record<string, unknown>>>) => Promise<T>
): Promise<T> {
  enginePromise ||= createEngine().catch((error) => {
    enginePromise = undefined;
    throw error;
  });

  const engine = await enginePromise;
  const { api, sqlite, snapshots, handles, vfs } = engine;
  const name = `trae-${++engine.nextId}.db`;
  const state = { snapshot, error: null as unknown };
  snapshots.set(name, state);

  let db: number | undefined;
  let failure: unknown;

  try {
    db = await api.open_v2(name, sqlite.SQLITE_OPEN_READONLY, vfs.name);
    const query = async (sql: string) => {
      const rows: Array<Record<string, unknown>> = [];
      try {
        await api.exec(db, sql, (values: unknown[], columns: string[]) => {
          rows.push(Object.fromEntries(columns.map((column, index) => [column, values[index]])));
        });
      } catch (error) {
        throw state.error || error;
      }

      return rows;
    };

    await query("PRAGMA query_only=ON; PRAGMA cache_size=-4096; PRAGMA temp_store=MEMORY;");
    return await callback(query);
  } catch (error) {
    failure = state.error || error;
    throw failure;
  } finally {
    try {
      if (db != null) {
        await api.close(db);
      }
    } catch (error) {
      if (!failure) {
        throw state.error || error;
      }
    } finally {
      snapshots.delete(name);
      for (const [fileId, opened] of handles.entries()) {
        if (opened === state) {
          handles.delete(fileId);
        }
      }
    }
  }
}

export function withTraeIntlSqlite<T>(
  snapshot: TraeSnapshot,
  callback: (query: (sql: string) => Promise<Array<Record<string, unknown>>>) => Promise<T>
): Promise<T> {
  const operation = queryQueue.then(() => querySnapshot(snapshot, callback));
  queryQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export { openTraeSnapshot };

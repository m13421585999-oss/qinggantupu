import { createClient, type Client, type InValue, type ResultSet } from "@libsql/client";

function connection() {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) {
    throw new Error("Turso database environment is not configured");
  }
  return { url, authToken };
}

let client: Client | undefined;

function getClient() {
  client ??= createClient(connection());
  return client;
}

function inputValue(value: unknown): InValue {
  if (value === undefined) return null;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return value as InValue;
}

function meta(result: ResultSet) {
  return {
    duration: 0,
    size_after: 0,
    rows_read: result.rows.length,
    rows_written: result.rowsAffected,
    last_row_id: result.lastInsertRowid,
    changed_db: result.rowsAffected > 0,
    changes: result.rowsAffected,
  };
}

class TursoStatement {
  constructor(
    readonly client: Client,
    readonly query: string,
    readonly values: InValue[] = [],
  ) {}

  bind(...values: unknown[]) {
    return new TursoStatement(this.client, this.query, values.map(inputValue));
  }

  private execute() {
    return this.client.execute({ sql: this.query, args: this.values });
  }

  async first<T = Record<string, unknown>>(columnName?: string): Promise<T | null> {
    const result = await this.execute();
    const row = result.rows[0];
    if (!row) return null;
    return (columnName ? row[columnName] : row) as T;
  }

  async all<T = Record<string, unknown>>() {
    const result = await this.execute();
    return {
      results: result.rows as unknown as T[],
      success: true,
      meta: meta(result),
    };
  }

  async run() {
    const result = await this.execute();
    return { success: true, meta: meta(result), results: [] };
  }

  async raw<T = unknown[]>() {
    const result = await this.execute();
    return result.rows.map((row) => Array.from(row)) as T[];
  }
}

class TursoDatabase {
  constructor(private readonly client: Client) {}

  prepare(query: string) {
    return new TursoStatement(this.client, query);
  }

  async batch(statements: D1PreparedStatement[]) {
    const prepared = statements as unknown as TursoStatement[];
    const results = await this.client.batch(
      prepared.map((statement) => ({ sql: statement.query, args: statement.values })),
      "write",
    );
    return results.map((result) => ({
      results: result.rows,
      success: true,
      meta: meta(result),
    }));
  }
}

export function createTursoD1(): D1Database {
  return new TursoDatabase(getClient()) as unknown as D1Database;
}

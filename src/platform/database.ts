export type SqlQueryResult<T extends Record<string, unknown>> = Readonly<{
  rows: T[];
  affectedRows?: number;
}>;

export type SqlTransaction = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    parameters?: unknown[]
  ): Promise<SqlQueryResult<T>>;
};

export type TransactionalDatabase = {
  transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T>;
};

export async function withTransaction<T>(
  database: TransactionalDatabase,
  work: (transaction: SqlTransaction) => Promise<T>
): Promise<T> {
  return database.transaction(work);
}

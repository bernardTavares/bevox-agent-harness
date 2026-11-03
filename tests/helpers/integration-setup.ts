import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from 'pg'

/**
 * Apply all SQL migration files (in lexical order) from the `migrations/`
 * directory to the given Postgres connection.
 *
 * Migrations are split on `-- DOWN` markers (UP section is everything before)
 * to be safe against rollback DDL embedded in the same file. Files without a
 * `-- DOWN` marker are applied in full.
 */
export async function applyMigrations(connectionString: string, migrationsDir: string): Promise<void> {
  const files = (await readdir(migrationsDir))
    .filter(f => f.endsWith('.sql'))
    .sort()

  const client = new Client({ connectionString })
  await client.connect()
  try {
    for (const file of files) {
      const sql = await readFile(join(migrationsDir, file), 'utf8')
      const downIdx = sql.indexOf('-- DOWN')
      const upSql = downIdx >= 0 ? sql.slice(0, downIdx) : sql
      await client.query(upSql)
    }
  } finally {
    await client.end()
  }
}

/**
 * Spin up Postgres + Redis testcontainers and apply migrations. Returns
 * connection info plus a teardown function.
 *
 * NOTE: lazy-imports testcontainers so unit tests that don't need Docker can
 * still run on machines without it installed.
 */
export async function setupInfra(opts: {
  migrationsDir?: string
} = {}): Promise<{
  databaseUrl: string
  redisUrl: string
  teardown: () => Promise<void>
}> {
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql')
  const { RedisContainer } = await import('@testcontainers/redis')

  const pg = await new PostgreSqlContainer('pgvector/pgvector:pg16').start()
  const redis = await new RedisContainer('redis:7-alpine').start()

  const migrationsDir = opts.migrationsDir ?? join(__dirname, '..', '..', 'migrations')
  await applyMigrations(pg.getConnectionUri(), migrationsDir)

  return {
    databaseUrl: pg.getConnectionUri(),
    redisUrl: redis.getConnectionUrl(),
    teardown: async () => {
      await Promise.all([pg.stop(), redis.stop()])
    },
  }
}

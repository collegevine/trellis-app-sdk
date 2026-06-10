import { Signer } from "@aws-sdk/rds-signer"
import { Pool } from "pg"
import {
  ENV_AWS_REGION,
  ENV_DATABASE_SCHEMA,
  ENV_DATABASE_URL,
  readEnv
} from "./env.js"

const DEFAULT_PORT = 5432

export interface DbConnection {
  host: string
  port: number
  user: string
  database: string
  ssl: false | { rejectUnauthorized: boolean }
}

// Parse the passwordless DATABASE_URL that Trellis injects. The credential is
// intentionally absent: the RDS Proxy requires IAM auth, so the password is a
// short-lived token minted per connection (see appDatabase).
export function parseDatabaseUrl(raw: string): DbConnection {
  const url = new URL(raw)
  const sslmode = url.searchParams.get("sslmode")
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : DEFAULT_PORT,
    user: decodeURIComponent(url.username),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    // `sslmode=require` means encrypt without verifying the server certificate,
    // which is what Trellis injects: the proxy is only reachable over the
    // private VPC. `disable` is honored for local development against a plain
    // Postgres.
    ssl: sslmode === "disable" ? false : { rejectUnauthorized: false }
  }
}

// Mint an RDS IAM auth token for the connection. The Signer signs locally with
// the Lambda execution role's credentials (resolved from the default provider
// chain) -- no network round-trip and no static secret. Tokens are valid for
// ~15 minutes, so this runs per new pool connection rather than once.
export function databaseAuthToken({
  conn,
  region
}: {
  conn: DbConnection
  region: string
}): Promise<string> {
  const signer = new Signer({
    hostname: conn.host,
    port: conn.port,
    username: conn.user,
    region
  })
  return signer.getAuthToken()
}

let pool: Pool | undefined

// The app's private Postgres database, reached through the Trellis RDS Proxy.
// Returns a lazily-created, process-wide connection pool that authenticates
// with a fresh IAM token on every new connection, so it survives the ~15-minute
// token lifetime and is reused across Lambda invocations on warm starts. Use it
// directly for queries (`await appDatabase().query(...)`), for transactions
// (`appDatabase().connect()`), or as the driver for an ORM.
//
// Only available to apps deployed with a database; otherwise the first call
// throws because DATABASE_URL is unset.
export function appDatabase(): Pool {
  pool ??= createPool()
  return pool
}

function createPool(): Pool {
  const conn = parseDatabaseUrl(readEnv(ENV_DATABASE_URL))
  const region = readEnv(ENV_AWS_REGION)
  const schema = readEnv(ENV_DATABASE_SCHEMA).replace(/"/g, '""')
  const pool = new Pool({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    database: conn.database,
    ssl: conn.ssl,
    // pg calls this for each new physical connection, so every connection gets
    // a fresh, unexpired token.
    password: () => databaseAuthToken({ conn, region })
  })

  // Pin every new physical connection to the app's private schema. RDS Proxy
  // rejects the libpq `options=-c search_path=` startup parameter, so we issue
  // SET instead. pg serializes queries per client, so this runs before any app
  // query handed that connection.
  pool.on("connect", (client) =>
    client.query(`SET search_path TO "${schema}"`).catch((err: unknown) => {
      console.error("Failed to set search_path on new connection", err)
    })
  )

  return pool
}

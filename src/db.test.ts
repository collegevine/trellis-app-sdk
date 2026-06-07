import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { getAuthToken, SignerMock, PoolMock } = vi.hoisted(() => ({
  getAuthToken: vi.fn(),
  SignerMock: vi.fn(),
  PoolMock: vi.fn()
}))

vi.mock("@aws-sdk/rds-signer", () => ({ Signer: SignerMock }))
vi.mock("pg", () => ({ Pool: PoolMock }))

const DATABASE_URL =
  "postgres://school_test_shire@proxy-frodo.example.com/school_test_shire?sslmode=require&options=-c%20search_path%3Dapp_abc"

beforeEach(() => {
  // A fresh module each test resets the process-wide pool singleton.
  vi.resetModules()
  getAuthToken.mockReset()
  SignerMock.mockReset().mockImplementation(() => ({ getAuthToken }))
  PoolMock.mockReset().mockImplementation(() => ({ pool: true }))
  delete process.env.DATABASE_URL
  delete process.env.AWS_REGION
})

afterEach(() => {
  delete process.env.DATABASE_URL
  delete process.env.AWS_REGION
})

async function loadDb() {
  return import("../src/db.js")
}

describe("parseDatabaseUrl", () => {
  it("parses a passwordless require URL into pg connection parts", async () => {
    const { parseDatabaseUrl } = await loadDb()

    expect(parseDatabaseUrl(DATABASE_URL)).toEqual({
      host: "proxy-frodo.example.com",
      port: 5432,
      user: "school_test_shire",
      database: "school_test_shire",
      // decoded from %20/%3D back into a libpq startup option
      options: "-c search_path=app_abc",
      ssl: { rejectUnauthorized: false }
    })
  })

  it("uses the explicit port when the URL carries one", async () => {
    const { parseDatabaseUrl } = await loadDb()
    expect(parseDatabaseUrl("postgres://u@h:6543/db?sslmode=require").port).toBe(6543)
  })

  it("disables TLS only for sslmode=disable", async () => {
    const { parseDatabaseUrl } = await loadDb()
    expect(parseDatabaseUrl("postgres://u@h/db?sslmode=disable").ssl).toBe(false)
    expect(parseDatabaseUrl("postgres://u@h/db?sslmode=require").ssl).toEqual({
      rejectUnauthorized: false
    })
  })
})

describe("databaseAuthToken", () => {
  it("signs a token for the connection host, port, user, and region", async () => {
    const { databaseAuthToken } = await loadDb()
    getAuthToken.mockResolvedValue("iam-token-xyz")

    const token = await databaseAuthToken({
      conn: {
        host: "proxy-frodo.example.com",
        port: 5432,
        user: "school_test_shire",
        database: "school_test_shire",
        ssl: { rejectUnauthorized: false }
      },
      region: "us-east-1"
    })

    expect(token).toBe("iam-token-xyz")
    expect(SignerMock).toHaveBeenCalledWith({
      hostname: "proxy-frodo.example.com",
      port: 5432,
      username: "school_test_shire",
      region: "us-east-1"
    })
  })
})

describe("appDatabase", () => {
  it("throws when DATABASE_URL is missing", async () => {
    process.env.AWS_REGION = "us-east-1"
    const { appDatabase } = await loadDb()

    expect(() => appDatabase()).toThrow(/DATABASE_URL/)
    expect(PoolMock).not.toHaveBeenCalled()
  })

  it("throws when AWS_REGION is missing", async () => {
    process.env.DATABASE_URL = DATABASE_URL
    const { appDatabase } = await loadDb()

    expect(() => appDatabase()).toThrow(/AWS_REGION/)
  })

  it("creates the pool once and reuses it across calls", async () => {
    process.env.DATABASE_URL = DATABASE_URL
    process.env.AWS_REGION = "us-east-1"
    const { appDatabase } = await loadDb()

    expect(appDatabase()).toBe(appDatabase())
    expect(PoolMock).toHaveBeenCalledOnce()
  })

  it("builds the pool from the URL and authenticates each connection with a fresh IAM token", async () => {
    process.env.DATABASE_URL = DATABASE_URL
    process.env.AWS_REGION = "us-east-1"
    getAuthToken.mockResolvedValue("iam-token-xyz")
    const { appDatabase } = await loadDb()

    appDatabase()

    const config = PoolMock.mock.calls[0]![0]
    expect(config).toMatchObject({
      host: "proxy-frodo.example.com",
      port: 5432,
      user: "school_test_shire",
      database: "school_test_shire",
      options: "-c search_path=app_abc",
      ssl: { rejectUnauthorized: false }
    })

    // pg invokes `password` per new connection; it must yield a fresh token.
    await expect(config.password()).resolves.toBe("iam-token-xyz")
    expect(SignerMock).toHaveBeenCalledWith({
      hostname: "proxy-frodo.example.com",
      port: 5432,
      username: "school_test_shire",
      region: "us-east-1"
    })
  })
})

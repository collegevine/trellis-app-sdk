export const ENV_BASE_URL = "TRELLIS_APP_API_URL"
export const ENV_SECRET = "TRELLIS_APP_API_SECRET"

export function readEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

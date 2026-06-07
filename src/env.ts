export const ENV_TRELLIS_APP_API_URL = "TRELLIS_APP_API_URL"
export const ENV_TRELLIS_APP_API_SECRET = "TRELLIS_APP_API_SECRET"
export const ENV_AUTH_MODE = "TRELLIS_APP_AUTH_MODE"
export const ENV_AUTHORIZE_URL = "TRELLIS_APP_AUTHORIZE_URL"

// Present only for database-enabled apps. DATABASE_URL is passwordless: the
// password is a short-lived IAM token minted per connection. AWS_REGION is set
// by the Lambda runtime and is needed to sign that token.
export const ENV_DATABASE_URL = "DATABASE_URL"
export const ENV_AWS_REGION = "AWS_REGION"

export const AUTH_MODE_ANONYMOUS = "anonymous"
export const AUTH_MODE_AUTHENTICATED = "authenticated"

export type AuthMode =
  | typeof AUTH_MODE_ANONYMOUS
  | typeof AUTH_MODE_AUTHENTICATED

export function readAuthMode(): AuthMode {
  const value = process.env[ENV_AUTH_MODE]
  if (value === AUTH_MODE_AUTHENTICATED) return AUTH_MODE_AUTHENTICATED
  return AUTH_MODE_ANONYMOUS
}

export function readEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

import { createHmac } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import {
  clearedCookieHeader,
  readSignedCookie,
  signedCookieHeader
} from "./cookies.js"

const KEY = process.env.TRELLIS_APP_COOKIE_SIGNING_KEY!
const PREFIX = process.env.TRELLIS_APP_COOKIE_NAME_PREFIX!

const cargo = { ship: "Millennium Falcon", parsecs: 12, crew: ["Han", "Chewie"] }

function cookiePair(name: string, value: unknown): string {
  return signedCookieHeader({ name, value, maxAgeSeconds: 60 }).split(";")[0]!
}

function requestWith(cookie: string): Request {
  return new Request("https://falcon.apps.collegevine.ai/", {
    headers: { cookie }
  })
}

function b64(value: unknown): string {
  return Buffer.from(
    typeof value === "string" ? value : JSON.stringify(value),
    "utf8"
  ).toString("base64url")
}

describe("signed cookies", () => {
  afterEach(() => {
    process.env.TRELLIS_APP_COOKIE_SIGNING_KEY = KEY
    process.env.TRELLIS_APP_COOKIE_NAME_PREFIX = PREFIX
  })

  it("round trips a value among other cookies, including one whose value holds '='", () => {
    const cookie = `theme=dark; ${cookiePair("hold", cargo)}; other=a=b`
    expect(readSignedCookie(requestWith(cookie), "hold")).toEqual(cargo)
    expect(readSignedCookie(requestWith("theme=dark"), "hold")).toBeNull()
  })

  it("sets a __Host-Http- cookie with Path=/, Secure, HttpOnly, and no Domain, and clears it the same way", () => {
    const header = signedCookieHeader({ name: "hold", value: cargo, maxAgeSeconds: 600 })
    expect(header).toMatch(new RegExp(`^__Host-Http-App-${PREFIX}-hold=[A-Za-z0-9_-]+; `))
    const attributes = header.split("; ").slice(1)
    expect(attributes).toEqual(
      expect.arrayContaining(["Path=/", "Secure", "HttpOnly", "SameSite=Lax", "Max-Age=600"])
    )
    expect(header).not.toMatch(/domain/i)
    expect(clearedCookieHeader("hold")).toBe(
      `__Host-Http-App-${PREFIX}-hold=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
    )
  })

  it("rejects an edited payload carrying the original signature", () => {
    const [name, value] = cookiePair("hold", cargo).split(/=(.*)/s) as [string, string]
    const envelope = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
    envelope.payload = JSON.stringify({ ...cargo, parsecs: 11 })
    expect(readSignedCookie(requestWith(`${name}=${b64(envelope)}`), "hold")).toBeNull()
  })

  it("rejects an unsigned base64url(JSON) cookie", () => {
    const cookie = `__Host-Http-App-${PREFIX}-hold=${b64(cargo)}`
    expect(readSignedCookie(requestWith(cookie), "hold")).toBeNull()
  })

  it("does not verify a value under a different name, key, or prefix", () => {
    const value = cookiePair("trellis_auth_state", cargo).split(/=(.*)/s)[1]
    const asSession = `__Host-Http-App-${PREFIX}-trellis_auth=${value}`
    expect(readSignedCookie(requestWith(asSession), "trellis_auth")).toBeNull()

    process.env.TRELLIS_APP_COOKIE_SIGNING_KEY = "cd".repeat(32)
    const otherKey = cookiePair("hold", cargo)
    process.env.TRELLIS_APP_COOKIE_SIGNING_KEY = KEY
    expect(readSignedCookie(requestWith(otherKey), "hold")).toBeNull()

    process.env.TRELLIS_APP_COOKIE_NAME_PREFIX = "mordor"
    const otherPrefix = cookiePair("hold", cargo).split(/=(.*)/s)[1]
    process.env.TRELLIS_APP_COOKIE_NAME_PREFIX = PREFIX
    const replanted = `__Host-Http-App-${PREFIX}-hold=${otherPrefix}`
    expect(readSignedCookie(requestWith(replanted), "hold")).toBeNull()
  })

  it("returns null for malformed values without throwing", () => {
    const fullName = `__Host-Http-App-${PREFIX}-hold`
    const payload = JSON.stringify(cargo)
    const signature = createHmac("sha256", Buffer.from(KEY, "hex"))
      .update(JSON.stringify([fullName, payload]))
      .digest()
    const malformed = [
      "!!!not-base64!!!",
      b64("not json"),
      b64("null"),
      b64({ payload: cargo, signature: signature.toString("base64url") }),
      b64({ payload, signature: 42 }),
      b64({ payload, signature: signature.subarray(0, 16).toString("base64url") }),
      b64({ payload: "{not json", signature: "x" })
    ]
    for (const value of malformed) {
      expect(readSignedCookie(requestWith(`${fullName}=${value}`), "hold")).toBeNull()
    }
    expect(
      readSignedCookie(
        requestWith(`${fullName}=${b64({ payload, signature: signature.toString("base64url") })}`),
        "hold"
      )
    ).toEqual(cargo)
  })

  it("throws on a missing or malformed key, a missing prefix, or an invalid name", () => {
    delete process.env.TRELLIS_APP_COOKIE_SIGNING_KEY
    expect(() => cookiePair("hold", cargo)).toThrow(/SIGNING_KEY/)
    expect(() => readSignedCookie(requestWith("a=b"), "hold")).toThrow(/SIGNING_KEY/)
    process.env.TRELLIS_APP_COOKIE_SIGNING_KEY = "you-shall-not-pass"
    expect(() => cookiePair("hold", cargo)).toThrow(/SIGNING_KEY/)
    process.env.TRELLIS_APP_COOKIE_SIGNING_KEY = KEY

    delete process.env.TRELLIS_APP_COOKIE_NAME_PREFIX
    expect(() => cookiePair("hold", cargo)).toThrow(/NAME_PREFIX/)
    expect(() => clearedCookieHeader("hold")).toThrow(/NAME_PREFIX/)
    process.env.TRELLIS_APP_COOKIE_NAME_PREFIX = PREFIX

    for (const name of ["", "hold; Domain=evil", "spice=melange"]) {
      expect(() => cookiePair(name, cargo)).toThrow(/Invalid cookie name/)
    }
  })
})

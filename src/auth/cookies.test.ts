import { describe, expect, it } from "vitest"
import {
  decodeCookie,
  encodeCookie,
  isSessionLive,
  userFromWire,
  type SessionCookie
} from "./cookies.js"

describe("userFromWire", () => {
  it("maps snake_case wire fields to the camelCase TrellisUser", () => {
    expect(
      userFromWire({
        name: "Leia Organa",
        email_hashes: ["abc"],
        subject_type: "constituent"
      })
    ).toEqual({
      name: "Leia Organa",
      emailHashes: ["abc"],
      subjectType: "constituent"
    })
  })

  it("defaults emailHashes to [] and subjectType to null when the wire omits them", () => {
    expect(userFromWire({ name: "Chewbacca" })).toEqual({
      name: "Chewbacca",
      emailHashes: [],
      subjectType: null
    })
  })
})

describe("encodeCookie / decodeCookie", () => {
  it("roundtrips arbitrary JSON-serializable values", () => {
    const value = {
      accessToken: "tau_speak-friend",
      expiresAt: 1779148800,
      user: { name: "Frodo Baggins" }
    }
    expect(decodeCookie(encodeCookie(value))).toEqual(value)
  })

  it("returns null for an undefined raw value", () => {
    expect(decodeCookie<unknown>(undefined)).toBeNull()
  })

  it("returns null for malformed payloads instead of throwing", () => {
    expect(decodeCookie<unknown>("not-base64-or-json")).toBeNull()
  })

  it("produces a URL-safe encoding (base64url, no padding)", () => {
    const encoded = encodeCookie({ a: 1 })
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe("isSessionLive", () => {
  const baseSession: SessionCookie = {
    accessToken: "tau_test",
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    user: { name: null, emailHashes: [], subjectType: null }
  }

  it("is false when given null", () => {
    expect(isSessionLive(null)).toBe(false)
  })

  it("is true when expiresAt is in the future", () => {
    expect(isSessionLive(baseSession)).toBe(true)
  })

  it("is false when expiresAt is in the past", () => {
    expect(
      isSessionLive({
        ...baseSession,
        expiresAt: Math.floor(Date.now() / 1000) - 1
      })
    ).toBe(false)
  })

  it("is false when expiresAt is not a finite number", () => {
    expect(
      isSessionLive({ ...baseSession, expiresAt: Number.NaN })
    ).toBe(false)
  })
})

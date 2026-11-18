import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { isE2eMockSessionAllowed } from "@/lib/auth/mock-guard";

describe("E2E Mock Session Security Guard", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns false by default when ALLOW_E2E_MOCK is undefined", () => {
    delete process.env.ALLOW_E2E_MOCK;
    expect(isE2eMockSessionAllowed("1")).toBe(false);
  });

  it("returns false when cookie value is missing or not '1'", () => {
    process.env.ALLOW_E2E_MOCK = "1";
    expect(isE2eMockSessionAllowed(undefined)).toBe(false);
    expect(isE2eMockSessionAllowed("")).toBe(false);
    expect(isE2eMockSessionAllowed("0")).toBe(false);
    expect(isE2eMockSessionAllowed("true")).toBe(false);
  });

  it("returns true only when ALLOW_E2E_MOCK is explicitly '1' and cookie is '1'", () => {
    process.env.ALLOW_E2E_MOCK = "1";
    expect(isE2eMockSessionAllowed("1")).toBe(true);
  });

  it("strictly denies mock auth if VERCEL_ENV is 'production' even if ALLOW_E2E_MOCK is '1'", () => {
    process.env.ALLOW_E2E_MOCK = "1";
    process.env.VERCEL_ENV = "production";
    expect(isE2eMockSessionAllowed("1")).toBe(false);
  });

  it("strictly denies mock auth if NEXT_PUBLIC_VERCEL_ENV is 'production'", () => {
    process.env.ALLOW_E2E_MOCK = "1";
    process.env.NEXT_PUBLIC_VERCEL_ENV = "production";
    expect(isE2eMockSessionAllowed("1")).toBe(false);
  });

  it("strictly denies mock auth in standard production when ALLOW_E2E_MOCK is omitted", () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    delete process.env.ALLOW_E2E_MOCK;
    expect(isE2eMockSessionAllowed("1")).toBe(false);
  });

  it("strictly ignores spoofed cookie values like 'admin', 'true', or customer UUIDs", () => {
    process.env.ALLOW_E2E_MOCK = "1";
    expect(isE2eMockSessionAllowed("admin")).toBe(false);
    expect(isE2eMockSessionAllowed("root")).toBe(false);
    expect(isE2eMockSessionAllowed("00000000-0000-0000-0000-000000000000")).toBe(false);
  });
});



import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

const mockRequireRole = vi.fn();
const mockIsSupabaseAuthConfigured = vi.fn(() => true);
const mockIsServiceRoleConfigured = vi.fn(() => true);
const mockCreateServerClientInstance = vi.fn(async () => ({}));
const mockCheckRateLimit = vi.fn((_k: string, _m: number, _w: number) => ({ allowed: true, resetMs: 60000 }));
const mockDecryptPin = vi.fn((_payload: unknown, _opts?: unknown) => "2580*");

let mockDbState: {
  profile: any;
  restroom: any;
  business: any;
  adminRole: any;
  membership: any;
  secret: any;
  auditInserts: any[];
  revealAuditInserts: any[];
};

const mockCreateAdminClient = vi.fn(() => ({
  from: (table: string) => {
    if (table === "audit_logs") {
      return {
        insert: async (payload: any) => {
          mockDbState.auditInserts.push(payload);
          return { error: null };
        },
      };
    }
    if (table === "pin_reveal_audits") {
      return {
        insert: async (payload: any) => {
          mockDbState.revealAuditInserts.push(payload);
          return { error: null };
        },
      };
    }

    const queryBuilder: any = {
      select: () => queryBuilder,
      eq: () => queryBuilder,
      maybeSingle: async () => {
        if (table === "profiles") return { data: mockDbState.profile, error: null };
        if (table === "restrooms") return { data: mockDbState.restroom, error: null };
        if (table === "businesses") return { data: mockDbState.business, error: null };
        if (table === "user_roles") return { data: mockDbState.adminRole, error: null };
        if (table === "business_members") return { data: mockDbState.membership, error: null };
        if (table === "restroom_lock_secrets") return { data: mockDbState.secret, error: null };
        return { data: null, error: null };
      },
    };
    return queryBuilder;
  },
}));

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    requireRole: (...args: [unknown, unknown]) => mockRequireRole(...args),
    isSupabaseAuthConfigured: () => mockIsSupabaseAuthConfigured(),
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createServerClientInstance: () => mockCreateServerClientInstance(),
  createAdminClient: () => mockCreateAdminClient(),
  isServiceRoleConfigured: () => mockIsServiceRoleConfigured(),
}));

vi.mock("@/lib/events/rate-limiter", () => ({
  checkRateLimit: (...args: [string, number, number]) => mockCheckRateLimit(...args),
}));

vi.mock("@/lib/access/crypto/crypto", async () => {
  const actual = await vi.importActual<typeof import("@/lib/access/crypto/crypto")>(
    "@/lib/access/crypto/crypto"
  );
  return {
    ...actual,
    decryptPin: (...args: [unknown, unknown]) => mockDecryptPin(...args),
  };
});

import { AuthGuardError } from "@/lib/auth";
import { GET as getMerchantPinHandler } from "@/app/api/v1/merchant/restrooms/[id]/pin/route";

const RESTROOM_ID = "11111111-1111-4111-8111-111111111111";
const BUSINESS_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";

describe("FIX-03 B — Merchant PIN View API Security & Audit Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSupabaseAuthConfigured.mockReturnValue(true);
    mockIsServiceRoleConfigured.mockReturnValue(true);
    mockCheckRateLimit.mockReturnValue({ allowed: true, resetMs: 60000 });
    mockDecryptPin.mockReturnValue("2580*");
    mockRequireRole.mockResolvedValue({
      user: { id: USER_ID, email: "owner@example.com" },
    });

    mockDbState = {
      profile: { id: USER_ID, account_status: "active" },
      restroom: {
        id: RESTROOM_ID,
        business_id: BUSINESS_ID,
        type: "partner",
        access_method: "pin",
      },
      business: {
        id: BUSINESS_ID,
        registration_status: "approved",
      },
      adminRole: null,
      membership: { role: "owner", membership_status: "active" },
      secret: {
        id: crypto.randomUUID(),
        ciphertext_b64: "mockCipher==",
        iv_b64: "mockIv==",
        auth_tag_b64: "mockTag==",
        key_version: 1,
        code_version: 2,
        valid_from: "2026-11-21T00:00:00.000Z",
      },
      auditInserts: [],
      revealAuditInserts: [],
    };
  });

  it("rejects unauthenticated guest (401) and non-merchant customer (403) with no-store headers", async () => {
    mockRequireRole.mockRejectedValueOnce(
      new AuthGuardError("UNAUTHORIZED", 401, "로그인이 필요합니다.")
    );
    const guestRes = await getMerchantPinHandler(
      new Request(`http://localhost/api/v1/merchant/restrooms/${RESTROOM_ID}/pin`),
      { params: Promise.resolve({ id: RESTROOM_ID }) }
    );
    expect(guestRes.status).toBe(401);
    expect(guestRes.headers.get("cache-control")).toContain("no-store");

    mockRequireRole.mockRejectedValueOnce(
      new AuthGuardError("FORBIDDEN", 403, "접근 권한이 없습니다.")
    );
    const custRes = await getMerchantPinHandler(
      new Request(`http://localhost/api/v1/merchant/restrooms/${RESTROOM_ID}/pin`),
      { params: Promise.resolve({ id: RESTROOM_ID }) }
    );
    expect(custRes.status).toBe(403);
    expect(custRes.headers.get("cache-control")).toContain("no-store");
  });

  it("blocks another merchant without active membership and records denied audit", async () => {
    mockDbState.membership = null;

    const res = await getMerchantPinHandler(
      new Request(`http://localhost/api/v1/merchant/restrooms/${RESTROOM_ID}/pin`),
      { params: Promise.resolve({ id: RESTROOM_ID }) }
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("MEMBERSHIP_REQUIRED");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(mockDecryptPin).not.toHaveBeenCalled();
    expect(mockDbState.auditInserts).toHaveLength(1);
    expect(mockDbState.auditInserts[0].action).toBe("merchant_pin_view_denied");
    expect(JSON.stringify(mockDbState.auditInserts)).not.toContain("2580*");
  });

  it("blocks unapproved business and public restrooms", async () => {
    mockDbState.business.registration_status = "pending";
    const unapprovedRes = await getMerchantPinHandler(
      new Request(`http://localhost/api/v1/merchant/restrooms/${RESTROOM_ID}/pin`),
      { params: Promise.resolve({ id: RESTROOM_ID }) }
    );
    expect(unapprovedRes.status).toBe(403);

    mockDbState.business.registration_status = "approved";
    mockDbState.restroom.type = "public";
    const publicRes = await getMerchantPinHandler(
      new Request(`http://localhost/api/v1/merchant/restrooms/${RESTROOM_ID}/pin`),
      { params: Promise.resolve({ id: RESTROOM_ID }) }
    );
    expect(publicRes.status).toBe(403);
    expect(mockDecryptPin).not.toHaveBeenCalled();
  });

  it("enforces rate limits (429 Too Many Requests) with Retry-After", async () => {
    mockCheckRateLimit.mockReturnValueOnce({ allowed: false, resetMs: 25_000 });

    const res = await getMerchantPinHandler(
      new Request(`http://localhost/api/v1/merchant/restrooms/${RESTROOM_ID}/pin`),
      { params: Promise.resolve({ id: RESTROOM_ID }) }
    );
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.error.code).toBe("TOO_MANY_REQUESTS");
    expect(res.headers.get("retry-after")).toBe("25");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("returns decrypted PIN with no-store headers for active approved owner without exposing secrets in audits", async () => {
    const res = await getMerchantPinHandler(
      new Request(`http://localhost/api/v1/merchant/restrooms/${RESTROOM_ID}/pin`),
      { params: Promise.resolve({ id: RESTROOM_ID }) }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(
      "private, no-store, no-cache, must-revalidate"
    );
    expect(body.ok).toBe(true);
    expect(body.pin).toBe("2580*");
    expect(body.codeVersion).toBe(2);
    expect(body).not.toHaveProperty("ciphertext_b64");
    expect(body).not.toHaveProperty("auth_tag_b64");
    expect(mockDbState.auditInserts).toHaveLength(1);
    expect(mockDbState.auditInserts[0].action).toBe("merchant_pin_view");
    expect(mockDbState.revealAuditInserts).toHaveLength(1);
    expect(mockDbState.revealAuditInserts[0].result).toBe("success");
    expect(JSON.stringify(mockDbState.auditInserts)).not.toContain("2580*");
    expect(JSON.stringify(mockDbState.revealAuditInserts)).not.toContain("2580*");
  });
});

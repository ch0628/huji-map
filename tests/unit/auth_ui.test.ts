import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Database, UserRoleType } from "@/lib/db/types";
import {
  AuthGuardError,
  checkIdempotencyKey,
  clearIdempotencyStoreForTests,
  evaluateRouteAccess,
  getServerAuthSession,
  isSupabaseAuthConfigured,
  loginSchema,
  redactAuthSensitiveText,
  requireAuth,
  requireBusinessMember,
  requireRole,
  resetQaAuthVerificationSummaryForTests,
  sanitizeReturnTo,
  signupSchema,
} from "@/lib/auth";
import { POST as loginPost } from "@/app/api/v1/auth/login/route";
import { POST as signupPost } from "@/app/api/v1/auth/signup/route";
import { POST as logoutPost } from "@/app/api/v1/auth/logout/route";
import { GET as sessionGet } from "@/app/api/v1/auth/session/route";
import { GET as guardGet } from "@/app/api/v1/auth/guard/route";

function createMockSupabaseClient(options: {
  user?: Partial<User> | null;
  authError?: { message?: string; code?: string } | null;
  roles?: UserRoleType[];
  profile?: { display_name: string | null; account_status: "active" | "suspended" | "deleted" } | null;
  businessMembership?: { role: string; status: string } | null;
}) {
  const mockUser: User | null = options.user
    ? ({
        id: options.user.id ?? "11111111-1111-4111-8111-111111111111",
        email: options.user.email ?? "user@example.test",
        app_metadata: {},
        user_metadata: options.user.user_metadata ?? { display_name: "테스트유저" },
        aud: "authenticated",
        created_at: new Date().toISOString(),
      } as User)
    : null;

  const client = {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: mockUser },
        error: options.authError ?? null,
      }),
    },
    from: vi.fn((table: string) => {
      if (table === "user_roles") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn().mockResolvedValue({
              data: (options.roles ?? []).map((role) => ({ role })),
              error: null,
            }),
          })),
        };
      }
      if (table === "profiles") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn().mockResolvedValue({
                data:
                  options.profile ??
                  (mockUser
                    ? { display_name: "테스트유저", account_status: "active" }
                    : null),
                error: null,
              }),
            })),
          })),
        };
      }
      if (table === "business_members") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: options.businessMembership ?? null,
                    error: null,
                  }),
                })),
              })),
            })),
          })),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    }),
  };

  return client as unknown as SupabaseClient<Database>;
}

describe("TASK 04: Auth Validation, Route Policy, Server Guards, and API Safety", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    clearIdempotencyStoreForTests();
    resetQaAuthVerificationSummaryForTests();
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_key_only",
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe("1. Guest map access & protected route policy (evaluateRouteAccess)", () => {
    it("allows guest (unauthenticated) access to /map, /, /restrooms/[id], /login, /signup", () => {
      const guestSession = { user: null, roles: [] as UserRoleType[], sessionExpired: false };

      expect(evaluateRouteAccess("/map", guestSession)).toEqual({
        allowed: true,
        status: 200,
      });
      expect(evaluateRouteAccess("/", guestSession)).toEqual({
        allowed: true,
        status: 200,
      });
      expect(evaluateRouteAccess("/restrooms/demo-1", guestSession)).toEqual({
        allowed: true,
        status: 200,
      });
      expect(evaluateRouteAccess("/login", guestSession)).toEqual({
        allowed: true,
        status: 200,
      });
      expect(evaluateRouteAccess("/signup", guestSession)).toEqual({
        allowed: true,
        status: 200,
      });
    });

    it("blocks guest access to /merchant/* and /admin/* with 401 and preserves returnTo & reason", () => {
      const guestSession = { user: null, roles: [] as UserRoleType[], sessionExpired: false };

      const merchantResult = evaluateRouteAccess("/merchant/businesses", guestSession);
      expect(merchantResult.allowed).toBe(false);
      expect(merchantResult.status).toBe(401);
      expect(merchantResult.redirectTo).toBe(
        "/login?returnTo=%2Fmerchant%2Fbusinesses&reason=login_required"
      );

      const expiredSession = { user: null, roles: [] as UserRoleType[], sessionExpired: true };
      const adminResult = evaluateRouteAccess("/admin/receipts", expiredSession);
      expect(adminResult.allowed).toBe(false);
      expect(adminResult.status).toBe(401);
      expect(adminResult.redirectTo).toBe(
        "/login?returnTo=%2Fadmin%2Freceipts&reason=session_expired"
      );
    });

    it("blocks customer from /merchant/* (except /merchant/businesses) and /admin/* with 403, and allows /merchant/businesses for customer", () => {
      const fakeUser = { id: "u-1" } as User;

      // 일반 회원도 가게 등록 신청 및 본인 신청 관리(/merchant/businesses) 접근 가능
      const customerOnBusinessRegistration = evaluateRouteAccess("/merchant/businesses", {
        user: fakeUser,
        roles: ["customer"],
        sessionExpired: false,
      });
      expect(customerOnBusinessRegistration).toEqual({
        allowed: true,
        status: 200,
      });

      const customerOnMerchant = evaluateRouteAccess("/merchant/restrooms", {
        user: fakeUser,
        roles: ["customer"],
        sessionExpired: false,
      });
      expect(customerOnMerchant).toEqual({
        allowed: false,
        status: 403,
        reason: "forbidden",
      });

      const merchantOnMerchant = evaluateRouteAccess("/merchant/restrooms", {
        user: fakeUser,
        roles: ["customer", "merchant"],
        sessionExpired: false,
      });
      expect(merchantOnMerchant).toEqual({
        allowed: true,
        status: 200,
      });

      const merchantOnAdmin = evaluateRouteAccess("/admin/businesses", {
        user: fakeUser,
        roles: ["customer", "merchant"],
        sessionExpired: false,
      });
      expect(merchantOnAdmin).toEqual({
        allowed: false,
        status: 403,
        reason: "forbidden",
      });

      const adminOnAdmin = evaluateRouteAccess("/admin/businesses", {
        user: fakeUser,
        roles: ["customer", "admin"],
        sessionExpired: false,
      });
      expect(adminOnAdmin).toEqual({
        allowed: true,
        status: 200,
      });
    });
  });

  describe("2. Server getUser helper & role/business guards (requireAuth, requireRole, requireBusinessMember)", () => {
    it("fails safely with 503 CONFIG_REQUIRED when Supabase env vars are missing", async () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

      expect(isSupabaseAuthConfigured()).toBe(false);

      const session = await getServerAuthSession();
      expect(session.configReady).toBe(false);
      expect(session.user).toBeNull();

      await expect(requireAuth()).rejects.toMatchObject({
        code: "CONFIG_REQUIRED",
        status: 503,
      });
    });

    it("detects expired sessions via server getUser() and throws 401 SESSION_EXPIRED", async () => {
      const mockClient = createMockSupabaseClient({
        user: null,
        authError: { message: "JWT expired", code: "session_expired" },
      });

      const session = await getServerAuthSession(mockClient);
      expect(session.user).toBeNull();
      expect(session.sessionExpired).toBe(true);

      await expect(requireAuth(mockClient)).rejects.toMatchObject({
        code: "SESSION_EXPIRED",
        status: 401,
      });
    });

    it("blocks suspended accounts with 403 ACCOUNT_SUSPENDED", async () => {
      const mockClient = createMockSupabaseClient({
        user: { id: "u-suspended" },
        roles: ["customer"],
        profile: { display_name: "정지계정", account_status: "suspended" },
      });

      await expect(requireAuth(mockClient)).rejects.toMatchObject({
        code: "ACCOUNT_SUSPENDED",
        status: 403,
      });
    });

    it("enforces requireRole for merchant and admin", async () => {
      const customerClient = createMockSupabaseClient({
        user: { id: "u-cust" },
        roles: ["customer"],
      });

      await expect(requireRole("merchant", customerClient)).rejects.toMatchObject({
        code: "FORBIDDEN",
        status: 403,
      });
      await expect(requireRole("admin", customerClient)).rejects.toMatchObject({
        code: "FORBIDDEN",
        status: 403,
      });

      const merchantClient = createMockSupabaseClient({
        user: { id: "u-merch" },
        roles: ["customer", "merchant"],
      });

      const merchSession = await requireRole("merchant", merchantClient);
      expect(merchSession.isMerchant).toBe(true);

      await expect(requireRole("admin", merchantClient)).rejects.toMatchObject({
        code: "FORBIDDEN",
        status: 403,
      });

      const adminClient = createMockSupabaseClient({
        user: { id: "u-admin" },
        roles: ["customer", "admin"],
      });

      const adminSession = await requireRole("admin", adminClient);
      expect(adminSession.isAdmin).toBe(true);
    });

    it("enforces requireBusinessMember against non-members and allows active owner/manager or admin", async () => {
      const nonMemberMerchantClient = createMockSupabaseClient({
        user: { id: "u-merch-other" },
        roles: ["customer", "merchant"],
        businessMembership: null,
      });

      await expect(
        requireBusinessMember("biz-100", nonMemberMerchantClient)
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        status: 403,
      });

      const ownerMerchantClient = createMockSupabaseClient({
        user: { id: "u-merch-owner" },
        roles: ["customer", "merchant"],
        businessMembership: { role: "owner", status: "active" },
      });

      const verifiedOwner = await requireBusinessMember("biz-100", ownerMerchantClient);
      expect(verifiedOwner.businessId).toBe("biz-100");
      expect(verifiedOwner.memberRole).toBe("owner");

      // Manager blocked when only owner is allowed
      const managerMerchantClient = createMockSupabaseClient({
        user: { id: "u-merch-mgr" },
        roles: ["customer", "merchant"],
        businessMembership: { role: "manager", status: "active" },
      });

      await expect(
        requireBusinessMember("biz-100", managerMerchantClient, {
          allowedMemberRoles: ["owner"],
        })
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        status: 403,
      });

      // Admin bypasses business_members check
      const adminClient = createMockSupabaseClient({
        user: { id: "u-admin" },
        roles: ["admin"],
      });
      const verifiedAdmin = await requireBusinessMember("biz-100", adminClient);
      expect(verifiedAdmin.memberRole).toBe("admin");
    });
  });

  describe("3. Input validation, open-redirect defense, idempotency, and PII redaction", () => {
    it("validates email and password constraints in Korean", () => {
      expect(loginSchema.safeParse({ email: "bad-email", password: "123" }).success).toBe(
        false
      );
      expect(
        signupSchema.safeParse({
          email: "valid@example.com",
          password: "password123",
          termsAccepted: false,
        }).success
      ).toBe(false);
      expect(
        signupSchema.safeParse({
          email: "valid@example.com",
          password: "password123",
          displayName: "홍길동",
          termsAccepted: true,
        }).success
      ).toBe(true);
    });

    it("sanitizes returnTo against external or protocol-relative URLs", () => {
      expect(sanitizeReturnTo(undefined)).toBe("/map");
      expect(sanitizeReturnTo("https://evil.example.com")).toBe("/map");
      expect(sanitizeReturnTo("//evil.example.com")).toBe("/map");
      expect(sanitizeReturnTo("/\\evil.example.com")).toBe("/map");
      expect(sanitizeReturnTo("/payment/start?restroomId=123")).toBe(
        "/payment/start?restroomId=123"
      );
    });

    it("redacts emails, tokens, passwords, and Supabase keys from strings", () => {
      const raw =
        "Error for user alice.test@example.co.kr with password=mySecretPass123 and key sb_secret_123456789";
      const sanitized = redactAuthSensitiveText(raw);
      expect(sanitized).not.toContain("alice.test@example.co.kr");
      expect(sanitized).not.toContain("mySecretPass123");
      expect(sanitized).not.toContain("sb_secret_123456789");
      expect(sanitized).toContain("[REDACTED_EMAIL]");
      expect(sanitized).toContain("[REDACTED_KEY]");
    });

    it("blocks duplicate write requests with the same idempotency key", () => {
      expect(checkIdempotencyKey("key-1", "auth:login").isDuplicate).toBe(false);
      expect(checkIdempotencyKey("key-1", "auth:login").isDuplicate).toBe(true);
      expect(checkIdempotencyKey("key-1", "auth:signup").isDuplicate).toBe(false);
    });
  });

  describe("4. Auth API routes: safe missing-key failure & zero credential logging", () => {
    it("returns 503 CONFIG_REQUIRED on /login, /signup, /logout, /session when keys are missing", async () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

      const loginRes = await loginPost(
        new Request("http://localhost/api/v1/auth/login", {
          method: "POST",
          body: JSON.stringify({ email: "a@b.com", password: "password123" }),
        })
      );
      expect(loginRes.status).toBe(503);

      const signupRes = await signupPost(
        new Request("http://localhost/api/v1/auth/signup", {
          method: "POST",
          body: JSON.stringify({
            email: "a@b.com",
            password: "password123",
            termsAccepted: true,
          }),
        })
      );
      expect(signupRes.status).toBe(503);

      const logoutRes = await logoutPost(
        new Request("http://localhost/api/v1/auth/logout", { method: "POST" })
      );
      expect(logoutRes.status).toBe(503);

      const sessionRes = await sessionGet();
      expect(sessionRes.status).toBe(503);

      const guardRes = await guardGet(
        new Request("http://localhost/api/v1/auth/guard?path=/merchant/businesses")
      );
      expect(guardRes.status).toBe(503);
    });

    it("never logs email or password on validation or auth errors", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const sensitiveEmail = "secret.person@example.org";
      const sensitivePassword = "UltraSecretPassword!999";

      const res = await loginPost(
        new Request("http://localhost/api/v1/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: sensitiveEmail,
            password: "short",
          }),
        })
      );

      expect(res.status).toBe(400);
      const bodyText = JSON.stringify(await res.json());
      expect(bodyText).not.toContain(sensitiveEmail);
      expect(bodyText).not.toContain(sensitivePassword);

      const allLoggedOutput = [
        ...logSpy.mock.calls.flat(),
        ...errorSpy.mock.calls.flat(),
        ...warnSpy.mock.calls.flat(),
      ]
        .map((x) => String(x))
        .join(" ");

      expect(allLoggedOutput).not.toContain(sensitiveEmail);
      expect(allLoggedOutput).not.toContain(sensitivePassword);
    });
  });
});


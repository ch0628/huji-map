import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthGuardError } from "@/lib/auth/guards";

const mockRequireRole = vi.fn();
const mockIsSupabaseAuthConfigured = vi.fn(() => true);
const mockCreateServerClientInstance = vi.fn();
const mockCreateAdminClient = vi.fn();
const mockIsServiceRoleConfigured = vi.fn(() => true);
const mockGetBusinessDetailForAdmin = vi.fn();

vi.mock("@/lib/auth", () => ({
  AuthGuardError,
  isSupabaseAuthConfigured: () => mockIsSupabaseAuthConfigured(),
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClientInstance: (...args: unknown[]) =>
    mockCreateServerClientInstance(...args),
  createAdminClient: (...args: unknown[]) => mockCreateAdminClient(...args),
  isServiceRoleConfigured: () => mockIsServiceRoleConfigured(),
}));

vi.mock("@/lib/businesses", () => ({
  getBusinessDetailForAdmin: (...args: unknown[]) =>
    mockGetBusinessDetailForAdmin(...args),
}));

import { GET } from "@/app/api/v1/admin/businesses/[id]/route";

describe("GET /api/v1/admin/businesses/[id] Error Handling Regression", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSupabaseAuthConfigured.mockReturnValue(true);
    mockIsServiceRoleConfigured.mockReturnValue(true);
    mockCreateServerClientInstance.mockResolvedValue({ kind: "ssr" });
    mockCreateAdminClient.mockReturnValue({ kind: "admin" });
    mockRequireRole.mockResolvedValue({ user: { id: "admin-1" }, isAdmin: true });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("returns 404 NOT_FOUND when the business does not exist", async () => {
    mockGetBusinessDetailForAdmin.mockRejectedValue(
      new AuthGuardError(
        "NOT_FOUND",
        404,
        "가게 정보를 찾을 수 없습니다.",
        "BUSINESS_NOT_FOUND"
      )
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await GET(new Request("http://localhost/api/v1/admin/businesses/biz-missing"), {
      params: Promise.resolve({ id: "biz-missing" }),
    });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(json.error.message).toBe("가게 정보를 찾을 수 없습니다.");
    expect(typeof json.requestId).toBe("string");
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("returns 500 INTERNAL_ERROR on Supabase auth/DB failure and logs only requestId and safe code", async () => {
    mockGetBusinessDetailForAdmin.mockRejectedValue(
      new AuthGuardError(
        "INTERNAL_ERROR",
        500,
        "서버 데이터베이스 인증 또는 연결 오류가 발생했습니다.",
        "SUPABASE_AUTH_ERROR"
      )
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await GET(
      new Request("http://localhost/api/v1/admin/businesses/07829533-f843-41d9-b6dd-0c2a9d2dcc17"),
      {
        params: Promise.resolve({
          id: "07829533-f843-41d9-b6dd-0c2a9d2dcc17",
        }),
      }
    );
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("INTERNAL_ERROR");
    expect(json.error.message).not.toContain("찾을 수 없습니다");
    expect(json.error.message).not.toContain("sb_secret_");
    expect(errSpy).toHaveBeenCalledTimes(1);
    const logLine = errSpy.mock.calls[0].join(" ");
    expect(logLine).toContain(`requestId=${json.requestId}`);
    expect(logLine).toContain("code=SUPABASE_AUTH_ERROR");
    expect(logLine).not.toContain("sb_secret_");
  });

  it("logs requestId and UNEXPECTED_ERROR on unhandled exceptions without leaking raw details", async () => {
    mockGetBusinessDetailForAdmin.mockRejectedValue(
      new Error("raw postgres secret_token_xyz")
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await GET(new Request("http://localhost/api/v1/admin/businesses/biz-1"), {
      params: Promise.resolve({ id: "biz-1" }),
    });
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("INTERNAL_ERROR");
    expect(json.error.message).toBe("가게 상세 조회 중 오류가 발생했습니다.");
    expect(errSpy).toHaveBeenCalledTimes(1);
    const logLine = errSpy.mock.calls[0].join(" ");
    expect(logLine).toContain(`requestId=${json.requestId}`);
    expect(logLine).toContain("code=UNEXPECTED_ERROR");
    expect(logLine).not.toContain("secret_token_xyz");
  });
});

describe("Supabase server helper whitespace trimming", () => {
  it("trims trailing newlines from SUPABASE_SECRET_KEY in isServiceRoleConfigured and createAdminClient", async () => {
    const serverMod = await vi.importActual<typeof import("@/lib/supabase/server")>(
      "@/lib/supabase/server"
    );

    const prevUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const prevKey = process.env.SUPABASE_SECRET_KEY;
    try {
      process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co\n";
      process.env.SUPABASE_SECRET_KEY = "   \n";
      expect(serverMod.isServiceRoleConfigured()).toBe(false);

      process.env.SUPABASE_SECRET_KEY = "sb_secret_trimmed_test_key\n";
      expect(serverMod.isServiceRoleConfigured()).toBe(true);
      const client = serverMod.createAdminClient() as unknown as {
        supabaseUrl?: string;
        supabaseKey?: string;
      };
      expect(client.supabaseUrl).toBe("https://example.supabase.co");
      expect(client.supabaseKey).toBe("sb_secret_trimmed_test_key");
    } finally {
      process.env.NEXT_PUBLIC_SUPABASE_URL = prevUrl;
      process.env.SUPABASE_SECRET_KEY = prevKey;
    }
  });
});

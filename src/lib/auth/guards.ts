import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { AccountStatus, Database, UserRoleType } from "@/lib/db/types";
import { getVerifiedAuthContext } from "@/lib/supabase/auth";
import { createServerClientInstance } from "@/lib/supabase/server";

export type AuthErrorCode =
  | "CONFIG_REQUIRED"
  | "UNAUTHORIZED"
  | "SESSION_EXPIRED"
  | "FORBIDDEN"
  | "ACCOUNT_SUSPENDED"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

export class AuthGuardError extends Error {
  public readonly code: AuthErrorCode;
  public readonly status: number;
  public readonly userMessage: string;
  public readonly safeReasonCode?: string;

  constructor(
    code: AuthErrorCode,
    status: number,
    userMessage: string,
    safeReasonCode?: string
  ) {
    super(userMessage);
    this.name = "AuthGuardError";
    this.code = code;
    this.status = status;
    this.userMessage = userMessage;
    this.safeReasonCode = safeReasonCode;
  }
}

export interface ServerAuthSession {
  user: User | null;
  roles: UserRoleType[];
  isAdmin: boolean;
  isMerchant: boolean;
  displayName: string | null;
  accountStatus: AccountStatus;
  profileExists: boolean;
  sessionExpired: boolean;
  configReady: boolean;
}

export interface VerifiedAuthSession extends ServerAuthSession {
  user: User;
}

export interface VerifiedBusinessMemberSession extends VerifiedAuthSession {
  businessId: string;
  memberRole: "owner" | "manager" | "admin";
}

export interface QaAuthVerificationSummary {
  signupSucceededCount: number;
  lastSignupRequiresEmailVerification: boolean | null;
  lastUserId: string | null;
  loginSucceeded: boolean;
  sessionVerificationCount: number;
  sessionRestoredOnRefresh: boolean;
  profileExists: boolean;
  accountStatus: AccountStatus | null;
  roles: UserRoleType[];
  isAdmin: boolean;
  isMerchant: boolean;
  unauthorizedMerchantBlocked403: boolean;
  unauthorizedAdminBlocked403: boolean;
  unauthorizedBusinessBlocked403: boolean;
  logoutSucceeded: boolean;
  postLogoutBlocked401: boolean;
  updatedAt: string | null;
}

const initialQaSummary: QaAuthVerificationSummary = {
  signupSucceededCount: 0,
  lastSignupRequiresEmailVerification: null,
  lastUserId: null,
  loginSucceeded: false,
  sessionVerificationCount: 0,
  sessionRestoredOnRefresh: false,
  profileExists: false,
  accountStatus: null,
  roles: [],
  isAdmin: false,
  isMerchant: false,
  unauthorizedMerchantBlocked403: false,
  unauthorizedAdminBlocked403: false,
  unauthorizedBusinessBlocked403: false,
  logoutSucceeded: false,
  postLogoutBlocked401: false,
  updatedAt: null,
};

const globalForQa = globalThis as unknown as {
  __hujimapQaAuthSummary?: QaAuthVerificationSummary;
};

function getMutableQaSummary(): QaAuthVerificationSummary {
  if (!globalForQa.__hujimapQaAuthSummary) {
    globalForQa.__hujimapQaAuthSummary = { ...initialQaSummary };
  }
  return globalForQa.__hujimapQaAuthSummary;
}

export type QaAuthEvent =
  | {
      type: "signup_success";
      userId: string;
      requiresEmailVerification: boolean;
    }
  | {
      type: "login_success";
      userId: string;
      roles: UserRoleType[];
    }
  | {
      type: "session_verified";
      userId: string;
      profileExists: boolean;
      accountStatus: AccountStatus;
      roles: UserRoleType[];
      isAdmin: boolean;
      isMerchant: boolean;
    }
  | { type: "merchant_guard_403" }
  | { type: "admin_guard_403" }
  | { type: "business_guard_403" }
  | { type: "logout_success" }
  | { type: "post_logout_guard_401" };

/**
 * Records non-sensitive QA verification milestones in memory.
 * Strictly excludes emails, passwords, tokens, and verification codes.
 */
export function recordQaAuthEvent(event: QaAuthEvent): void {
  const state = getMutableQaSummary();
  state.updatedAt = new Date().toISOString();

  switch (event.type) {
    case "signup_success":
      state.signupSucceededCount += 1;
      state.lastUserId = event.userId;
      state.lastSignupRequiresEmailVerification = event.requiresEmailVerification;
      break;
    case "login_success":
      state.loginSucceeded = true;
      state.lastUserId = event.userId;
      if (event.roles.length > 0) {
        state.roles = [...event.roles];
      }
      break;
    case "session_verified":
      state.loginSucceeded = true;
      state.lastUserId = event.userId;
      state.sessionVerificationCount += 1;
      if (state.sessionVerificationCount >= 2) {
        state.sessionRestoredOnRefresh = true;
      }
      state.profileExists = event.profileExists;
      state.accountStatus = event.accountStatus;
      state.roles = [...event.roles];
      state.isAdmin = event.isAdmin;
      state.isMerchant = event.isMerchant;
      break;
    case "merchant_guard_403":
      state.unauthorizedMerchantBlocked403 = true;
      break;
    case "admin_guard_403":
      state.unauthorizedAdminBlocked403 = true;
      break;
    case "business_guard_403":
      state.unauthorizedBusinessBlocked403 = true;
      break;
    case "logout_success":
      state.logoutSucceeded = true;
      break;
    case "post_logout_guard_401":
      if (state.logoutSucceeded) {
        state.postLogoutBlocked401 = true;
      }
      break;
  }
}

export function getQaAuthVerificationSummary(): QaAuthVerificationSummary {
  const state = getMutableQaSummary();
  return {
    ...state,
    roles: [...state.roles],
  };
}

export function resetQaAuthVerificationSummaryForTests(): void {
  globalForQa.__hujimapQaAuthSummary = { ...initialQaSummary };
}

/**
 * Checks whether required Supabase Auth environment variables are present.
 * AGENTS.md Rule 12: Never invent keys; safely block if missing.
 */
export function isSupabaseAuthConfigured(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return Boolean(url && key && url.trim().length > 0 && key.trim().length > 0);
}

function isSessionExpiredError(error: { message?: string; code?: string } | null): boolean {
  if (!error) return false;
  const msg = (error.message || "").toLowerCase();
  const code = (error.code || "").toLowerCase();
  return (
    msg.includes("expired") ||
    msg.includes("session_not_found") ||
    msg.includes("refresh_token_not_found") ||
    msg.includes("invalid claim: missing sub") ||
    code === "session_expired" ||
    code === "session_not_found" ||
    code === "refresh_token_not_found"
  );
}

/**
 * Server getUser authentication helper.
 * AGENTS.md Rule 7 & docs/08_SECURITY_OPERATIONS.md:
 * Authoritatively checks Supabase Auth `getUser()` on the server; never trusts client-supplied roles or raw JWT display.
 */
export async function getServerAuthSession(
  injectedClient?: SupabaseClient<Database>
): Promise<ServerAuthSession> {
  if (!injectedClient && !isSupabaseAuthConfigured()) {
    return {
      user: null,
      roles: [],
      isAdmin: false,
      isMerchant: false,
      displayName: null,
      accountStatus: "active",
      profileExists: false,
      sessionExpired: false,
      configReady: false,
    };
  }

  const supabase = injectedClient ?? (await createServerClientInstance());
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData?.user) {
    return {
      user: null,
      roles: [],
      isAdmin: false,
      isMerchant: false,
      displayName: null,
      accountStatus: "active",
      profileExists: false,
      sessionExpired: isSessionExpiredError(authError),
      configReady: true,
    };
  }

  const authContext = await getVerifiedAuthContext(supabase);
  const user = authContext.user ?? authData.user;

  let displayName: string | null =
    typeof user.user_metadata?.display_name === "string"
      ? user.user_metadata.display_name
      : null;
  let accountStatus: AccountStatus = "active";
  let profileExists = false;

  const { data: profileData } = await supabase
    .from("profiles")
    .select("display_name, account_status")
    .eq("id", user.id)
    .maybeSingle();

  if (profileData) {
    profileExists = true;
    const typedProfile = profileData as {
      display_name: string | null;
      account_status: AccountStatus;
    };
    if (typedProfile.display_name) {
      displayName = typedProfile.display_name;
    }
    if (typedProfile.account_status) {
      accountStatus = typedProfile.account_status;
    }
  }

  return {
    user,
    roles: authContext.roles,
    isAdmin: authContext.isAdmin,
    isMerchant: authContext.isMerchant,
    displayName,
    accountStatus,
    profileExists,
    sessionExpired: false,
    configReady: true,
  };
}

/**
 * Requires a valid, active authenticated user verified via server `getUser()`.
 */
export async function requireAuth(
  injectedClient?: SupabaseClient<Database>
): Promise<VerifiedAuthSession> {
  if (!injectedClient && !isSupabaseAuthConfigured()) {
    throw new AuthGuardError(
      "CONFIG_REQUIRED",
      503,
      "인증 서비스 설정이 필요합니다. 환경변수 설정 후 다시 시도해 주세요."
    );
  }

  const session = await getServerAuthSession(injectedClient);

  if (!session.configReady) {
    throw new AuthGuardError(
      "CONFIG_REQUIRED",
      503,
      "인증 서비스 설정이 필요합니다. 환경변수 설정 후 다시 시도해 주세요."
    );
  }

  if (!session.user) {
    if (session.sessionExpired) {
      throw new AuthGuardError(
        "SESSION_EXPIRED",
        401,
        "로그인 세션이 만료되었습니다. 다시 로그인해 주세요."
      );
    }
    throw new AuthGuardError(
      "UNAUTHORIZED",
      401,
      "로그인이 필요한 기능입니다."
    );
  }

  if (session.accountStatus !== "active") {
    throw new AuthGuardError(
      "ACCOUNT_SUSPENDED",
      403,
      "현재 이용이 제한된 계정입니다."
    );
  }

  return session as VerifiedAuthSession;
}

/**
 * Role guard (`requireRole`):
 * Blocks unauthenticated users (401) and users without the required server-verified role (403).
 * Admin role is strictly checked against `user_roles`; merchant role allows `merchant` (or `admin` when allowAdmin is true).
 */
export async function requireRole(
  requiredRole: UserRoleType | UserRoleType[],
  injectedClient?: SupabaseClient<Database>,
  options: { allowAdminOverride?: boolean } = { allowAdminOverride: true }
): Promise<VerifiedAuthSession> {
  const session = await requireAuth(injectedClient);
  const requiredList = Array.isArray(requiredRole) ? requiredRole : [requiredRole];

  const hasDirectMatch = requiredList.some((role) => session.roles.includes(role));
  const hasAdminOverride =
    Boolean(options.allowAdminOverride) &&
    !requiredList.includes("admin") &&
    session.isAdmin;

  if (!hasDirectMatch && !hasAdminOverride) {
    throw new AuthGuardError(
      "FORBIDDEN",
      403,
      "해당 페이지 또는 기능에 접근할 권한이 없습니다."
    );
  }

  return session;
}

/**
 * Business membership guard (`requireBusinessMember`):
 * Verifies on the server that the user is authenticated and either:
 * 1) holds the server-verified `admin` role, OR
 * 2) holds the `merchant` role AND is an active member (`owner` or `manager`) of the specified `businessId`.
 * Never trusts client-provided business ownership claims.
 */
export async function requireBusinessMember(
  businessId: string,
  injectedClient?: SupabaseClient<Database>,
  options?: { allowedMemberRoles?: ("owner" | "manager")[] }
): Promise<VerifiedBusinessMemberSession> {
  const normalizedBusinessId = typeof businessId === "string" ? businessId.trim() : "";
  if (!normalizedBusinessId) {
    throw new AuthGuardError(
      "INVALID_INPUT",
      400,
      "가게 식별자(businessId)가 올바르지 않습니다."
    );
  }

  const session = await requireAuth(injectedClient);

  if (session.isAdmin) {
    return {
      ...session,
      businessId: normalizedBusinessId,
      memberRole: "admin",
    };
  }

  if (!session.isMerchant) {
    throw new AuthGuardError(
      "FORBIDDEN",
      403,
      "제휴 가게 관리자 권한이 없습니다."
    );
  }

  const supabase = injectedClient ?? (await createServerClientInstance());
  const allowedMemberRoles = options?.allowedMemberRoles ?? ["owner", "manager"];

  // Query business_members table with explicit column selection (no select('*'))
  const untypedClient = supabase as unknown as {
    from: (table: string) => {
      select: (columns: string) => {
        eq: (col: string, val: string) => {
          eq: (col2: string, val2: string) => {
            eq: (col3: string, val3: string) => {
              maybeSingle: () => Promise<{
                data: { role?: string; status?: string } | null;
                error: { message?: string } | null;
              }>;
            };
          };
        };
      };
    };
  };

  const { data: membership, error: memberError } = await untypedClient
    .from("business_members")
    .select("role, status")
    .eq("business_id", normalizedBusinessId)
    .eq("user_id", session.user.id)
    .eq("status", "active")
    .maybeSingle();

  if (memberError || !membership) {
    throw new AuthGuardError(
      "FORBIDDEN",
      403,
      "해당 가게의 소속 관리자가 아니거나 승인되지 않았습니다."
    );
  }

  const memberRole = membership.role as "owner" | "manager" | undefined;
  if (!memberRole || !allowedMemberRoles.includes(memberRole)) {
    throw new AuthGuardError(
      "FORBIDDEN",
      403,
      "해당 작업을 수행할 가게 내 역할 권한이 없습니다."
    );
  }

  return {
    ...session,
    businessId: normalizedBusinessId,
    memberRole,
  };
}

/**
 * Evaluates route access policy for Guest, Customer, Merchant, and Admin paths.
 * AGENTS.md Rule 6 & TASK 04: Guest can always access `/map` without login;
 * `/merchant/*` and `/admin/*` are strictly blocked without role authorization.
 */
export function evaluateRouteAccess(
  pathname: string,
  session: Pick<ServerAuthSession, "user" | "roles" | "sessionExpired">
): {
  allowed: boolean;
  status: 200 | 401 | 403;
  redirectTo?: string;
  reason?: "login_required" | "session_expired" | "forbidden";
} {
  const cleanPath = pathname.split("?")[0] || "/";

  // Public & guest-first discovery routes: never gate behind login
  if (
    cleanPath === "/" ||
    cleanPath === "/map" ||
    cleanPath.startsWith("/map/") ||
    cleanPath.startsWith("/restrooms") ||
    cleanPath === "/login" ||
    cleanPath === "/signup"
  ) {
    return { allowed: true, status: 200 };
  }

  // Admin protected routes
  if (cleanPath === "/admin" || cleanPath.startsWith("/admin/")) {
    if (!session.user) {
      const reason = session.sessionExpired ? "session_expired" : "login_required";
      return {
        allowed: false,
        status: 401,
        redirectTo: `/login?returnTo=${encodeURIComponent(cleanPath)}&reason=${reason}`,
        reason,
      };
    }
    if (!session.roles.includes("admin")) {
      return {
        allowed: false,
        status: 403,
        reason: "forbidden",
      };
    }
    return { allowed: true, status: 200 };
  }

  // Merchant routes
  if (cleanPath === "/merchant" || cleanPath.startsWith("/merchant/")) {
    if (!session.user) {
      const reason = session.sessionExpired ? "session_expired" : "login_required";
      return {
        allowed: false,
        status: 401,
        redirectTo: `/login?returnTo=${encodeURIComponent(cleanPath)}&reason=${reason}`,
        reason,
      };
    }
    // 가게 등록 신청 및 본인 신청 관리(/merchant/businesses)는 로그인한 일반 회원(customer)도 접근 가능
    if (cleanPath === "/merchant/businesses" || cleanPath.startsWith("/merchant/businesses/")) {
      return { allowed: true, status: 200 };
    }
    // 승인된 가게 운영 기능(/merchant/restrooms 등)은 merchant 또는 admin 역할 필요
    if (!session.roles.includes("merchant") && !session.roles.includes("admin")) {
      return {
        allowed: false,
        status: 403,
        reason: "forbidden",
      };
    }
    return { allowed: true, status: 200 };
  }

  // Customer authenticated routes (/my/*, /payment/*)
  if (
    cleanPath === "/my" ||
    cleanPath.startsWith("/my/") ||
    cleanPath === "/payment" ||
    cleanPath.startsWith("/payment/")
  ) {
    if (!session.user) {
      const reason = session.sessionExpired ? "session_expired" : "login_required";
      return {
        allowed: false,
        status: 401,
        redirectTo: `/login?returnTo=${encodeURIComponent(cleanPath)}&reason=${reason}`,
        reason,
      };
    }
    return { allowed: true, status: 200 };
  }

  return { allowed: true, status: 200 };
}

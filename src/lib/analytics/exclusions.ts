import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { AccountStatus, UserRoleType } from "@/lib/db/types";

export class AnalyticsExclusionError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "AnalyticsExclusionError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const registerExcludedAccountsSchema = z
  .object({
    userIds: z
      .array(z.string().uuid("유효한 사용자 ID(UUID) 형식이 아닙니다."))
      .min(1, "제외할 계정을 1개 이상 선택해 주세요.")
      .max(50, "한 번에 최대 50개 계정까지 등록할 수 있습니다.")
      .optional(),
    userId: z
      .string()
      .uuid("유효한 사용자 ID(UUID) 형식이 아닙니다.")
      .optional(),
    note: z
      .string()
      .trim()
      .max(200, "메모는 200자 이하로 입력해 주세요.")
      .nullable()
      .optional(),
  })
  .strict()
  .refine(
    (data) => Boolean(data.userId || (data.userIds && data.userIds.length > 0)),
    {
      message: "제외할 계정의 userId 또는 userIds가 필요합니다.",
    }
  );

export const updateExcludedAccountSchema = z
  .object({
    isActive: z.boolean(),
    note: z
      .string()
      .trim()
      .max(200, "메모는 200자 이하로 입력해 주세요.")
      .nullable()
      .optional(),
  })
  .strict();

export const candidateSearchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .max(100, "검색어는 100자 이하로 입력해 주세요.")
    .optional(),
  limit: z
    .preprocess((val) => {
      if (val === undefined || val === null || val === "") return 50;
      const num = Number(val);
      return Number.isFinite(num) ? num : val;
    }, z.number().int().min(1).max(200))
    .default(50),
});

export interface ExcludedAccountItem {
  id: string;
  userId: string;
  email: string | null;
  displayName: string | null;
  accountStatus: AccountStatus;
  roles: UserRoleType[];
  isActive: boolean;
  note: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountCandidateItem {
  userId: string;
  email: string | null;
  displayName: string | null;
  accountStatus: AccountStatus;
  roles: UserRoleType[];
  createdAt: string | null;
  isCurrentlyExcluded: boolean;
}

export interface ExcludedAccountsOverview {
  activeCount: number;
  excludedAccounts: ExcludedAccountItem[];
  candidates: AccountCandidateItem[];
}

interface AuthUserSummary {
  id: string;
  email: string | null;
  displayName: string | null;
  createdAt: string | null;
}

async function listAuthUsersMap(
  adminClient: SupabaseClient<any>
): Promise<Map<string, AuthUserSummary>> {
  const map = new Map<string, AuthUserSummary>();
  const authAdmin = (adminClient as any)?.auth?.admin;
  if (!authAdmin || typeof authAdmin.listUsers !== "function") {
    return map;
  }

  let page = 1;
  const perPage = 200;
  const maxPages = 10;

  while (page <= maxPages) {
    const res = await authAdmin.listUsers({ page, perPage });
    if (res?.error) {
      throw new AnalyticsExclusionError(
        "AUTH_USERS_FETCH_FAILED",
        "회원 계정 목록을 조회하지 못했습니다.",
        500
      );
    }

    const users = Array.isArray(res?.data?.users) ? res.data.users : [];
    for (const u of users) {
      if (!u?.id) continue;
      const metaName =
        typeof u.user_metadata?.display_name === "string"
          ? u.user_metadata.display_name
          : typeof u.user_metadata?.full_name === "string"
          ? u.user_metadata.full_name
          : typeof u.user_metadata?.name === "string"
          ? u.user_metadata.name
          : null;
      map.set(u.id, {
        id: u.id,
        email: typeof u.email === "string" ? u.email : null,
        displayName: metaName,
        createdAt: typeof u.created_at === "string" ? u.created_at : null,
      });
    }

    if (users.length < perPage) {
      break;
    }
    page += 1;
  }

  return map;
}

async function listProfilesAndRoles(
  adminClient: SupabaseClient<any>
): Promise<{
  profilesMap: Map<
    string,
    {
      id: string;
      display_name: string | null;
      account_status: AccountStatus;
      created_at: string;
    }
  >;
  rolesMap: Map<string, UserRoleType[]>;
}> {
  const [profilesRes, rolesRes] = await Promise.all([
    adminClient
      .from("profiles")
      .select("id, display_name, account_status, created_at")
      .order("created_at", { ascending: false })
      .limit(1000),
    adminClient.from("user_roles").select("user_id, role").limit(2000),
  ]);

  if (profilesRes.error) {
    throw new AnalyticsExclusionError(
      "PROFILES_FETCH_FAILED",
      "회원 프로필 목록을 조회하지 못했습니다.",
      500
    );
  }

  const profilesMap = new Map<
    string,
    {
      id: string;
      display_name: string | null;
      account_status: AccountStatus;
      created_at: string;
    }
  >();

  for (const p of profilesRes.data ?? []) {
    if (p?.id) {
      profilesMap.set(p.id, {
        id: p.id,
        display_name: p.display_name ?? null,
        account_status: (p.account_status as AccountStatus) ?? "active",
        created_at: p.created_at,
      });
    }
  }

  const rolesMap = new Map<string, UserRoleType[]>();
  for (const r of rolesRes.data ?? []) {
    if (!r?.user_id || !r?.role) continue;
    const list = rolesMap.get(r.user_id) ?? [];
    if (!list.includes(r.role as UserRoleType)) {
      list.push(r.role as UserRoleType);
    }
    rolesMap.set(r.user_id, list);
  }

  return { profilesMap, rolesMap };
}

/**
 * Fetches active excluded user IDs for analytics report filtering.
 * Returns null if the exclusion configuration query fails so callers can distinguish
 * a clean empty list from a DB outage.
 */
export async function getActiveExcludedUserIds(
  supabase: SupabaseClient<any>
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("analytics_excluded_accounts")
    .select("user_id")
    .eq("is_active", true);

  if (error) {
    throw new AnalyticsExclusionError(
      "EXCLUSION_LOOKUP_FAILED",
      "통계 제외 계정 설정 조회에 실패했습니다.",
      500
    );
  }

  const set = new Set<string>();
  for (const row of data ?? []) {
    if (typeof row?.user_id === "string" && row.user_id.length > 0) {
      set.add(row.user_id);
    }
  }
  return set;
}

/**
 * Indexed single-row active check for the basic usage counter hot path.
 * Throws AnalyticsExclusionError on DB failure so the caller can fail-closed (skip counting).
 */
export async function isUserExcludedFromAnalytics(
  adminClient: SupabaseClient<any>,
  userId: string
): Promise<boolean> {
  if (!userId) return false;

  const { data, error } = await adminClient
    .from("analytics_excluded_accounts")
    .select("user_id, is_active")
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    throw new AnalyticsExclusionError(
      "EXCLUSION_LOOKUP_FAILED",
      "통계 제외 설정 조회 중 오류가 발생했습니다.",
      500
    );
  }

  return Boolean(data && data.is_active === true);
}

/**
 * Lists currently configured excluded accounts and searchable member candidates for admin UI.
 */
export async function getExcludedAccountsOverview(
  adminClient: SupabaseClient<any>,
  options: { q?: string; limit?: number } = {}
): Promise<ExcludedAccountsOverview> {
  const q = (options.q ?? "").trim().toLowerCase();
  const limit = options.limit ?? 50;

  const [{ data: exclusionRows, error: exError }, authUsersMap, { profilesMap, rolesMap }] =
    await Promise.all([
      adminClient
        .from("analytics_excluded_accounts")
        .select("id, user_id, is_active, note, created_by, updated_by, created_at, updated_at")
        .order("updated_at", { ascending: false }),
      listAuthUsersMap(adminClient),
      listProfilesAndRoles(adminClient),
    ]);

  if (exError) {
    throw new AnalyticsExclusionError(
      "EXCLUSION_LIST_FAILED",
      "통계 제외 계정 목록을 불러오지 못했습니다.",
      500
    );
  }

  const excludedByUserId = new Map<string, any>();
  for (const row of exclusionRows ?? []) {
    if (row?.user_id) {
      excludedByUserId.set(row.user_id, row);
    }
  }

  const excludedAccounts: ExcludedAccountItem[] = (exclusionRows ?? []).map((row: any) => {
    const authUser = authUsersMap.get(row.user_id);
    const profile = profilesMap.get(row.user_id);
    return {
      id: row.id,
      userId: row.user_id,
      email: authUser?.email ?? null,
      displayName: profile?.display_name ?? authUser?.displayName ?? null,
      accountStatus: profile?.account_status ?? "active",
      roles: rolesMap.get(row.user_id) ?? ["customer"],
      isActive: Boolean(row.is_active),
      note: row.note ?? null,
      createdBy: row.created_by ?? null,
      updatedBy: row.updated_by ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });

  const activeCount = excludedAccounts.filter((item) => item.isActive).length;

  // Build candidate list from profiles (all real users have a profile via handle_new_user)
  const allUserIds = new Set<string>([
    ...profilesMap.keys(),
    ...authUsersMap.keys(),
  ]);

  const candidates: AccountCandidateItem[] = [];
  for (const uid of allUserIds) {
    const profile = profilesMap.get(uid);
    const authUser = authUsersMap.get(uid);
    // Only include accounts that exist in profiles (or authUsers if profile lookup had partial data)
    if (!profile) continue;

    const email = authUser?.email ?? null;
    const displayName = profile.display_name ?? authUser?.displayName ?? null;
    const roles = rolesMap.get(uid) ?? ["customer"];

    if (q.length > 0) {
      const matchesEmail = email ? email.toLowerCase().includes(q) : false;
      const matchesName = displayName ? displayName.toLowerCase().includes(q) : false;
      const matchesId = uid.toLowerCase().includes(q);
      if (!matchesEmail && !matchesName && !matchesId) {
        continue;
      }
    }

    const existingExclusion = excludedByUserId.get(uid);
    candidates.push({
      userId: uid,
      email,
      displayName,
      accountStatus: profile.account_status,
      roles,
      createdAt: profile.created_at ?? authUser?.createdAt ?? null,
      isCurrentlyExcluded: Boolean(existingExclusion?.is_active === true),
    });
  }

  candidates.sort((a, b) => {
    if (a.isCurrentlyExcluded !== b.isCurrentlyExcluded) {
      return a.isCurrentlyExcluded ? 1 : -1;
    }
    return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  });

  return {
    activeCount,
    excludedAccounts,
    candidates: candidates.slice(0, limit),
  };
}

/**
 * Registers or re-activates one or more existing user accounts in analytics_excluded_accounts.
 * Validates account existence, deduplicates input IDs, and prevents duplicate rows via upsert.
 */
export async function registerExcludedAccounts(
  adminClient: SupabaseClient<any>,
  rawPayload: unknown,
  actorUserId: string | null
): Promise<{
  registeredCount: number;
  items: ExcludedAccountItem[];
}> {
  const parsed = registerExcludedAccountsSchema.safeParse(rawPayload);
  if (!parsed.success) {
    throw new AnalyticsExclusionError(
      "VALIDATION_ERROR",
      parsed.error.issues[0]?.message || "유효하지 않은 제외 계정 등록 요청입니다.",
      400
    );
  }

  const rawIds = [
    ...(parsed.data.userIds ?? []),
    ...(parsed.data.userId ? [parsed.data.userId] : []),
  ];
  const uniqueUserIds = Array.from(new Set(rawIds));
  const normalizedNote =
    parsed.data.note !== undefined ? parsed.data.note || null : undefined;

  // 1. Verify all target user IDs exist in profiles
  const { data: existingProfiles, error: profileError } = await adminClient
    .from("profiles")
    .select("id, display_name, account_status")
    .in("id", uniqueUserIds);

  if (profileError) {
    throw new AnalyticsExclusionError(
      "PROFILES_LOOKUP_FAILED",
      "대상 회원 계정 확인 중 오류가 발생했습니다.",
      500
    );
  }

  const foundIds = new Set((existingProfiles ?? []).map((p: any) => p.id));
  const missingIds = uniqueUserIds.filter((id) => !foundIds.has(id));
  if (missingIds.length > 0) {
    throw new AnalyticsExclusionError(
      "USER_NOT_FOUND",
      "존재하지 않는 회원 계정은 통계 제외 대상으로 등록할 수 없습니다.",
      404
    );
  }

  // 2. Check existing rows so created_by is preserved for existing entries
  const { data: existingRows, error: existingErr } = await adminClient
    .from("analytics_excluded_accounts")
    .select("id, user_id, note, created_by")
    .in("user_id", uniqueUserIds);

  if (existingErr) {
    throw new AnalyticsExclusionError(
      "EXCLUSION_LOOKUP_FAILED",
      "기존 제외 설정 조회 중 오류가 발생했습니다.",
      500
    );
  }

  const existingByUserId = new Map<string, any>();
  for (const r of existingRows ?? []) {
    existingByUserId.set(r.user_id, r);
  }

  const now = new Date().toISOString();
  const upsertPayloads = uniqueUserIds.map((uid) => {
    const prev = existingByUserId.get(uid);
    return {
      user_id: uid,
      is_active: true,
      note: normalizedNote !== undefined ? normalizedNote : prev?.note ?? null,
      created_by: prev?.created_by ?? actorUserId,
      updated_by: actorUserId,
      updated_at: now,
    };
  });

  const { data: upsertedRows, error: upsertError } = await adminClient
    .from("analytics_excluded_accounts")
    .upsert(upsertPayloads, { onConflict: "user_id" })
    .select("id, user_id, is_active, note, created_by, updated_by, created_at, updated_at");

  if (upsertError) {
    throw new AnalyticsExclusionError(
      "EXCLUSION_SAVE_FAILED",
      "통계 제외 계정 저장에 실패했습니다.",
      500
    );
  }

  // Best-effort immutable audit log write (never blocks or alters exclusion success)
  try {
    if (Array.isArray(upsertedRows) && upsertedRows.length > 0) {
      await adminClient.from("audit_logs").insert(
        upsertedRows.map((row: any) => ({
          actor_user_id: actorUserId,
          action: "analytics_excluded_account_enabled",
          entity_type: "analytics_excluded_account",
          entity_id: row.id,
          before_data: existingByUserId.has(row.user_id)
            ? { is_active: false }
            : null,
          after_data: {
            user_id: row.user_id,
            is_active: true,
          },
          reason: row.note ?? null,
        }))
      );
    }
  } catch {
    // Non-blocking in mock/test environments lacking audit_logs
  }

  const overview = await getExcludedAccountsOverview(adminClient, { limit: 200 });
  const updatedItems = overview.excludedAccounts.filter((item) =>
    uniqueUserIds.includes(item.userId)
  );

  return {
    registeredCount: updatedItems.length,
    items: updatedItems,
  };
}

/**
 * Updates (activates or deactivates) an exclusion entry for a given userId.
 */
export async function updateExcludedAccountStatus(
  adminClient: SupabaseClient<any>,
  userId: string,
  rawPayload: unknown,
  actorUserId: string | null
): Promise<ExcludedAccountItem> {
  const uuidCheck = z.string().uuid("유효한 사용자 ID 형식이 아닙니다.").safeParse(userId);
  if (!uuidCheck.success) {
    throw new AnalyticsExclusionError(
      "INVALID_USER_ID",
      uuidCheck.error.issues[0]?.message || "유효하지 않은 사용자 ID입니다.",
      400
    );
  }

  const parsed = updateExcludedAccountSchema.safeParse(rawPayload);
  if (!parsed.success) {
    throw new AnalyticsExclusionError(
      "VALIDATION_ERROR",
      parsed.error.issues[0]?.message || "유효하지 않은 제외 상태 변경 요청입니다.",
      400
    );
  }

  const { data: existing, error: findErr } = await adminClient
    .from("analytics_excluded_accounts")
    .select("id, user_id, is_active, note")
    .eq("user_id", uuidCheck.data)
    .maybeSingle();

  if (findErr) {
    throw new AnalyticsExclusionError(
      "EXCLUSION_LOOKUP_FAILED",
      "제외 설정 조회 중 오류가 발생했습니다.",
      500
    );
  }

  if (!existing) {
    throw new AnalyticsExclusionError(
      "EXCLUSION_NOT_FOUND",
      "해당 계정의 통계 제외 설정을 찾을 수 없습니다.",
      404
    );
  }

  const nextNote =
    parsed.data.note !== undefined ? parsed.data.note || null : existing.note;

  const { data: updated, error: updateErr } = await adminClient
    .from("analytics_excluded_accounts")
    .update({
      is_active: parsed.data.isActive,
      note: nextNote,
      updated_by: actorUserId,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", uuidCheck.data)
    .select("id, user_id, is_active, note, created_by, updated_by, created_at, updated_at")
    .single();

  if (updateErr || !updated) {
    throw new AnalyticsExclusionError(
      "EXCLUSION_UPDATE_FAILED",
      "통계 제외 설정 변경에 실패했습니다.",
      500
    );
  }

  try {
    await adminClient.from("audit_logs").insert({
      actor_user_id: actorUserId,
      action: parsed.data.isActive
        ? "analytics_excluded_account_enabled"
        : "analytics_excluded_account_disabled",
      entity_type: "analytics_excluded_account",
      entity_id: updated.id,
      before_data: { is_active: Boolean(existing.is_active) },
      after_data: { user_id: updated.user_id, is_active: parsed.data.isActive },
      reason: nextNote ?? null,
    });
  } catch {
    // Non-blocking
  }

  const overview = await getExcludedAccountsOverview(adminClient, { limit: 200 });
  const match = overview.excludedAccounts.find((item) => item.userId === uuidCheck.data);
  if (match) {
    return match;
  }

  return {
    id: updated.id,
    userId: updated.user_id,
    email: null,
    displayName: null,
    accountStatus: "active",
    roles: ["customer"],
    isActive: Boolean(updated.is_active),
    note: updated.note ?? null,
    createdBy: updated.created_by ?? null,
    updatedBy: updated.updated_by ?? null,
    createdAt: updated.created_at,
    updatedAt: updated.updated_at,
  };
}

import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Database, UserRoleType } from "@/lib/db/types";

export interface AuthUserInfo {
  user: User | null;
  roles: UserRoleType[];
  isAdmin: boolean;
  isMerchant: boolean;
}

/**
 * Authoritatively retrieves authenticated user from Supabase using getUser().
 * AGENTS.md Rule 7: The server strictly trusts Supabase Auth getUser() rather than untrusted client JWT claims.
 */
export async function getAuthUser(
  supabase: SupabaseClient<Database>
): Promise<User | null> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    return null;
  }
  return data.user;
}

/**
 * Retrieves the roles assigned to a user from user_roles.
 */
export async function getUserRoles(
  supabase: SupabaseClient<Database>,
  userId: string
): Promise<UserRoleType[]> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);

  if (error || !data) {
    return [];
  }

  return (data as { role: UserRoleType }[]).map((r) => r.role);
}

/**
 * Checks if a user has a specific role.
 */
export async function hasRole(
  supabase: SupabaseClient<Database>,
  userId: string,
  role: UserRoleType
): Promise<boolean> {
  const roles = await getUserRoles(supabase, userId);
  return roles.includes(role);
}

/**
 * Verifies if user has admin privileges.
 */
export async function isAdmin(
  supabase: SupabaseClient<Database>,
  userId: string
): Promise<boolean> {
  return hasRole(supabase, userId, "admin");
}

/**
 * Verifies if user has merchant privileges.
 */
export async function isMerchant(
  supabase: SupabaseClient<Database>,
  userId: string
): Promise<boolean> {
  return hasRole(supabase, userId, "merchant");
}

/**
 * Composite authentication check returning verified user and roles.
 */
export async function getVerifiedAuthContext(
  supabase: SupabaseClient<Database>
): Promise<AuthUserInfo> {
  const user = await getAuthUser(supabase);
  if (!user) {
    return {
      user: null,
      roles: [],
      isAdmin: false,
      isMerchant: false,
    };
  }

  const roles = await getUserRoles(supabase, user.id);
  return {
    user,
    roles,
    isAdmin: roles.includes("admin"),
    isMerchant: roles.includes("merchant"),
  };
}


import { NextResponse } from "next/server";
import type { UserRoleType } from "@/lib/db/types";
import {
  AuthGuardError,
  evaluateRouteAccess,
  getQaAuthVerificationSummary,
  getServerAuthSession,
  recordQaAuthEvent,
  requireAuth,
  requireBusinessMember,
  requireRole,
} from "@/lib/auth";

const VALID_ROLES: UserRoleType[] = ["customer", "merchant", "admin"];

export async function GET(request: Request) {
  // Block diagnostic guard endpoint in production deployments
  if (process.env.VERCEL_ENV === "production") {
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const summaryParam = searchParams.get("summary");
  const targetPath = searchParams.get("path");
  const requiredRoleParam = searchParams.get("role");
  const businessIdParam = searchParams.get("businessId");

  if (summaryParam === "1") {
    return NextResponse.json(getQaAuthVerificationSummary(), { status: 200 });
  }

  try {
    if (businessIdParam !== null) {
      const verified = await requireBusinessMember(businessIdParam);
      return NextResponse.json(
        {
          allowed: true,
          status: 200,
          businessId: verified.businessId,
          memberRole: verified.memberRole,
          roles: verified.roles,
        },
        { status: 200 }
      );
    }

    if (requiredRoleParam !== null) {
      if (!VALID_ROLES.includes(requiredRoleParam as UserRoleType)) {
        return NextResponse.json(
          {
            allowed: false,
            status: 400,
            error: {
              code: "INVALID_ROLE",
              message: "유효하지 않은 권한 요청입니다.",
            },
          },
          { status: 400 }
        );
      }

      const verified = await requireRole(requiredRoleParam as UserRoleType);
      return NextResponse.json(
        {
          allowed: true,
          status: 200,
          roles: verified.roles,
        },
        { status: 200 }
      );
    }

    if (targetPath !== null) {
      const session = await getServerAuthSession();
      if (!session.configReady) {
        return NextResponse.json(
          {
            allowed: false,
            status: 503,
            error: {
              code: "CONFIG_REQUIRED",
              message: "인증 서비스 설정이 필요합니다.",
            },
          },
          { status: 503 }
        );
      }

      const access = evaluateRouteAccess(targetPath, session);
      if (!access.allowed && access.status === 401) {
        recordQaAuthEvent({ type: "post_logout_guard_401" });
      }
      return NextResponse.json(access, { status: access.status });
    }

    const session = await requireAuth();
    return NextResponse.json(
      {
        allowed: true,
        status: 200,
        userId: session.user.id,
        roles: session.roles,
      },
      { status: 200 }
    );
  } catch (err) {
    if (err instanceof AuthGuardError) {
      if (err.status === 403 && requiredRoleParam === "merchant") {
        recordQaAuthEvent({ type: "merchant_guard_403" });
      } else if (err.status === 403 && requiredRoleParam === "admin") {
        recordQaAuthEvent({ type: "admin_guard_403" });
      } else if (err.status === 403 && businessIdParam !== null) {
        recordQaAuthEvent({ type: "business_guard_403" });
      } else if (err.status === 401) {
        recordQaAuthEvent({ type: "post_logout_guard_401" });
      }

      return NextResponse.json(
        {
          allowed: false,
          status: err.status,
          error: {
            code: err.code,
            message: err.userMessage,
          },
        },
        { status: err.status }
      );
    }

    return NextResponse.json(
      {
        allowed: false,
        status: 500,
        error: {
          code: "SERVER_ERROR",
          message: "권한 확인 중 일시적인 오류가 발생했습니다.",
        },
      },
      { status: 500 }
    );
  }
}

import { NextResponse } from "next/server";
import { getServerAuthSession, recordQaAuthEvent } from "@/lib/auth";

export async function GET() {
  try {
    const session = await getServerAuthSession();

    if (!session.configReady) {
      return NextResponse.json(
        {
          authenticated: false,
          configReady: false,
          sessionExpired: false,
          user: null,
          roles: [],
          message: "인증 서비스 설정이 필요합니다.",
        },
        { status: 503 }
      );
    }

    if (!session.user) {
      return NextResponse.json(
        {
          authenticated: false,
          configReady: true,
          sessionExpired: session.sessionExpired,
          user: null,
          roles: [],
        },
        { status: 200 }
      );
    }

    recordQaAuthEvent({
      type: "session_verified",
      userId: session.user.id,
      profileExists: session.profileExists,
      accountStatus: session.accountStatus,
      roles: session.roles,
      isAdmin: session.isAdmin,
      isMerchant: session.isMerchant,
    });

    return NextResponse.json(
      {
        authenticated: true,
        configReady: true,
        sessionExpired: false,
        user: {
          id: session.user.id,
          displayName: session.displayName,
          accountStatus: session.accountStatus,
          profileExists: session.profileExists,
        },
        roles: session.roles,
        isAdmin: session.isAdmin,
        isMerchant: session.isMerchant,
      },
      { status: 200 }
    );
  } catch {
    return NextResponse.json(
      {
        authenticated: false,
        configReady: false,
        sessionExpired: false,
        user: null,
        roles: [],
        message: "인증 상태를 확인할 수 없습니다.",
      },
      { status: 500 }
    );
  }
}

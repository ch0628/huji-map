import { NextResponse } from "next/server";
import { createServerClientInstance } from "@/lib/supabase/server";
import { isCloudDeploymentRuntime } from "@/lib/auth/mock-guard";
import {
  checkIdempotencyKey,
  isSupabaseAuthConfigured,
  recordQaAuthEvent,
  sanitizeReturnTo,
  signupSchema,
} from "@/lib/auth";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const HOST_PATTERN = /^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i;

function parseAllowedHostsEnv(): Set<string> {
  const raw = process.env.ALLOWED_APP_HOSTS;
  if (!raw) return new Set();
  const entries = raw
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v.length > 0 && HOST_PATTERN.test(v));
  return new Set(entries);
}

function extractHostname(host: string): string {
  const lower = host.trim().toLowerCase();
  if (lower.startsWith("[")) {
    const endIdx = lower.indexOf("]");
    return endIdx >= 0 ? lower.slice(0, endIdx + 1) : lower;
  }
  const colonIdx = lower.indexOf(":");
  return colonIdx >= 0 ? lower.slice(0, colonIdx) : lower;
}

function isValidPort(host: string): boolean {
  const lower = host.trim().toLowerCase();
  if (lower.startsWith("[")) {
    const endIdx = lower.indexOf("]");
    if (endIdx < 0) return false;
    const rest = lower.slice(endIdx + 1);
    if (!rest) return true;
    if (!rest.startsWith(":")) return false;
    const port = Number(rest.slice(1));
    return Number.isInteger(port) && port >= 1 && port <= 65535;
  }
  const colonIdx = lower.indexOf(":");
  if (colonIdx < 0) return true;
  const port = Number(lower.slice(colonIdx + 1));
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function isCloudRunDefaultHostname(hostname: string): boolean {
  if (hostname.startsWith(".") || hostname.endsWith(".") || hostname.includes("..")) {
    return false;
  }
  if (hostname.endsWith(".a.run.app")) {
    return hostname.length > ".a.run.app".length;
  }
  if (hostname.endsWith(".run.app")) {
    return hostname.length > ".run.app".length;
  }
  return false;
}

function isAllowedAppHost(
  rawHost: string | null | undefined,
  options: { isCloud: boolean; explicitAllowedHosts: Set<string> }
): boolean {
  if (!rawHost) return false;
  const host = rawHost.trim().toLowerCase();
  if (!host || !HOST_PATTERN.test(host) || !isValidPort(host)) {
    return false;
  }

  const hostname = extractHostname(host);
  if (!hostname || hostname === "0.0.0.0") {
    return false;
  }

  if (options.explicitAllowedHosts.size > 0) {
    return (
      options.explicitAllowedHosts.has(host) ||
      options.explicitAllowedHosts.has(hostname)
    );
  }

  if (options.isCloud) {
    if (LOCAL_HOSTS.has(hostname) || hostname.endsWith(".localhost")) {
      return false;
    }
    return isCloudRunDefaultHostname(hostname);
  }

  return LOCAL_HOSTS.has(hostname);
}

function parseExplicitConfiguredOrigin(
  rawUrl: string | undefined,
  options: { isCloud: boolean; explicitAllowedHosts: Set<string> }
): string | null {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.username || parsed.password) {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname === "0.0.0.0") {
    return null;
  }

  if (options.isCloud) {
    if (parsed.protocol !== "https:") {
      return null;
    }
    if (LOCAL_HOSTS.has(hostname) || hostname.endsWith(".localhost")) {
      return null;
    }
    if (
      options.explicitAllowedHosts.size > 0 &&
      !options.explicitAllowedHosts.has(parsed.host.toLowerCase()) &&
      !options.explicitAllowedHosts.has(hostname)
    ) {
      return null;
    }
    return parsed.origin;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return null;
  }

  if (
    parsed.protocol === "http:" &&
    !isAllowedAppHost(parsed.host, options)
  ) {
    return null;
  }

  return parsed.origin;
}

/**
 * Resolves a trusted external origin for Supabase auth emailRedirectTo.
 * Priority:
 * 1. Explicitly configured server runtime APP_URL (then NEXT_PUBLIC_APP_URL if valid for environment)
 * 2. Validated request.url against allowed hosts
 * 3. Validated X-Forwarded-* headers only in trusted proxy environments (e.g. Cloud Run K_SERVICE)
 */
function resolveSafeAuthRedirectOrigin(request: Request): string | null {
  const isCloud = isCloudDeploymentRuntime();
  const explicitAllowedHosts = parseAllowedHostsEnv();
  const options = { isCloud, explicitAllowedHosts };

  // 1. Server-configured explicit external URL (APP_URL takes precedence over build-time NEXT_PUBLIC_APP_URL)
  const fromAppUrl = parseExplicitConfiguredOrigin(process.env.APP_URL, options);
  if (fromAppUrl) {
    return fromAppUrl;
  }
  const fromPublicAppUrl = parseExplicitConfiguredOrigin(
    process.env.NEXT_PUBLIC_APP_URL,
    options
  );
  if (fromPublicAppUrl) {
    return fromPublicAppUrl;
  }

  // 2. Validated request URL (strictly checks host allowlist & header consistency)
  let parsedRequestUrl: URL | null = null;
  try {
    parsedRequestUrl = new URL(request.url);
  } catch {
    parsedRequestUrl = null;
  }

  const headerHost = request.headers.get("host")?.trim().toLowerCase() ?? null;
  if (parsedRequestUrl) {
    const reqHost = parsedRequestUrl.host.toLowerCase();
    const hostHeaderConsistent = !headerHost || headerHost === reqHost;
    const protocolAllowed = isCloud
      ? parsedRequestUrl.protocol === "https:"
      : parsedRequestUrl.protocol === "http:" ||
        parsedRequestUrl.protocol === "https:";

    if (
      protocolAllowed &&
      hostHeaderConsistent &&
      isAllowedAppHost(reqHost, options)
    ) {
      return parsedRequestUrl.origin;
    }
  }

  // 3. Trusted reverse-proxy forwarded headers (Cloud Run K_SERVICE or explicit TRUST_PROXY_HEADERS=1)
  const isTrustedProxy = isCloud || process.env.TRUST_PROXY_HEADERS === "1";
  if (isTrustedProxy) {
    const rawForwardedProto = request.headers.get("x-forwarded-proto");
    const proto = rawForwardedProto?.split(",")[0]?.trim().toLowerCase();
    const protoValid = isCloud
      ? proto === "https"
      : proto === "https" || proto === "http";

    if (!protoValid) {
      return null;
    }

    const rawForwardedHost = request.headers.get("x-forwarded-host");
    if (rawForwardedHost !== null) {
      // Reject ambiguous multi-value or disallowed forwarded host headers
      if (rawForwardedHost.includes(",")) {
        return null;
      }
      const forwardedHost = rawForwardedHost.trim().toLowerCase();
      if (!isAllowedAppHost(forwardedHost, options)) {
        return null;
      }
      return `${proto}://${forwardedHost}`;
    }

    const fallbackHost = headerHost || parsedRequestUrl?.host.toLowerCase() || null;
    if (isAllowedAppHost(fallbackHost, options)) {
      return `${proto}://${fallbackHost}`;
    }
  }

  return null;
}

function mapSupabaseSignupError(error: { message?: string; code?: string }): {
  status: number;
  code: string;
  message: string;
} {
  const rawMessage = (error.message || "").toLowerCase();
  const rawCode = (error.code || "").toLowerCase();

  if (
    rawCode === "user_already_exists" ||
    rawCode === "email_exists" ||
    rawMessage.includes("already registered") ||
    rawMessage.includes("already exists")
  ) {
    return {
      status: 409,
      code: "EMAIL_ALREADY_EXISTS",
      message: "이미 가입된 이메일 주소입니다. 로그인해 주세요.",
    };
  }

  if (
    rawCode === "weak_password" ||
    rawMessage.includes("password should be")
  ) {
    return {
      status: 400,
      code: "WEAK_PASSWORD",
      message: "비밀번호가 보안 기준에 미달합니다. 8자 이상으로 설정해 주세요.",
    };
  }

  if (
    rawCode === "over_request_rate_limit" ||
    rawCode === "over_email_send_rate_limit" ||
    rawMessage.includes("rate limit")
  ) {
    return {
      status: 429,
      code: "RATE_LIMITED",
      message: "가입 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
    };
  }

  return {
    status: 400,
    code: "SIGNUP_FAILED",
    message: "회원가입을 처리할 수 없습니다. 입력한 이메일과 비밀번호를 확인해 주세요.",
  };
}

export async function POST(request: Request) {
  if (!isSupabaseAuthConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "CONFIG_REQUIRED",
          message: "인증 서비스 설정이 필요합니다. 환경변수를 확인해 주세요.",
        },
      },
      { status: 503 }
    );
  }

  const idempotencyKey = request.headers.get("x-idempotency-key");
  const { isDuplicate } = checkIdempotencyKey(idempotencyKey, "auth:signup");
  if (isDuplicate) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "DUPLICATE_REQUEST",
          message: "이미 처리 중인 회원가입 요청입니다. 잠시만 기다려 주세요.",
        },
      },
      { status: 409 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INVALID_JSON",
          message: "요청 형식이 올바르지 않습니다.",
        },
      },
      { status: 400 }
    );
  }

  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          field: firstIssue?.path?.[0] ?? "email",
          message: firstIssue?.message ?? "입력값을 확인해 주세요.",
        },
      },
      { status: 400 }
    );
  }

  try {
    const supabase = await createServerClientInstance();
    const displayName =
      parsed.data.displayName && parsed.data.displayName.length > 0
        ? parsed.data.displayName
        : null;

    const safeOrigin = resolveSafeAuthRedirectOrigin(request);

    const { data, error } = await supabase.auth.signUp({
      email: parsed.data.email,
      password: parsed.data.password,
      options: {
        ...(safeOrigin ? { emailRedirectTo: `${safeOrigin}/login` } : {}),
        data: {
          display_name: displayName,
          preferred_language: "ko",
        },
      },
    });

    if (error || !data.user) {
      const mapped = mapSupabaseSignupError(error ?? {});
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: mapped.code,
            message: mapped.message,
          },
        },
        { status: mapped.status }
      );
    }

    const requiresEmailVerification = !data.session;
    const redirectTo = parsed.data.returnTo
      ? sanitizeReturnTo(parsed.data.returnTo)
      : "/login";

    recordQaAuthEvent({
      type: "signup_success",
      userId: data.user.id,
      requiresEmailVerification,
    });

    return NextResponse.json(
      {
        ok: true,
        requiresEmailVerification,
        redirectTo,
        user: {
          id: data.user.id,
          displayName,
          roles: ["customer"],
        },
      },
      { status: 201 }
    );
  } catch {
    // AGENTS.md Rule 8 & 13: Never log or expose credentials, emails, or stack traces
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "SERVER_ERROR",
          message: "일시적인 인증 서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
        },
      },
      { status: 500 }
    );
  }
}

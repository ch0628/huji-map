import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  isCloudDeploymentRuntime,
  isE2eMockEnvironmentEnabled,
  isE2eMockSessionAllowed,
} from "@/lib/auth/mock-guard";
import { clearIdempotencyStoreForTests } from "@/lib/auth/validation";

const mockSignUp = vi.fn();
const mockCreateServerClientInstance = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createServerClientInstance: () => mockCreateServerClientInstance(),
}));

import { GET as guardGet } from "@/app/api/v1/auth/guard/route";
import { POST as signupPost } from "@/app/api/v1/auth/signup/route";

describe("GCP Cloud Run 배포 보안 및 환경 가드 회귀 테스트", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    clearIdempotencyStoreForTests();
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_key_only",
    };
    delete process.env.K_SERVICE;
    delete process.env.CLOUD_RUN_JOB;
    delete process.env.VERCEL_ENV;
    delete process.env.NEXT_PUBLIC_VERCEL_ENV;
    delete process.env.ALLOW_E2E_MOCK;
    delete process.env.APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.ALLOWED_APP_HOSTS;
    delete process.env.TRUST_PROXY_HEADERS;

    mockCreateServerClientInstance.mockResolvedValue({
      auth: {
        signUp: mockSignUp,
      },
    });
    mockSignUp.mockResolvedValue({
      data: {
        user: { id: "11111111-1111-4111-8111-111111111111" },
        session: null,
      },
      error: null,
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe("1. Mock 인증 보안 가드 (Cloud Run / Vercel / 로컬 E2E)", () => {
    it("Cloud Run(K_SERVICE) 환경에서는 ALLOW_E2E_MOCK=1 이어도 Mock을 엄격히 차단한다", () => {
      process.env.ALLOW_E2E_MOCK = "1";
      process.env.K_SERVICE = "hujimap-staging";

      expect(isCloudDeploymentRuntime()).toBe(true);
      expect(isE2eMockEnvironmentEnabled()).toBe(false);
      expect(isE2eMockSessionAllowed("1")).toBe(false);
    });

    it("Cloud Run Job(CLOUD_RUN_JOB) 환경에서도 Mock을 차단한다", () => {
      process.env.ALLOW_E2E_MOCK = "1";
      process.env.CLOUD_RUN_JOB = "hujimap-job";

      expect(isCloudDeploymentRuntime()).toBe(true);
      expect(isE2eMockEnvironmentEnabled()).toBe(false);
      expect(isE2eMockSessionAllowed("1")).toBe(false);
    });

    it("Vercel production 환경에서도 기존처럼 Mock을 차단한다", () => {
      process.env.ALLOW_E2E_MOCK = "1";
      process.env.VERCEL_ENV = "production";

      expect(isCloudDeploymentRuntime()).toBe(true);
      expect(isE2eMockEnvironmentEnabled()).toBe(false);
      expect(isE2eMockSessionAllowed("1")).toBe(false);

      delete process.env.VERCEL_ENV;
      process.env.NEXT_PUBLIC_VERCEL_ENV = "production";

      expect(isCloudDeploymentRuntime()).toBe(true);
      expect(isE2eMockSessionAllowed("1")).toBe(false);
    });

    it("로컬 E2E 환경(K_SERVICE·VERCEL_ENV 미설정, NODE_ENV=production 포함)에서는 ALLOW_E2E_MOCK=1 시 정상 동작한다", () => {
      process.env.ALLOW_E2E_MOCK = "1";
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";

      expect(isCloudDeploymentRuntime()).toBe(false);
      expect(isE2eMockEnvironmentEnabled()).toBe(true);
      expect(isE2eMockSessionAllowed("1")).toBe(true);
      expect(isE2eMockSessionAllowed("0")).toBe(false);
    });
  });

  describe("2. QA 진단 API (/api/v1/auth/guard) 환경별 차단", () => {
    it("Cloud Run(K_SERVICE) 환경에서는 QA 진단 API가 404를 반환한다", async () => {
      process.env.K_SERVICE = "hujimap-staging";

      const res = await guardGet(
        new Request("http://0.0.0.0:8080/api/v1/auth/guard?summary=1")
      );
      expect(res.status).toBe(404);
    });

    it("Vercel production 환경에서도 QA 진단 API가 404를 반환한다", async () => {
      process.env.VERCEL_ENV = "production";

      const res = await guardGet(
        new Request("https://hujimap.vercel.app/api/v1/auth/guard?summary=1")
      );
      expect(res.status).toBe(404);
    });

    it("로컬 환경에서는 QA 진단 API 요약 조회가 정상 응답한다", async () => {
      const res = await guardGet(
        new Request("http://localhost:3000/api/v1/auth/guard?summary=1")
      );
      expect(res.status).toBe(200);
    });
  });

  describe("3. 회원가입 인증 리다이렉트 URL(emailRedirectTo) 신뢰 검증", () => {
    async function invokeSignup(request: Request) {
      mockSignUp.mockClear();
      const res = await signupPost(request);
      expect(res.status).toBe(201);
      expect(mockSignUp).toHaveBeenCalledTimes(1);
      return mockSignUp.mock.calls[0][0] as {
        options?: { emailRedirectTo?: string };
      };
    }

    it("1순위: 서버 런타임 APP_URL이 설정된 경우 프록시/조작 헤더를 무시하고 APP_URL을 사용한다", async () => {
      process.env.K_SERVICE = "hujimap-staging";
      process.env.APP_URL = "https://staging.hujimap.kr";
      process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";

      const call = await invokeSignup(
        new Request("http://0.0.0.0:8080/api/v1/auth/signup", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            host: "evil.example.com",
            "x-forwarded-host": "evil.example.com",
            "x-forwarded-proto": "https",
          },
          body: JSON.stringify({
            email: "user@example.com",
            password: "Password123!",
            termsAccepted: true,
          }),
        })
      );

      expect(call.options?.emailRedirectTo).toBe(
        "https://staging.hujimap.kr/login"
      );
    });

    it("Cloud Run 환경에서 APP_URL이 없어도 검증된 Cloud Run HTTPS 도메인으로 리다이렉트한다", async () => {
      process.env.K_SERVICE = "hujimap-staging";
      // 빌드 시점 NEXT_PUBLIC_APP_URL이 localhost로 남아있어도 Cloud Run에서는 무시됨
      process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";

      const call = await invokeSignup(
        new Request("http://0.0.0.0:8080/api/v1/auth/signup", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            host: "hujimap-staging-abc123-du.a.run.app",
            "x-forwarded-proto": "https",
          },
          body: JSON.stringify({
            email: "user2@example.com",
            password: "Password123!",
            termsAccepted: true,
          }),
        })
      );

      expect(call.options?.emailRedirectTo).toBe(
        "https://hujimap-staging-abc123-du.a.run.app/login"
      );
    });

    it("조작된 Host / X-Forwarded-Host 도메인(evil.example.com)은 emailRedirectTo에 절대 허용하지 않는다", async () => {
      process.env.K_SERVICE = "hujimap-staging";

      // Case A: Cloud Run에서 X-Forwarded-Host가 허용되지 않은 외부 도메인인 경우
      const callA = await invokeSignup(
        new Request("http://0.0.0.0:8080/api/v1/auth/signup", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            host: "hujimap-staging-abc123-du.a.run.app",
            "x-forwarded-host": "evil.example.com",
            "x-forwarded-proto": "https",
          },
          body: JSON.stringify({
            email: "victim1@example.com",
            password: "Password123!",
            termsAccepted: true,
          }),
        })
      );
      expect(callA.options?.emailRedirectTo).toBeUndefined();

      // Case B: 로컬/비프록시 환경에서 Host 헤더만 조작된 경우
      delete process.env.K_SERVICE;
      const callB = await invokeSignup(
        new Request("https://evil.example.com/api/v1/auth/signup", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            host: "evil.example.com",
            "x-forwarded-host": "evil.example.com",
            "x-forwarded-proto": "https",
          },
          body: JSON.stringify({
            email: "victim2@example.com",
            password: "Password123!",
            termsAccepted: true,
          }),
        })
      );
      expect(callB.options?.emailRedirectTo).toBeUndefined();
    });

    it("로컬 개발 환경(localhost)에서 인증 리다이렉트가 정상 동작하고 미신뢰 forwarded 헤더는 무시한다", async () => {
      const call = await invokeSignup(
        new Request("http://localhost:3000/api/v1/auth/signup", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            host: "localhost:3000",
            "x-forwarded-host": "evil.example.com",
            "x-forwarded-proto": "https",
          },
          body: JSON.stringify({
            email: "local@example.com",
            password: "Password123!",
            termsAccepted: true,
          }),
        })
      );

      expect(call.options?.emailRedirectTo).toBe("http://localhost:3000/login");
    });

    it("ALLOWED_APP_HOSTS 화이트리스트 설정 시 지정된 호스트의 HTTPS 요청만 허용한다", async () => {
      process.env.K_SERVICE = "hujimap-staging";
      process.env.ALLOWED_APP_HOSTS = "custom.hujimap.kr";

      const allowedCall = await invokeSignup(
        new Request("https://custom.hujimap.kr/api/v1/auth/signup", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            host: "custom.hujimap.kr",
          },
          body: JSON.stringify({
            email: "custom@example.com",
            password: "Password123!",
            termsAccepted: true,
          }),
        })
      );
      expect(allowedCall.options?.emailRedirectTo).toBe(
        "https://custom.hujimap.kr/login"
      );

      const blockedCall = await invokeSignup(
        new Request("http://0.0.0.0:8080/api/v1/auth/signup", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            host: "unlisted-app.a.run.app",
            "x-forwarded-proto": "https",
          },
          body: JSON.stringify({
            email: "unlisted@example.com",
            password: "Password123!",
            termsAccepted: true,
          }),
        })
      );
      expect(blockedCall.options?.emailRedirectTo).toBeUndefined();
    });
  });

  describe("4. 배포 설정 정적 점검 (Dockerfile, .dockerignore, cloudbuild.yaml, next.config.mjs)", () => {
    const rootDir = process.cwd();

    it("next.config.mjs에 output: standalone이 설정되어 있다", () => {
      const nextConfig = fs.readFileSync(
        path.join(rootDir, "next.config.mjs"),
        "utf8"
      );
      expect(nextConfig).toContain('output: "standalone"');
    });

    it("Dockerfile이 multi-stage, PORT=8080, 0.0.0.0, npm ci를 사용하고 비밀키를 하드코딩하지 않는다", () => {
      const dockerfile = fs.readFileSync(
        path.join(rootDir, "Dockerfile"),
        "utf8"
      );
      const nonCommentLines = dockerfile
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n");

      expect(nonCommentLines).toContain("npm ci");
      expect(nonCommentLines).toContain("PORT=8080");
      expect(nonCommentLines).toContain("HOSTNAME=0.0.0.0");
      expect(nonCommentLines).toContain('CMD ["node", "server.js"]');
      expect(nonCommentLines).not.toContain("SUPABASE_SECRET_KEY");
      expect(nonCommentLines).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
      expect(nonCommentLines).not.toContain("TOSS_TEST_SECRET_KEY");
      expect(nonCommentLines).not.toContain("PIN_ENCRYPTION_KEY_BASE64");
      expect(nonCommentLines).not.toContain("live_");
    });

    it(".dockerignore가 민감 파일(.env.local, local-data, .git, DB 백업)을 제외한다", () => {
      const dockerignore = fs.readFileSync(
        path.join(rootDir, ".dockerignore"),
        "utf8"
      );
      expect(dockerignore).toContain(".env.*");
      expect(dockerignore).toContain("local-data");
      expect(dockerignore).toContain(".git");
      expect(dockerignore).toContain("*.sql");
      expect(dockerignore).toContain("*.dump");
    });

    it("cloudbuild.yaml이 리전/스펙/Secret Manager를 설정하고 live 결제 및 하드코딩 프로젝트 ID를 포함하지 않는다", () => {
      const cloudbuild = fs.readFileSync(
        path.join(rootDir, "cloudbuild.yaml"),
        "utf8"
      );
      expect(cloudbuild).toContain("asia-northeast3");
      expect(cloudbuild).toContain("--cpu=1");
      expect(cloudbuild).toContain("--memory=1Gi");
      expect(cloudbuild).toContain("--min-instances=0");
      expect(cloudbuild).toContain("--max-instances=2");
      expect(cloudbuild).toContain("--set-secrets=");
      expect(cloudbuild).toContain("SUPABASE_SECRET_KEY=");
      expect(cloudbuild).toContain("TOSS_TEST_SECRET_KEY=");
      expect(cloudbuild).toContain("PIN_ENCRYPTION_KEY_BASE64=");
      expect(cloudbuild).toContain("$PROJECT_ID");
      expect(cloudbuild).toContain("${COMMIT_SHA}");
      expect(cloudbuild).toContain('_PAYMENT_MODE: "disabled"');
    });

    it("src/app/(public)/restrooms/[id]/page.tsx가 인라인 VERCEL_ENV 우회 대신 공용 가드를 사용한다", () => {
      const pageSource = fs.readFileSync(
        path.join(rootDir, "src/app/(public)/restrooms/[id]/page.tsx"),
        "utf8"
      );
      expect(pageSource).toContain("isE2eMockEnvironmentEnabled()");
      expect(pageSource).not.toContain('process.env.VERCEL_ENV !== "production"');
    });
  });
});

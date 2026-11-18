/**
 * E2E Test Mock Session Security Guard
 *
 * Protects against accidental or malicious activation of test-mock authentication:
 * 1. Strictly disabled in standard production runtime (ALLOW_E2E_MOCK !== "1").
 * 2. Strictly disabled in recognized cloud hosting platforms (Vercel production, Google Cloud Run K_SERVICE/CLOUD_RUN_JOB).
 * 3. Never activated in standard dev mode unless ALLOW_E2E_MOCK="1" is explicitly supplied by the local test runner.
 * 4. API routes for business/payment/PIN NEVER use this guard; only isolated test harnesses use it.
 */

export function isCloudDeploymentRuntime(): boolean {
  if (
    process.env.VERCEL_ENV === "production" ||
    process.env.NEXT_PUBLIC_VERCEL_ENV === "production"
  ) {
    return true;
  }

  // Google Cloud Run injects K_SERVICE for services and CLOUD_RUN_JOB for jobs.
  if (
    Boolean(process.env.K_SERVICE?.trim()) ||
    Boolean(process.env.CLOUD_RUN_JOB?.trim())
  ) {
    return true;
  }

  return false;
}

export function isE2eMockEnvironmentEnabled(): boolean {
  if (process.env.ALLOW_E2E_MOCK !== "1") {
    return false;
  }

  if (isCloudDeploymentRuntime()) {
    return false;
  }

  return true;
}

export function isE2eMockSessionAllowed(cookieValue?: string | null): boolean {
  if (!isE2eMockEnvironmentEnabled()) {
    return false;
  }

  return cookieValue === "1";
}


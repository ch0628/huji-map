/**
 * E2E Test Mock Session Security Guard
 * 
 * Protects against accidental or malicious activation of test-mock authentication:
 * 1. Strictly disabled in standard production runtime (ALLOW_E2E_MOCK !== "1").
 * 2. Strictly disabled in recognized production hosting platforms (e.g., Vercel production).
 * 3. Never activated in standard dev mode unless ALLOW_E2E_MOCK="1" is explicitly supplied by the test runner.
 * 4. API routes NEVER use this guard; it is only for local isolated browser UI rendering in test harnesses.
 */

export function isE2eMockSessionAllowed(cookieValue?: string | null): boolean {
  if (process.env.ALLOW_E2E_MOCK !== "1") {
    return false;
  }

  // Defend against misconfiguration on production cloud hosts
  if (process.env.VERCEL_ENV === "production" || process.env.NEXT_PUBLIC_VERCEL_ENV === "production") {
    return false;
  }

  return cookieValue === "1";
}


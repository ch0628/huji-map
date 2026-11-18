import { z } from "zod";

export const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "이메일 주소를 입력해 주세요.")
    .email("올바른 이메일 주소를 입력해 주세요."),
  password: z
    .string()
    .min(8, "비밀번호는 8자 이상 입력해 주세요.")
    .max(72, "비밀번호는 72자 이하로 입력해 주세요."),
  returnTo: z.string().optional(),
});

export const signupSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "이메일 주소를 입력해 주세요.")
    .email("올바른 이메일 주소를 입력해 주세요."),
  password: z
    .string()
    .min(8, "비밀번호는 8자 이상 입력해 주세요.")
    .max(72, "비밀번호는 72자 이하로 입력해 주세요."),
  displayName: z
    .string()
    .trim()
    .max(40, "닉네임(표시 이름)은 40자 이하로 입력해 주세요.")
    .optional(),
  termsAccepted: z.boolean().refine((val) => val === true, {
    message: "서비스 이용약관 및 개인정보 처리 안내에 동의해 주세요.",
  }),
  returnTo: z.string().optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type SignupInput = z.infer<typeof signupSchema>;

/**
 * Prevents open redirects and preserves safe internal paths.
 * Defaults to `/map` as the primary guest/user entry screen.
 */
export function sanitizeReturnTo(returnTo?: string | null): string {
  if (!returnTo || typeof returnTo !== "string") {
    return "/map";
  }
  const trimmed = returnTo.trim();
  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/\\") ||
    trimmed.includes("://")
  ) {
    return "/map";
  }
  return trimmed;
}

/**
 * Redacts emails, passwords, tokens, and secret keys from any message.
 * AGENTS.md Rules 8, 13 & TASK 04: Never expose PII, credentials, or keys in responses or logs.
 */
export function redactAuthSensitiveText(input: string): string {
  if (!input) return "";
  return input
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[REDACTED_EMAIL]")
    .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[REDACTED_TOKEN]")
    .replace(/sb_(secret|publishable)_[a-zA-Z0-9_-]+/g, "[REDACTED_KEY]")
    .replace(/(password|passwd|secret|token)\s*[:=]\s*\S+/gi, "$1=[REDACTED]");
}

interface IdempotencyRecord {
  expiresAt: number;
  payloadHash: string;
  response?: {
    status: number;
    body: any;
  };
}

const IDEMPOTENCY_TTL_MS = 10_000;
const idempotencyStore = new Map<string, IdempotencyRecord>();

export interface IdempotencyCheckResult {
  isDuplicate: boolean;
  action: "proceed" | "replay" | "conflict";
  cachedResponse?: {
    status: number;
    body: any;
  };
}

function hashPayload(payload: any): string {
  const str = typeof payload === "string" ? payload : JSON.stringify(payload);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/**
 * Checks and records an idempotency key for server write requests.
 * Supports exact body replay and differing payload 409 conflict detection.
 * AGENTS.md Rule 13: Prevent duplicate write submissions.
 */
export function checkIdempotencyKey(
  key: string | null | undefined,
  scope: string,
  payload?: any
): IdempotencyCheckResult {
  if (!key || typeof key !== "string" || key.trim().length === 0) {
    return { isDuplicate: false, action: "proceed" };
  }

  const now = Date.now();
  for (const [k, entry] of idempotencyStore.entries()) {
    if (entry.expiresAt <= now) {
      idempotencyStore.delete(k);
    }
  }

  const scopedKey = `${scope}:${key.trim().slice(0, 128)}`;
  const currentHash = payload !== undefined ? hashPayload(payload) : "";

  const existing = idempotencyStore.get(scopedKey);
  if (existing && existing.expiresAt > now) {
    // If payload is supplied and differs from original payload hash -> 409 conflict
    if (currentHash && existing.payloadHash && existing.payloadHash !== currentHash) {
      return { isDuplicate: true, action: "conflict" };
    }

    // If cached response exists and payload matches -> replay previous result
    if (existing.response) {
      return {
        isDuplicate: true,
        action: "replay",
        cachedResponse: existing.response,
      };
    }

    // Still in flight with same payload
    return { isDuplicate: true, action: "conflict" };
  }

  idempotencyStore.set(scopedKey, {
    expiresAt: now + IDEMPOTENCY_TTL_MS,
    payloadHash: currentHash,
  });

  return { isDuplicate: false, action: "proceed" };
}

/**
 * Records successful response for an idempotency key to enable replays.
 */
export function recordIdempotencyResponse(
  key: string | null | undefined,
  scope: string,
  status: number,
  body: any
): void {
  if (!key || typeof key !== "string" || key.trim().length === 0) return;
  const scopedKey = `${scope}:${key.trim().slice(0, 128)}`;
  const existing = idempotencyStore.get(scopedKey);
  if (existing) {
    existing.response = { status, body };
  }
}

export function clearIdempotencyStoreForTests(): void {
  idempotencyStore.clear();
}


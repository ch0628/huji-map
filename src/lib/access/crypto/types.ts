/**
 * Restroom Lock Secret Types & Contracts
 * Spec: docs/03_DATA_MODEL.md line 266, docs/04_API_CONTRACT.md line 44,
 *       docs/07_PAYMENT_ACCESS_REFUND.md, docs/08_SECURITY_OPERATIONS.md line 8,
 *       tasks/23_pin_storage.md
 */

import { z } from "zod";

export const LOCK_SECRET_STATUSES = ["active", "rotated", "revoked"] as const;
export type LockSecretStatus = (typeof LOCK_SECRET_STATUSES)[number];

export interface RestroomLockSecretRow {
  id: string; // uuid PK
  restroom_id: string; // uuid FK to restrooms(id)
  ciphertext_b64: string;
  iv_b64: string;
  auth_tag_b64: string;
  key_version: number;
  code_version: number;
  valid_from: string;
  valid_until: string | null;
  status: LockSecretStatus;
  created_by: string; // uuid FK to profiles(id)
  created_at: string;
}

export interface EncryptedPinPayload {
  ciphertext_b64: string;
  iv_b64: string;
  auth_tag_b64: string;
  key_version: number;
}

/**
 * Public/Safe API response for PIN registration and rotation.
 * Invariant: NEVER contains pin, ciphertext, iv, auth_tag, or encryption key.
 */
export interface SetPinResponse {
  ok: true;
  codeVersion: number;
  updatedAt: string;
  requestId: string;
}

/**
 * Authorized merchant/admin PIN inspection response (Cache-Control: no-store only).
 */
export interface GetMerchantPinResponse {
  ok: true;
  pin: string;
  codeVersion: number;
  updatedAt: string;
  requestId: string;
}

/**
 * Zod Schema for 점주 PIN 입력 검증.
 * Doorlock PIN: 4~20 characters of digits and standard symbols (*, #).
 */
export const setRestroomPinSchema = z.object({
  pin: z
    .string()
    .trim()
    .min(4, "도어락 비밀번호는 최소 4자리 이상이어야 합니다.")
    .max(20, "도어락 비밀번호는 최대 20자리 이하이어야 합니다.")
    .regex(/^[0-9*#]+$/, "도어락 비밀번호는 숫자와 *, # 기호만 사용할 수 있습니다."),
});

export type SetRestroomPinInput = z.infer<typeof setRestroomPinSchema>;

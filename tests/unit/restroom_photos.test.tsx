/** @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const {
  mockCreateAdminClient,
  mockIsServiceRoleConfigured,
  mockCreateServerClientInstance,
  mockRequireAuth,
  mockRequireRole,
  mockIsSupabaseAuthConfigured,
  mockPush,
} = vi.hoisted(() => ({
  mockCreateAdminClient: vi.fn(),
  mockIsServiceRoleConfigured: vi.fn(() => true),
  mockCreateServerClientInstance: vi.fn(),
  mockRequireAuth: vi.fn(),
  mockRequireRole: vi.fn(),
  mockIsSupabaseAuthConfigured: vi.fn(() => true),
  mockPush: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: mockCreateAdminClient,
  isServiceRoleConfigured: mockIsServiceRoleConfigured,
  createServerClientInstance: mockCreateServerClientInstance,
}));

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    isSupabaseAuthConfigured: mockIsSupabaseAuthConfigured,
    requireAuth: mockRequireAuth,
    requireRole: mockRequireRole,
  };
});

vi.mock("@/lib/events/hooks", () => ({
  useEventTracker: () => ({
    trackDetailOpened: vi.fn(),
    trackDirectionsClicked: vi.fn(),
    trackCardViewed: vi.fn(),
    trackPaymentClicked: vi.fn(),
  }),
}));

import {
  MAX_RESTROOM_PHOTOS,
  MAX_RESTROOM_PHOTO_BYTES,
  verifyRestroomPhotoMagicBytes,
  createRestroomPhotoUploadIntentSchema,
  registerRestroomPhotoSchema,
  RestroomPhotoError,
} from "@/lib/restrooms/photo-validation";
import {
  createRestroomPhotoUploadIntent,
  registerMerchantRestroomPhoto,
  deleteMerchantRestroomPhoto,
} from "@/lib/restrooms/photo-service";
import {
  decideRestroomReview,
  decideRestroomPhotoReplacement,
} from "@/lib/restrooms/admin-service";
import { POST as uploadIntentRoute } from "@/app/api/v1/merchant/restrooms/[id]/photos/upload-intent/route";
import { POST as registerPhotoRoute } from "@/app/api/v1/merchant/restrooms/[id]/photos/route";
import { DELETE as deletePhotoRoute } from "@/app/api/v1/merchant/restrooms/[id]/photos/[photoId]/route";
import { POST as adminPhotoDecisionRoute } from "@/app/api/v1/admin/restrooms/[id]/photos/[photoId]/decision/route";
import RestroomForm from "@/components/restroom/RestroomForm";
import RestroomPhotoManager from "@/components/restroom/RestroomPhotoManager";
import AdminRestroomsClient from "@/app/admin/restrooms/AdminRestroomsClient";
import PublicRestroomCard from "@/components/restroom/PublicRestroomCard";
import PublicRestroomDetailView from "@/components/restroom/PublicRestroomDetailView";
import { AuthGuardError } from "@/lib/auth";

const VALID_RESTROOM_ID = "11111111-1111-4111-8111-111111111111";
const VALID_BUSINESS_ID = "22222222-2222-4222-8222-222222222222";
const VALID_USER_ID = "33333333-3333-4333-8333-333333333333";
const VALID_ADMIN_ID = "44444444-4444-4444-8444-444444444444";
const VALID_PHOTO_ID = "55555555-5555-4555-8555-555555555555";
const VALID_OLD_PHOTO_ID = "66666666-6666-4666-8666-666666666666";

function makeJpegBytes(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
}

function makePngBytes(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
}

function makeWebpBytes(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
}

function createMerchantSupabaseMock(opts?: {
  restroomType?: "partner" | "public";
  bizStatus?: string;
  activeMember?: boolean;
}) {
  const restroomType = opts?.restroomType ?? "partner";
  const bizStatus = opts?.bizStatus ?? "approved";
  const activeMember = opts?.activeMember ?? true;

  return {
    from: vi.fn((table: string) => {
      if (table === "restrooms") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              id: VALID_RESTROOM_ID,
              business_id: restroomType === "partner" ? VALID_BUSINESS_ID : null,
              type: restroomType,
              name: "테스트 제휴 화장실",
              publication_status: "published",
              road_address: "경기도 수원시 팔달구 매산로 1",
              latitude: 37.2659,
              longitude: 127.0001,
            },
            error: null,
          }),
        };
      }
      if (table === "businesses") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: { id: VALID_BUSINESS_ID, registration_status: bizStatus },
            error: null,
          }),
        };
      }
      if (table === "business_members") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: activeMember
              ? { role: "owner", membership_status: "active" }
              : null,
            error: null,
          }),
        };
      }
      return {};
    }),
  };
}

describe("STEP 3 Restroom Photos — Validation, Service, Routes & UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsServiceRoleConfigured.mockReturnValue(true);
    mockIsSupabaseAuthConfigured.mockReturnValue(true);
    globalThis.URL.createObjectURL = vi.fn(() => "blob:http://localhost/mock-preview");
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  describe("1. Validation & Magic Bytes", () => {
    it("accepts valid JPEG, PNG, WebP magic bytes and rejects spoofed text/SVG", () => {
      expect(verifyRestroomPhotoMagicBytes(makeJpegBytes(), "image/jpeg")).toBe(true);
      expect(verifyRestroomPhotoMagicBytes(makePngBytes(), "image/png")).toBe(true);
      expect(verifyRestroomPhotoMagicBytes(makeWebpBytes(), "image/webp")).toBe(true);

      const fakeSvg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
      expect(verifyRestroomPhotoMagicBytes(fakeSvg, "image/jpeg")).toBe(false);
      expect(verifyRestroomPhotoMagicBytes(makePngBytes(), "image/jpeg")).toBe(false);
    });

    it("enforces 10MB file size limit and allowed MIME types", () => {
      expect(
        createRestroomPhotoUploadIntentSchema.safeParse({
          mimeType: "image/jpeg",
          fileSizeBytes: MAX_RESTROOM_PHOTO_BYTES,
          photoType: "entrance",
          isPrimary: true,
        }).success
      ).toBe(true);

      expect(
        createRestroomPhotoUploadIntentSchema.safeParse({
          mimeType: "image/gif",
          fileSizeBytes: 1024,
        }).success
      ).toBe(false);

      expect(
        createRestroomPhotoUploadIntentSchema.safeParse({
          mimeType: "image/png",
          fileSizeBytes: MAX_RESTROOM_PHOTO_BYTES + 1,
        }).success
      ).toBe(false);

      expect(
        registerRestroomPhotoSchema.safeParse({
          storagePath: `restrooms/${VALID_RESTROOM_ID}/a.jpg`,
          mimeType: "image/jpeg",
          photoType: "interior",
          isPrimary: false,
        }).success
      ).toBe(true);
    });
  });

  describe("2. Service Layer — Upload Intent, Registration & Deletion", () => {
    it("blocks non-member (403) and public restrooms (403) from creating upload intent", async () => {
      const nonMemberClient = createMerchantSupabaseMock({ activeMember: false });
      await expect(
        createRestroomPhotoUploadIntent({
          supabase: nonMemberClient as any,
          userId: VALID_USER_ID,
          restroomId: VALID_RESTROOM_ID,
          input: {
            mimeType: "image/jpeg",
            fileSizeBytes: 1024,
            photoType: "entrance",
            isPrimary: true,
          },
        })
      ).rejects.toMatchObject({ statusCode: 403, code: "MEMBERSHIP_REQUIRED" });

      const publicRestroomClient = createMerchantSupabaseMock({ restroomType: "public" });
      await expect(
        createRestroomPhotoUploadIntent({
          supabase: publicRestroomClient as any,
          userId: VALID_USER_ID,
          restroomId: VALID_RESTROOM_ID,
          input: {
            mimeType: "image/jpeg",
            fileSizeBytes: 1024,
            photoType: "entrance",
            isPrimary: true,
          },
        })
      ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN_PUBLIC_RESTROOM" });
    });

    it("enforces max 3 photos limit for non-replacement uploads but allows replacement of approved photo", async () => {
      const supabase = createMerchantSupabaseMock();
      const existingRows = [
        { id: VALID_OLD_PHOTO_ID, is_primary: true, moderation_status: "approved", replaces_photo_id: null },
        { id: "77777777-7777-4777-8777-777777777777", is_primary: false, moderation_status: "approved", replaces_photo_id: null },
        { id: "88888888-8888-4888-8888-888888888888", is_primary: false, moderation_status: "approved", replaces_photo_id: null },
      ];

      const createSignedUploadUrl = vi.fn().mockResolvedValue({
        data: { signedUrl: "http://127.0.0.1:54321/upload/sign/test", token: "tok" },
        error: null,
      });

      mockCreateAdminClient.mockReturnValue({
        from: vi.fn(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockResolvedValue({ data: existingRows, error: null }),
        })),
        storage: {
          from: vi.fn(() => ({ createSignedUploadUrl })),
        },
      });

      // Adding 4th photo blocked
      await expect(
        createRestroomPhotoUploadIntent({
          supabase: supabase as any,
          userId: VALID_USER_ID,
          restroomId: VALID_RESTROOM_ID,
          input: {
            mimeType: "image/jpeg",
            fileSizeBytes: 2048,
            photoType: "interior",
            isPrimary: false,
          },
        })
      ).rejects.toMatchObject({ statusCode: 422, code: "PHOTO_LIMIT_EXCEEDED" });

      // Replacing one of the 3 approved photos is allowed
      const intent = await createRestroomPhotoUploadIntent({
        supabase: supabase as any,
        userId: VALID_USER_ID,
        restroomId: VALID_RESTROOM_ID,
        input: {
          mimeType: "image/jpeg",
          fileSizeBytes: 2048,
          photoType: "entrance",
          isPrimary: false,
          replacesPhotoId: VALID_OLD_PHOTO_ID,
        },
      });

      expect(intent.storagePath).toMatch(new RegExp(`^restrooms/${VALID_RESTROOM_ID}/.*\\.jpg$`));
      expect(intent.uploadUrl).toContain("upload/sign/test");
    });

    it("rejects spoofed storage path and deletes spoofed magic-byte files from Storage", async () => {
      const supabase = createMerchantSupabaseMock();

      await expect(
        registerMerchantRestroomPhoto({
          supabase: supabase as any,
          userId: VALID_USER_ID,
          restroomId: VALID_RESTROOM_ID,
          input: {
            storagePath: "restrooms/99999999-9999-4999-8999-999999999999/bad.jpg",
            mimeType: "image/jpeg",
            photoType: "entrance",
            isPrimary: false,
          },
        })
      ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });

      const removeMock = vi.fn().mockResolvedValue({ data: [], error: null });
      mockCreateAdminClient.mockReturnValue({
        storage: {
          from: vi.fn(() => ({
            download: vi.fn().mockResolvedValue({
              data: new Blob([Buffer.from("not-an-image-at-all")]),
              error: null,
            }),
            remove: removeMock,
          })),
        },
      });

      const targetPath = `restrooms/${VALID_RESTROOM_ID}/fake.jpg`;
      await expect(
        registerMerchantRestroomPhoto({
          supabase: supabase as any,
          userId: VALID_USER_ID,
          restroomId: VALID_RESTROOM_ID,
          input: {
            storagePath: targetPath,
            mimeType: "image/jpeg",
            photoType: "entrance",
            isPrimary: false,
          },
        })
      ).rejects.toMatchObject({ statusCode: 400, code: "INVALID_FILE_CONTENT" });

      expect(removeMock).toHaveBeenCalledWith([targetPath]);
    });

    it("registers valid photo and cleans up Storage when pending photo is deleted", async () => {
      const supabase = createMerchantSupabaseMock();
      const targetPath = `restrooms/${VALID_RESTROOM_ID}/real.png`;
      const removeMock = vi.fn().mockResolvedValue({ data: [], error: null });

      mockCreateAdminClient.mockReturnValue({
        storage: {
          from: vi.fn(() => ({
            download: vi.fn().mockResolvedValue({
              data: new Blob([makePngBytes()]),
              error: null,
            }),
            createSignedUrls: vi.fn().mockResolvedValue({
              data: [{ path: targetPath, signedUrl: "http://127.0.0.1:54321/signed/real.png" }],
              error: null,
            }),
            remove: removeMock,
          })),
        },
        rpc: vi.fn((fn: string) => {
          if (fn === "register_merchant_restroom_photo") {
            return Promise.resolve({
              data: {
                ok: true,
                photo: {
                  id: VALID_PHOTO_ID,
                  restroom_id: VALID_RESTROOM_ID,
                  storage_path: targetPath,
                  photo_type: "entrance",
                  is_primary: true,
                  moderation_status: "pending",
                  uploaded_by: VALID_USER_ID,
                  replaces_photo_id: null,
                  created_at: "2026-11-20T00:00:00Z",
                },
              },
              error: null,
            });
          }
          if (fn === "delete_merchant_restroom_photo") {
            return Promise.resolve({
              data: {
                ok: true,
                deleted: { id: VALID_PHOTO_ID, storage_path: targetPath },
              },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        }),
      });

      const registered = await registerMerchantRestroomPhoto({
        supabase: supabase as any,
        userId: VALID_USER_ID,
        restroomId: VALID_RESTROOM_ID,
        input: {
          storagePath: targetPath,
          mimeType: "image/png",
          photoType: "entrance",
          isPrimary: true,
        },
      });

      expect(registered.moderation_status).toBe("pending");
      expect(registered.image_url).toBe("http://127.0.0.1:54321/signed/real.png");

      const deleted = await deleteMerchantRestroomPhoto({
        supabase: supabase as any,
        userId: VALID_USER_ID,
        restroomId: VALID_RESTROOM_ID,
        photoId: VALID_PHOTO_ID,
      });

      expect(deleted.deletedId).toBe(VALID_PHOTO_ID);
      expect(removeMock).toHaveBeenCalledWith([targetPath]);
    });
  });

  describe("3. API Routes & Admin Integrated/Replacement Decision", () => {
    it("blocks unauthenticated and non-admin callers on photo endpoints", async () => {
      mockCreateServerClientInstance.mockResolvedValue({});
      mockRequireAuth.mockRejectedValueOnce(
        new AuthGuardError("UNAUTHORIZED", 401, "로그인이 필요합니다.")
      );

      const unauthIntentRes = await uploadIntentRoute(
        new Request("http://localhost/api/v1/merchant/restrooms/x/photos/upload-intent", {
          method: "POST",
          body: JSON.stringify({ mimeType: "image/jpeg", fileSizeBytes: 1024 }),
        }),
        { params: Promise.resolve({ id: VALID_RESTROOM_ID }) }
      );
      expect(unauthIntentRes.status).toBe(401);

      mockRequireAuth.mockRejectedValueOnce(
        new AuthGuardError("UNAUTHORIZED", 401, "로그인이 필요합니다.")
      );
      const unauthRegRes = await registerPhotoRoute(
        new Request("http://localhost/api/v1/merchant/restrooms/x/photos", {
          method: "POST",
          body: JSON.stringify({}),
        }),
        { params: Promise.resolve({ id: VALID_RESTROOM_ID }) }
      );
      expect(unauthRegRes.status).toBe(401);

      mockRequireAuth.mockRejectedValueOnce(
        new AuthGuardError("UNAUTHORIZED", 401, "로그인이 필요합니다.")
      );
      const unauthDelRes = await deletePhotoRoute(
        new Request("http://localhost/api/v1/merchant/restrooms/x/photos/y", {
          method: "DELETE",
        }),
        { params: Promise.resolve({ id: VALID_RESTROOM_ID, photoId: VALID_PHOTO_ID }) }
      );
      expect(unauthDelRes.status).toBe(401);

      mockRequireRole.mockRejectedValueOnce(
        new AuthGuardError("FORBIDDEN", 403, "관리자 권한이 없습니다.")
      );
      const forbiddenAdminRes = await adminPhotoDecisionRoute(
        new Request("http://localhost/api/v1/admin/restrooms/x/photos/y/decision", {
          method: "POST",
          body: JSON.stringify({ decision: "approve" }),
        }),
        { params: Promise.resolve({ id: VALID_RESTROOM_ID, photoId: VALID_PHOTO_ID }) }
      );
      expect(forbiddenAdminRes.status).toBe(403);
    });

    it("requires rejection reason (>= 2 chars) on photo replacement rejection", async () => {
      mockCreateServerClientInstance.mockResolvedValue({});
      mockRequireRole.mockResolvedValue({ user: { id: VALID_ADMIN_ID }, isAdmin: true });

      const res = await adminPhotoDecisionRoute(
        new Request("http://localhost/api/v1/admin/restrooms/x/photos/y/decision", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-idempotency-key": crypto.randomUUID(),
          },
          body: JSON.stringify({ decision: "reject", reason: "짧" }),
        }),
        { params: Promise.resolve({ id: VALID_RESTROOM_ID, photoId: VALID_PHOTO_ID }) }
      );
      expect(res.status).toBe(400);
    });

    it("executes integrated publish (restroom + pending photos) and A-plan replacement approve/reject", async () => {
      const photoUpdates: Array<{ id?: string; payload: any }> = [];
      const supabaseMock = {
        from: vi.fn((table: string) => {
          if (table === "restrooms") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  id: VALID_RESTROOM_ID,
                  type: "partner",
                  business_id: VALID_BUSINESS_ID,
                  publication_status: "pending",
                  name: "화장실",
                  road_address: "수원시 팔달구 1",
                  latitude: 37.26,
                  longitude: 127.0,
                },
                error: null,
              }),
              update: vi.fn(() => ({
                eq: vi.fn().mockReturnThis(),
                select: vi.fn().mockReturnThis(),
                single: vi.fn().mockResolvedValue({
                  data: { id: VALID_RESTROOM_ID, publication_status: "published" },
                  error: null,
                }),
              })),
            };
          }
          if (table === "businesses") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: { id: VALID_BUSINESS_ID, registration_status: "approved" },
                error: null,
              }),
            };
          }
          if (table === "restroom_access_policies") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: { id: "pol-1", is_active: true },
                error: null,
              }),
            };
          }
          if (table === "restroom_photos") {
            return {
              update: vi.fn((payload: any) => {
                photoUpdates.push({ payload });
                return {
                  eq: vi.fn().mockReturnThis(),
                };
              }),
            };
          }
          if (table === "audit_logs") {
            return { insert: vi.fn().mockResolvedValue({ error: null }) };
          }
          return {};
        }),
      };

      const published = await decideRestroomReview(
        supabaseMock as any,
        VALID_ADMIN_ID,
        VALID_RESTROOM_ID,
        { decision: "publish" }
      );
      expect(published.publication_status).toBe("published");
      expect(photoUpdates.some((u) => u.payload.moderation_status === "approved")).toBe(true);

      // Post-approval replacement approve
      const rpcAdminMock = {
        rpc: vi.fn().mockResolvedValue({
          data: {
            id: VALID_PHOTO_ID,
            restroom_id: VALID_RESTROOM_ID,
            storage_path: `restrooms/${VALID_RESTROOM_ID}/new.jpg`,
            photo_type: "entrance",
            is_primary: true,
            moderation_status: "approved",
            replaces_photo_id: null,
          },
          error: null,
        }),
      };

      const replaced = await decideRestroomPhotoReplacement(
        rpcAdminMock as any,
        VALID_ADMIN_ID,
        VALID_RESTROOM_ID,
        VALID_PHOTO_ID,
        { decision: "approve" }
      );
      expect(replaced.moderation_status).toBe("approved");
      expect(replaced.is_primary).toBe(true);
    });
  });

  describe("4. UI Integration — Create Form, Manage, Admin Preview & Public Display", () => {
    it("allows attaching a photo in RestroomForm (create mode) and uploads it after creating restroom", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          data: { id: VALID_RESTROOM_ID, name: "사진포함 화장실", publication_status: "draft" },
        }),
      });
      globalThis.fetch = fetchMock as any;

      const photoUploadFn = vi.fn().mockResolvedValue({
        id: VALID_PHOTO_ID,
        restroom_id: VALID_RESTROOM_ID,
        storage_path: `restrooms/${VALID_RESTROOM_ID}/pic.jpg`,
        photo_type: "entrance",
        is_primary: true,
        moderation_status: "pending",
      });
      const onSuccess = vi.fn();

      render(
        <RestroomForm
          businessId={VALID_BUSINESS_ID}
          mode="create"
          addressSearchFn={async () => [
            {
              id: "addr-1",
              roadAddress: "경기도 수원시 팔달구 매산로 1",
              jibunAddress: "경기도 수원시 팔달구 매산로1가 18",
              displayAddress: "경기도 수원시 팔달구 매산로 1",
              buildingName: "테스트 빌딩",
              lat: 37.2659,
              lng: 127.0001,
              source: "road",
            },
          ]}
          photoUploadFn={photoUploadFn}
          onSuccess={onSuccess}
        />
      );

      // Select address
      fireEvent.change(screen.getByTestId("address-search-input"), {
        target: { value: "매산로 1" },
      });
      fireEvent.click(screen.getByTestId("address-search-button"));
      await waitFor(() =>
        expect(screen.getByTestId("address-search-result-0")).toBeInTheDocument()
      );
      fireEvent.click(screen.getByTestId("address-search-result-0"));

      // Enter name
      fireEvent.change(screen.getByLabelText(/화장실 이름/), {
        target: { value: "1층 제휴 화장실" },
      });

      // Attach valid JPEG file
      const file = new File([makeJpegBytes()], "entrance.jpg", { type: "image/jpeg" });
      fireEvent.change(screen.getByTestId("restroom-photo-file-input"), {
        target: { files: [file] },
      });

      await waitFor(() => expect(screen.getByText("1/3")).toBeInTheDocument());

      // Submit form
      fireEvent.click(screen.getByTestId("restroom-form-submit-button"));

      await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
      expect(photoUploadFn).toHaveBeenCalledTimes(1);
      expect(photoUploadFn).toHaveBeenCalledWith(
        expect.objectContaining({
          restroomId: VALID_RESTROOM_ID,
          isPrimary: true,
          replacesPhotoId: null,
        })
      );
      expect(MAX_RESTROOM_PHOTOS).toBe(3);
    });

    it("renders replace button on approved photo and delete button on pending photo in manage mode", () => {
      render(
        <RestroomPhotoManager
          mode="manage"
          restroomId={VALID_RESTROOM_ID}
          photos={[
            {
              id: VALID_OLD_PHOTO_ID,
              restroom_id: VALID_RESTROOM_ID,
              storage_path: `restrooms/${VALID_RESTROOM_ID}/old.jpg`,
              photo_type: "entrance",
              is_primary: true,
              moderation_status: "approved",
              uploaded_by: VALID_USER_ID,
              image_url: "https://example.com/old.jpg",
              created_at: "2026-11-20T00:00:00Z",
            },
            {
              id: VALID_PHOTO_ID,
              restroom_id: VALID_RESTROOM_ID,
              storage_path: `restrooms/${VALID_RESTROOM_ID}/new.jpg`,
              photo_type: "entrance",
              is_primary: false,
              moderation_status: "pending",
              uploaded_by: VALID_USER_ID,
              replaces_photo_id: VALID_OLD_PHOTO_ID,
              image_url: "https://example.com/new.jpg",
              created_at: "2026-11-20T01:00:00Z",
            },
          ]}
          onPhotosChanged={vi.fn()}
        />
      );

      const replaceBtn = screen.getByTestId(`replace-photo-btn-${VALID_OLD_PHOTO_ID}`);
      expect(replaceBtn).toBeDisabled(); // Disabled while pending replacement already exists
      expect(replaceBtn).toHaveTextContent("교체 심사 대기 중");
      expect(screen.getByTestId(`delete-pending-photo-btn-${VALID_PHOTO_ID}`)).toBeInTheDocument();
    });

    it("displays photo previews and replacement approval/rejection actions in AdminRestroomsClient", async () => {
      const fetchMock = vi.fn((url: string) => {
        if (url.includes("/api/v1/admin/restrooms?")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              ok: true,
              data: [
                {
                  id: VALID_RESTROOM_ID,
                  name: "공개 중 화장실",
                  type: "partner",
                  publication_status: "published",
                  road_address: "수원시 팔달구 1",
                  address_detail: null,
                  latitude: 37.26,
                  longitude: 127.0,
                  floor: null,
                  gender_type: "separate",
                  access_method: "pin",
                  wheelchair_accessible: true,
                  baby_changing_available: false,
                  sanitary_products_available: false,
                  business_id: VALID_BUSINESS_ID,
                  business_name: "테스트 카페",
                  business_registration_status: "approved",
                  pending_photo_count: 1,
                },
              ],
            }),
          });
        }
        if (url.endsWith(`/api/v1/admin/restrooms/${VALID_RESTROOM_ID}`)) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              ok: true,
              data: {
                id: VALID_RESTROOM_ID,
                name: "공개 중 화장실",
                type: "partner",
                publication_status: "published",
                road_address: "수원시 팔달구 1",
                latitude: 37.26,
                longitude: 127.0,
                gender_type: "separate",
                access_method: "pin",
                business: {
                  id: VALID_BUSINESS_ID,
                  name: "테스트 카페",
                  category: "카페",
                  road_address: "수원시 팔달구 1",
                  registration_status: "approved",
                },
                policies: [{ id: "pol-1", version: 1, access_mode: "free", is_active: true }],
                photos: [
                  {
                    id: VALID_OLD_PHOTO_ID,
                    restroom_id: VALID_RESTROOM_ID,
                    storage_path: `restrooms/${VALID_RESTROOM_ID}/old.jpg`,
                    photo_type: "entrance",
                    is_primary: true,
                    moderation_status: "approved",
                    image_url: "https://example.com/old.jpg",
                  },
                  {
                    id: VALID_PHOTO_ID,
                    restroom_id: VALID_RESTROOM_ID,
                    storage_path: `restrooms/${VALID_RESTROOM_ID}/new.jpg`,
                    photo_type: "interior",
                    is_primary: false,
                    moderation_status: "pending",
                    replaces_photo_id: VALID_OLD_PHOTO_ID,
                    image_url: "https://example.com/new.jpg",
                  },
                ],
                audit_logs: [],
              },
            }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ ok: true, data: {} }),
        });
      });

      globalThis.fetch = fetchMock as any;

      render(<AdminRestroomsClient />);

      await waitFor(() =>
        expect(screen.getByTestId(`inspect-restroom-btn-${VALID_RESTROOM_ID}`)).toBeInTheDocument()
      );
      fireEvent.click(screen.getByTestId(`inspect-restroom-btn-${VALID_RESTROOM_ID}`));

      await waitFor(() =>
        expect(screen.getByTestId("admin-restroom-photos-section")).toBeInTheDocument()
      );
      expect(screen.getByTestId(`approve-photo-btn-${VALID_PHOTO_ID}`)).toHaveTextContent("승인 (교체)");
      expect(screen.getByTestId(`reject-photo-btn-${VALID_PHOTO_ID}`)).toBeInTheDocument();
    });

    it("renders actual approved photo images in PublicRestroomCard and PublicRestroomDetailView", () => {
      render(
        <PublicRestroomCard
          restroom={{
            id: VALID_RESTROOM_ID,
            type: "partner",
            name: "사진 공개 화장실",
            road_address: "경기도 수원시 팔달구 매산로 1",
            address_detail: null,
            latitude: 37.2659,
            longitude: 127.0001,
            access_method: "open",
            gender_type: "separate",
            wheelchair_accessible: true,
            baby_changing_available: false,
            sanitary_products_available: false,
            last_verified_at: null,
            business_id: VALID_BUSINESS_ID,
            access_mode: "free",
            deposit_amount_krw: 0,
            primary_photo_url: "https://example.com/approved-thumb.jpg",
          }}
        />
      );

      const thumb = screen.getByTestId(`public-restroom-thumb-${VALID_RESTROOM_ID}`);
      expect(thumb).toHaveAttribute("src", "https://example.com/approved-thumb.jpg");

      cleanup();

      render(
        <PublicRestroomDetailView
          restroom={{
            id: VALID_RESTROOM_ID,
            type: "partner",
            name: "사진 공개 화장실",
            description: "깔끔합니다.",
            road_address: "경기도 수원시 팔달구 매산로 1",
            address_detail: null,
            latitude: 37.2659,
            longitude: 127.0001,
            floor: "1층",
            entrance_instructions: null,
            gender_type: "separate",
            wheelchair_accessible: true,
            baby_changing_available: false,
            sanitary_products_available: false,
            access_method: "open",
            last_verified_at: null,
            business_id: VALID_BUSINESS_ID,
            business: null,
            hours: [],
            hour_exceptions: [],
            active_policy: {
              id: "pol-1",
              version: 1,
              access_mode: "free",
              deposit_amount_krw: 0,
              refund_eligible: false,
              receipt_window_hours: null,
              min_purchase_krw: null,
              effective_from: "2026-11-20T00:00:00Z",
            },
            photos: [
              {
                id: VALID_PHOTO_ID,
                storage_path: `restrooms/${VALID_RESTROOM_ID}/approved.jpg`,
                photo_type: "entrance",
                is_primary: true,
                image_url: "https://example.com/approved-detail.jpg",
              },
            ],
            created_at: "2026-11-20T00:00:00Z",
            updated_at: "2026-11-20T00:00:00Z",
          }}
        />
      );

      const detailImg = screen
        .getByTestId(`public-restroom-photo-${VALID_PHOTO_ID}`)
        .querySelector("img");
      expect(detailImg).toHaveAttribute("src", "https://example.com/approved-detail.jpg");
    });
  });
});

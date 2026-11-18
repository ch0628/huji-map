/**
 * @vitest-environment jsdom
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  createMerchantRestroomSchema,
  updateMerchantRestroomSchema,
  restroomHourInputSchema,
  normalizeRestroomHours,
} from "@/lib/restrooms/merchant-validation";
import RestroomForm from "@/components/restroom/RestroomForm";
import RestroomPinManager from "@/components/restroom/RestroomPinManager";
import RestroomPolicyManager from "@/components/restroom/RestroomPolicyManager";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
}));

describe("Partner Restroom Operating Hours, PIN Manager & Policy Display Regression Tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("1. Operating Hours Validation & Normalization", () => {
    it("accepts open hours, closed day, and detects midnight crossing", () => {
      const openCheck = restroomHourInputSchema.safeParse({
        weekday: 1,
        is_closed: false,
        opens_at: "09:00",
        closes_at: "22:00",
      });
      expect(openCheck.success).toBe(true);

      const closedCheck = restroomHourInputSchema.safeParse({
        weekday: 0,
        is_closed: true,
        opens_at: null,
        closes_at: null,
      });
      expect(closedCheck.success).toBe(true);

      const normalized = normalizeRestroomHours([
        { weekday: 1, is_closed: false, opens_at: "09:00", closes_at: "22:00" },
        { weekday: 5, is_closed: false, opens_at: "22:00", closes_at: "02:00" },
        { weekday: 0, is_closed: true, opens_at: "09:00", closes_at: "18:00" },
      ]);

      expect(normalized[0]).toEqual({
        weekday: 1,
        is_closed: false,
        opens_at: "09:00:00",
        closes_at: "22:00:00",
        crosses_midnight: false,
      });
      expect(normalized[1]).toEqual({
        weekday: 5,
        is_closed: false,
        opens_at: "22:00:00",
        closes_at: "02:00:00",
        crosses_midnight: true,
      });
      expect(normalized[2]).toEqual({
        weekday: 0,
        is_closed: true,
        opens_at: null,
        closes_at: null,
        crosses_midnight: false,
      });
    });

    it("rejects non-closed day with missing times or identical start/end times", () => {
      const missingTimes = restroomHourInputSchema.safeParse({
        weekday: 1,
        is_closed: false,
      });
      expect(missingTimes.success).toBe(false);

      const equalTimes = restroomHourInputSchema.safeParse({
        weekday: 1,
        is_closed: false,
        opens_at: "09:00",
        closes_at: "09:00",
      });
      expect(equalTimes.success).toBe(false);
    });

    it("create & update schemas accept hours array", () => {
      const createRes = createMerchantRestroomSchema.safeParse({
        business_id: "11111111-1111-4111-8111-111111111111",
        name: "1층 화장실",
        road_address: "수원시 팔달구 매산로 1",
        latitude: 37.2636,
        longitude: 127.0286,
        hours: [{ weekday: 1, is_closed: false, opens_at: "09:00", closes_at: "21:00" }],
      });
      expect(createRes.success).toBe(true);

      const updateRes = updateMerchantRestroomSchema.safeParse({
        hours: [{ weekday: 0, is_closed: true, opens_at: null, closes_at: null }],
      });
      expect(updateRes.success).toBe(true);
    });
  });

  describe("2. RestroomForm Operating Hours Editor", () => {
    it("renders operating hours editor and submits configured open & closed days on create", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          data: { id: "new-restroom-id" },
        }),
      } as Response);

      const addressSearchFn = vi.fn().mockResolvedValue([
        {
          id: "addr-1",
          roadAddress: "경기도 수원시 팔달구 행궁로 1",
          jibunAddress: "경기도 수원시 팔달구 남창동 1",
          displayAddress: "경기도 수원시 팔달구 행궁로 1",
          buildingName: null,
          lat: 37.2835,
          lng: 127.0158,
          source: "road",
        },
      ]);

      const onSuccess = vi.fn();
      render(
        <RestroomForm
          businessId="11111111-1111-4111-8111-111111111111"
          mode="create"
          onSuccess={onSuccess}
          addressSearchFn={addressSearchFn}
        />
      );

      expect(screen.getByTestId("restroom-hours-editor")).toBeDefined();
      expect(screen.queryByLabelText(/위도/)).toBeNull();
      expect(screen.queryByLabelText(/경도/)).toBeNull();

      fireEvent.change(screen.getByLabelText(/화장실 이름/), {
        target: { value: "테스트 화장실" },
      });
      fireEvent.change(screen.getByTestId("address-search-input"), {
        target: { value: "행궁로 1" },
      });
      fireEvent.click(screen.getByTestId("address-search-button"));
      fireEvent.click(await screen.findByTestId("address-search-result-0"));

      // Set Monday (1) to open 10:00~20:00, Sunday (0) to closed
      fireEvent.change(screen.getByTestId("hour-mode-1"), {
        target: { value: "open" },
      });
      fireEvent.change(screen.getByTestId("hour-opens-1"), {
        target: { value: "10:00" },
      });
      fireEvent.change(screen.getByTestId("hour-closes-1"), {
        target: { value: "20:00" },
      });
      fireEvent.change(screen.getByTestId("hour-mode-0"), {
        target: { value: "closed" },
      });

      fireEvent.click(screen.getByTestId("restroom-form-submit-button"));

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      });

      const sentBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(sentBody.road_address).toBe("경기도 수원시 팔달구 행궁로 1");
      expect(sentBody.latitude).toBe(37.2835);
      expect(sentBody.longitude).toBe(127.0158);
      expect(sentBody.hours).toEqual([
        { weekday: 1, is_closed: false, opens_at: "10:00", closes_at: "20:00" },
        { weekday: 0, is_closed: true, opens_at: null, closes_at: null },
      ]);
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  describe("3. RestroomPinManager Component", () => {
    const restroomId = "22222222-2222-4222-8222-222222222222";

    it("shows guidance notice instead of PIN form when accessMethod is not pin", () => {
      render(
        <RestroomPinManager restroomId={restroomId} accessMethod="ask_staff" />
      );

      expect(screen.getByTestId("pin-method-notice")).toBeDefined();
      expect(screen.queryByTestId("restroom-pin-form")).toBeNull();
    });

    it("disables PIN submission when encryptionConfigured is false", () => {
      render(
        <RestroomPinManager
          restroomId={restroomId}
          accessMethod="pin"
          pinStatus={{
            hasActivePin: false,
            codeVersion: null,
            updatedAt: null,
            encryptionConfigured: false,
          }}
        />
      );

      expect(screen.getByTestId("pin-encryption-missing-alert")).toBeDefined();
      expect(
        (screen.getByTestId("pin-submit-button") as HTMLButtonElement).disabled
      ).toBe(true);
    });

    it("rejects mismatched PIN confirmation and submits valid PIN without echoing it", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          codeVersion: 2,
          updatedAt: "2026-11-18T12:00:00Z",
          requestId: "req-1",
        }),
      } as Response);

      const onPinUpdated = vi.fn();
      render(
        <RestroomPinManager
          restroomId={restroomId}
          accessMethod="pin"
          pinStatus={{
            hasActivePin: true,
            codeVersion: 1,
            updatedAt: "2026-11-17T12:00:00Z",
            encryptionConfigured: true,
          }}
          onPinUpdated={onPinUpdated}
        />
      );

      expect(screen.getByTestId("pin-status-badge").textContent).toContain("v1");

      fireEvent.change(screen.getByTestId("pin-input"), {
        target: { value: "4829*" },
      });
      fireEvent.change(screen.getByTestId("pin-confirm-input"), {
        target: { value: "9999" },
      });
      fireEvent.click(screen.getByTestId("pin-submit-button"));

      expect(screen.getByTestId("pin-manager-error").textContent).toContain(
        "일치하지 않습니다"
      );
      expect(fetchSpy).not.toHaveBeenCalled();

      fireEvent.change(screen.getByTestId("pin-confirm-input"), {
        target: { value: "4829*" },
      });
      fireEvent.click(screen.getByTestId("pin-submit-button"));

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      });

      expect(screen.getByTestId("pin-manager-success").textContent).toContain("v2");
      // Plaintext PIN must be cleared from inputs and never displayed in success message
      expect((screen.getByTestId("pin-input") as HTMLInputElement).value).toBe("");
      expect(screen.getByTestId("pin-manager-success").textContent).not.toContain("4829*");
      expect(onPinUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ hasActivePin: true, codeVersion: 2 })
      );
    });
  });

  describe("4. RestroomPolicyManager Dynamic Deposit Display", () => {
    it("displays actual DB deposit amount instead of hardcoded 1,000원", () => {
      render(
        <RestroomPolicyManager
          restroomId="33333333-3333-4333-8333-333333333333"
          policies={[
            {
              id: "p-2",
              restroom_id: "33333333-3333-4333-8333-333333333333",
              version: 2,
              access_mode: "test_deposit",
              deposit_amount_krw: 2500,
              refund_eligible: true,
              receipt_window_hours: 24,
              min_purchase_krw: 0,
              is_active: true,
              effective_from: "2026-11-18T00:00:00Z",
              created_by: null,
              created_at: "2026-11-18T00:00:00Z",
            },
          ]}
        />
      );

      expect(screen.getByText(/테스트 보증금 모드 \(2,500원\)/)).toBeDefined();
      expect(screen.getByText("2,500원")).toBeDefined();
    });
  });
});

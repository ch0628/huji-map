/**
 * @vitest-environment jsdom
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ExcludedAccountsManager from "@/components/analytics/ExcludedAccountsManager";

const TEST_UID_1 = "33333333-3333-4333-8333-333333333301";
const TEST_UID_2 = "33333333-3333-4333-8333-333333333302";
const TEST_UID_3 = "33333333-3333-4333-8333-333333333303";

describe("Admin UI: ExcludedAccountsManager", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("회원 검색, 3개 계정 다중 선택·등록, 현재 제외 수 표시, 제외 해제 및 필수 안내 문구를 정상 렌더링한다", async () => {
    let excludedList: any[] = [];
    const onExclusionsChanged = vi.fn();

    const candidatesFixture = [
      {
        userId: TEST_UID_1,
        email: "tester1@example.com",
        displayName: "테스터1",
        accountStatus: "active",
        roles: ["customer"],
        createdAt: "2026-11-20T00:00:00Z",
        isCurrentlyExcluded: false,
      },
      {
        userId: TEST_UID_2,
        email: "tester2@example.com",
        displayName: "테스터2",
        accountStatus: "active",
        roles: ["customer"],
        createdAt: "2026-11-21T00:00:00Z",
        isCurrentlyExcluded: false,
      },
      {
        userId: TEST_UID_3,
        email: "tester3@example.com",
        displayName: "테스터3",
        accountStatus: "active",
        roles: ["merchant"],
        createdAt: "2026-11-22T00:00:00Z",
        isCurrentlyExcluded: false,
      },
    ];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const u = String(url);
      const method = (init?.method || "GET").toUpperCase();

      if (u.includes("/api/v1/admin/analytics/excluded-accounts/") && method === "PATCH") {
        const targetId = decodeURIComponent(u.split("/excluded-accounts/")[1]);
        const body = JSON.parse(String(init?.body || "{}"));
        excludedList = excludedList.map((item) =>
          item.userId === targetId ? { ...item, isActive: Boolean(body.isActive) } : item
        );
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            data: excludedList.find((item) => item.userId === targetId),
          }),
        } as Response;
      }

      if (u.includes("/api/v1/admin/analytics/excluded-accounts") && method === "POST") {
        const body = JSON.parse(String(init?.body || "{}"));
        const ids: string[] = body.userIds || [];
        excludedList = ids.map((id) => {
          const c = candidatesFixture.find((item) => item.userId === id)!;
          return {
            id: `ex-${id}`,
            userId: id,
            email: c.email,
            displayName: c.displayName,
            accountStatus: "active",
            roles: c.roles,
            isActive: true,
            note: body.note ?? null,
            createdBy: null,
            updatedBy: null,
            createdAt: "2026-11-25T10:00:00Z",
            updatedAt: "2026-11-25T10:00:00Z",
          };
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            data: { registeredCount: excludedList.length, items: excludedList },
          }),
        } as Response;
      }

      // GET overview
      const activeIds = new Set(excludedList.filter((i) => i.isActive).map((i) => i.userId));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          data: {
            activeCount: activeIds.size,
            excludedAccounts: excludedList,
            candidates: candidatesFixture.map((c) => ({
              ...c,
              isCurrentlyExcluded: activeIds.has(c.userId),
            })),
          },
        }),
      } as Response;
    });

    render(<ExcludedAccountsManager onExclusionsChanged={onExclusionsChanged} />);

    // Required policy notices visible
    const notice = await screen.findByTestId("excluded-accounts-policy-notice");
    expect(notice.textContent).toContain("소급 제외 불가");
    expect(notice.textContent).toContain("로그아웃 상태 활동은 자동 제외 불가");

    // Select 3 accounts and save
    fireEvent.click(await screen.findByTestId(`candidate-checkbox-${TEST_UID_1}`));
    fireEvent.click(screen.getByTestId(`candidate-checkbox-${TEST_UID_2}`));
    fireEvent.click(screen.getByTestId(`candidate-checkbox-${TEST_UID_3}`));
    fireEvent.change(screen.getByTestId("excluded-accounts-note-input"), {
      target: { value: "시연 테스트 계정 3개" },
    });
    fireEvent.click(screen.getByTestId("excluded-accounts-register-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("excluded-accounts-active-count").textContent).toContain("3개");
      expect(screen.getByTestId("excluded-accounts-feedback").textContent).toContain(
        "3개 계정을 이용 통계 제외 대상으로 저장했습니다"
      );
      expect(onExclusionsChanged).toHaveBeenCalledTimes(1);
    });

    // Deactivate 1 account -> active count becomes 2
    fireEvent.click(screen.getByTestId(`exclude-remove-btn-${TEST_UID_2}`));
    await waitFor(() => {
      expect(screen.getByTestId("excluded-accounts-active-count").textContent).toContain("2개");
      expect(onExclusionsChanged).toHaveBeenCalledTimes(2);
    });
  });
});

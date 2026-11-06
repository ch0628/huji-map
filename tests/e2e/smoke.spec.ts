import { test, expect } from "@playwright/test";

test.describe("E2E Smoke Tests", () => {
  test("홈페이지에 접속하여 휴지맵 타이틀과 화장실 지도 링크를 확인할 수 있어야 한다", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/휴지맵/);
    const mapLink = page.getByRole("link", { name: /화장실 지도/ });
    await expect(mapLink).toBeVisible();
  });

  test("화장실 지도 페이지(/map)에 접속할 수 있어야 한다", async ({ page }) => {
    await page.goto("/map");
    await expect(page.getByText("화장실 지도")).toBeVisible();
    await expect(page.getByText(/지도 서비스 준비 중/)).toBeVisible();
  });
});


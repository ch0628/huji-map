/**
 * TASK 32: Mobile Chrome (360x740) E2E Verification for Admin Test Refunds UI (/admin/refunds)
 *
 * Verifies:
 * 1. Unauthenticated guest -> 401 SSR gate (`admin-refunds-unauthorized-401`) + login link
 * 2. Non-admin customer -> 403 SSR gate (`admin-refunds-forbidden-403`)
 * 3. Admin session -> test-only banner, approved eligible receipts, 2-step full cancel confirmation
 * 4. 504 timeout -> warning notice, history tab shows `processing` + reconcile button (no fake success)
 * 5. Reconcile (`POST /reconcile`) -> recovers `succeeded` ("테스트 환급 완료") and hides action buttons
 * 6. 360px mobile viewport horizontal overflow = 0px, no secret/key/PIN leakage in DOM
 */

import { spawn, execSync } from "node:child_process";
import { chromium } from "playwright";

const PORT = 3032;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {}
}

async function startNextServer() {
  console.log(">>> 1. Starting Next.js Server on port", PORT, "...");
  const server = spawn("cmd.exe", ["/c", `npx next start -p ${PORT} -H 127.0.0.1`], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    env: {
      ...process.env,
      PORT: String(PORT),
      ALLOW_E2E_MOCK: "1",
    },
  });

  server.stderr.on("data", (d) => {
    const s = d.toString();
    if (!s.includes("DeprecationWarning")) {
      console.error("[server err]", s.trim());
    }
  });

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`${BASE_URL}/map`);
      if (res.status >= 200 && res.status < 400) {
        console.log("✓ Next.js server ready at", BASE_URL);
        return server;
      }
    } catch {}
  }
  killProcessTree(server.pid);
  throw new Error("Failed to start Next.js server within 30s");
}

async function runTests() {
  let server = null;
  let browser = null;

  try {
    server = await startNextServer();
    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
    });

    const context = await browser.newContext({
      viewport: { width: 360, height: 740 },
      isMobile: true,
      hasTouch: true,
    });

    const page = await context.newPage();

    async function checkNoHorizontalOverflow(stepName) {
      const dims = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      if (dims.scrollWidth > 360) {
        throw new Error(
          `[${stepName}] Horizontal overflow on 360px mobile: scrollWidth=${dims.scrollWidth}`
        );
      }
      console.log(`  ✓ [${stepName}] 360px viewport OK (scrollWidth=${dims.scrollWidth}px)`);
    }

    // 1. Guest -> 401
    console.log(">>> Step 1: Unauthenticated guest access to /admin/refunds...");
    await page.goto(`${BASE_URL}/admin/refunds`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="admin-refunds-unauthorized-401"]');
    await checkNoHorizontalOverflow("Step 1 - Guest 401");

    // 2. Customer -> 403
    console.log(">>> Step 2: Non-admin customer access to /admin/refunds...");
    await context.addCookies([
      { name: "e2e_mock_customer", value: "1", domain: "127.0.0.1", path: "/" },
    ]);
    await page.goto(`${BASE_URL}/admin/refunds`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="admin-refunds-forbidden-403"]');
    await checkNoHorizontalOverflow("Step 2 - Customer 403");

    // 3. Admin session with mocked receipts + refunds APIs
    console.log(">>> Step 3: Admin session — eligible list, 504 uncertain, and reconcile...");
    await context.clearCookies();
    await context.addCookies([
      { name: "e2e_mock_admin", value: "1", domain: "127.0.0.1", path: "/" },
    ]);

    const ORDER_ID = "11111111-1111-4111-8111-111111111111";
    const RECEIPT_ID = "22222222-2222-4222-8222-222222222222";
    let refundState = null;

    await page.route("**/api/v1/admin/receipts**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          items: [
            {
              id: RECEIPT_ID,
              accessSessionId: "33333333-3333-4333-8333-333333333333",
              userId: "44444444-4444-4444-8444-444444444444",
              storagePath: "receipts/test/sample.jpg",
              mimeType: "image/jpeg",
              fileSizeBytes: 22486,
              originalFilename: "receipt.jpg",
              submissionStatus: "approved",
              storeNameConfirmed: "진미통닭",
              purchaseAtConfirmed: "2026-11-21T13:29:00Z",
              purchaseAmountKrw: 50000,
              reviewedAt: "2026-11-21T13:30:05Z",
              reviewReason: "수동 검수 승인",
              createdAt: "2026-11-21T13:28:36Z",
              businessName: "진미통닭",
              restroomName: "진미 통닭",
              paymentOrderId: ORDER_ID,
              paymentOrderNumber: "hm_ord_e2e_refund_01",
              paymentAmountKrw: 1000,
              paymentStatus: "approved",
              paymentMode: "test",
              refundStatus: refundState ? refundState.status : "none",
            },
          ],
          pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
        }),
      });
    });

    await page.route("**/api/v1/admin/refunds?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          items: refundState ? [refundState] : [],
          pagination: { page: 1, limit: 50, total: refundState ? 1 : 0, totalPages: 1 },
        }),
      });
    });

    await page.route(`**/api/v1/admin/refunds/${ORDER_ID}/request`, async (route) => {
      refundState = {
        id: "55555555-5555-4555-8555-555555555555",
        payment_order_id: ORDER_ID,
        receipt_submission_id: RECEIPT_ID,
        amount_krw: 1000,
        status: "processing",
        failure_reason: "UNCERTAIN_TIMEOUT: Toss 응답 지연으로 재조회 필요",
        requested_at: "2026-11-21T13:31:39Z",
        completed_at: null,
        orderNumber: "hm_ord_e2e_refund_01",
        orderStatus: "approved",
        paymentMode: "test",
        receiptStatus: "approved",
        manualCheckRequired: false,
        canRetry: true,
      };
      await route.fulfill({
        status: 504,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: {
            code: "PG_REFUND_TIMEOUT_UNCERTAIN",
            message: "토스페이먼츠 취소 응답 시간이 초과되어 처리 중(불확실) 상태로 보관되었습니다.",
          },
          requestId: "req-e2e-504",
        }),
      });
    });

    await page.route(`**/api/v1/admin/refunds/${ORDER_ID}/reconcile`, async (route) => {
      refundState = {
        ...refundState,
        status: "succeeded",
        failure_reason: null,
        completed_at: "2026-11-21T13:31:40Z",
        canRetry: false,
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          refund: refundState,
          reconciled: true,
          pgStatus: "CANCELED",
          requestId: "req-e2e-reconcile",
        }),
      });
    });

    await page.goto(`${BASE_URL}/admin/refunds`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="admin-refunds-client"]');
    await page.waitForSelector('[data-testid="admin-refunds-test-banner"]');
    await page.waitForSelector(`[data-testid="eligible-refund-card-${RECEIPT_ID}"]`);
    await checkNoHorizontalOverflow("Step 3 - Admin Eligible Queue");

    // Trigger 2-step refund request -> 504 uncertain
    await page.click(`[data-testid="request-refund-btn-${ORDER_ID}"]`);
    await page.waitForSelector(`[data-testid="confirm-refund-box-${ORDER_ID}"]`);
    await page.click(`[data-testid="confirm-refund-submit-${ORDER_ID}"]`);
    await page.waitForSelector('[data-testid="admin-refunds-action-notice"]');
    const noticeText = await page.textContent('[data-testid="admin-refunds-action-notice"]');
    if (!noticeText?.includes("PG_REFUND_TIMEOUT_UNCERTAIN")) {
      throw new Error(`Expected uncertain timeout notice, got: ${noticeText}`);
    }

    // Switch to processing tab and reconcile without duplicate cancel
    await page.click('[data-testid="refund-tab-processing"]');
    await page.waitForSelector(`[data-testid="refund-history-card-${ORDER_ID}"]`);
    await page.waitForSelector(`[data-testid="reconcile-refund-btn-${ORDER_ID}"]`);
    await checkNoHorizontalOverflow("Step 4 - Processing & Reconcile");

    await page.click(`[data-testid="reconcile-refund-btn-${ORDER_ID}"]`);
    await page.click('[data-testid="refund-tab-succeeded"]');
    await page.waitForSelector(`[data-testid="refund-status-badge-${ORDER_ID}"]`);
    const badgeText = await page.textContent(`[data-testid="refund-status-badge-${ORDER_ID}"]`);
    if (!badgeText?.includes("테스트 환급 완료")) {
      throw new Error(`Expected succeeded badge, got: ${badgeText}`);
    }
    const reconcileBtnCount = await page
      .locator(`[data-testid="reconcile-refund-btn-${ORDER_ID}"]`)
      .count();
    if (reconcileBtnCount !== 0) {
      throw new Error("Reconcile/action button must be hidden after refund succeeded");
    }
    await checkNoHorizontalOverflow("Step 5 - Succeeded History");

    const bodyText = await page.textContent("body");
    if (
      bodyText?.includes("test_sk_") ||
      bodyText?.includes("test_gsk_") ||
      bodyText?.includes("sb_secret_") ||
      bodyText?.includes("provider_payment_key")
    ) {
      throw new Error("Security Violation: sensitive key leaked in /admin/refunds DOM!");
    }

    console.log("🎉 ALL ADMIN REFUNDS MOBILE CHROME (360x740) E2E CHECKS PASSED!");
  } finally {
    if (browser) await browser.close();
    if (server) killProcessTree(server.pid);
  }
}

runTests().catch((err) => {
  console.error("❌ Admin Refunds E2E Failed:", err);
  process.exit(1);
});

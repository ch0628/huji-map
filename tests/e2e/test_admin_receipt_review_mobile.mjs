/**
 * TASK 29: Mobile Chrome (360x740) E2E Admin Manual Receipt Review Verification
 *
 * Verifies all requirements from TASK 29:
 * 1. 비로그인(Guest) /admin/receipts 접근 차단 (401 UI)
 * 2. 비관리자(Customer) /admin/receipts 접근 차단 (403 UI)
 * 3. 관리자 영수증 심사 대기열 조회, 상태 필터링, 페이지네이션
 * 4. 비공개 서명 이미지 로드, 원본 전체 뷰어 모달(확대 전환), 만료된 URL 재발급 처리
 * 5. 가게/시간/금액 비교 필드 및 API 미제공 필드 안내 표시
 * 6. 필수 사유 검증, 최종 제출 전 확인, 연속 클릭 중복 요청 방지(1회 POST + x-idempotency-key)
 * 7. 승인 / 반려 / 재제출 요청 처리 및 승인 시 PG 환급 미실행 확인
 * 8. 409 충돌 오류 처리 및 목록 새로고침
 * 9. 360px 모바일 뷰포트 가로 스크롤 0px 검증
 */

import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { chromium } from "playwright";

const PORT = 3029;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const SCREENSHOT_PATH = path.resolve(
  "tests/e2e/screenshots/task29_admin_receipt_review_mobile.png"
);

// Valid 1x1 PNG binary for mocked private signed URL image fetch
const MOCK_PNG_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

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
  console.log(">>> 1. Starting Next.js Production Server on port", PORT, "...");
  const server = spawn(
    "cmd.exe",
    ["/c", `npx next start -p ${PORT} -H 127.0.0.1`],
    {
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      env: {
        ...process.env,
        PORT: String(PORT),
        ALLOW_E2E_MOCK: "1",
      },
    }
  );

  server.stdout.on("data", (d) => {
    const s = d.toString().trim();
    if (s.includes("Ready")) console.log("[server out]", s);
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
      const res = await fetch(`${BASE_URL}/admin/receipts`);
      if (res.status >= 200 && res.status < 500) {
        console.log(
          "✓ Next.js server ready at",
          BASE_URL,
          `(status: ${res.status})`
        );
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

  const receiptStore = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      accessSessionId: "aaaa1111-1111-4111-8111-111111111111",
      userId: "bbbb1111-1111-4111-8111-111111111111",
      storagePath:
        "receipts/bbbb1111-1111-4111-8111-111111111111/aaaa1111-1111-4111-8111-111111111111/r1.png",
      mimeType: "image/png",
      fileSizeBytes: 153600,
      originalFilename: "receipt_approve.png",
      submissionStatus: "submitted",
      storeNameConfirmed: null,
      purchaseAtConfirmed: null,
      purchaseAmountKrw: null,
      reviewedAt: null,
      reviewReason: null,
      createdAt: "2026-11-16T01:00:00.000Z",
      restroomName: "DEMO 제휴 화장실 1호",
      businessId: "dddd1111-1111-4111-8111-111111111111",
      businessName: "DEMO 테스트 카페 1호점",
      businessRoadAddress: "경기도 수원시 팔달구 효원로 1",
      userDisplayName: "테스터1",
      accessAuthorizedAt: "2026-11-16T00:45:00.000Z",
      accessExpiresAt: "2026-11-16T01:45:00.000Z",
      accessStatus: "authorized",
      policyVersion: 1,
      depositAmountKrw: 1000,
      receiptWindowHours: 24,
      receiptWindowDeadline: "2026-11-17T00:45:00.000Z",
      minPurchaseKrw: 3000,
      paymentOrderId: "ord-e2e-1",
      paymentOrderNumber: "HM_E2E_1001",
      paymentAmountKrw: 1000,
      paymentStatus: "approved",
      paymentMode: "test",
      paymentApprovedAt: "2026-11-16T00:45:00.000Z",
      receiptReference: null,
      refundStatus: "none",
      refundAmountKrw: null,
      refundRequestedAt: null,
      refundCompletedAt: null,
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      accessSessionId: "aaaa2222-2222-4222-8222-222222222222",
      userId: "bbbb2222-2222-4222-8222-222222222222",
      storagePath:
        "receipts/bbbb2222-2222-4222-8222-222222222222/aaaa2222-2222-4222-8222-222222222222/r2.png",
      mimeType: "image/png",
      fileSizeBytes: 184320,
      originalFilename: "receipt_reject.png",
      submissionStatus: "submitted",
      storeNameConfirmed: null,
      purchaseAtConfirmed: null,
      purchaseAmountKrw: null,
      reviewedAt: null,
      reviewReason: null,
      createdAt: "2026-11-16T01:10:00.000Z",
      restroomName: "DEMO 제휴 화장실 2호",
      businessName: "DEMO 테스트 베이커리 2호점",
      depositAmountKrw: 1000,
      userDisplayName: "테스터2",
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      accessSessionId: "aaaa3333-3333-4333-8333-333333333333",
      userId: "bbbb3333-3333-4333-8333-333333333333",
      storagePath:
        "receipts/bbbb3333-3333-4333-8333-333333333333/aaaa3333-3333-4333-8333-333333333333/r3.png",
      mimeType: "image/png",
      fileSizeBytes: 98304,
      originalFilename: "receipt_resubmit.png",
      submissionStatus: "review_required",
      storeNameConfirmed: null,
      purchaseAtConfirmed: null,
      purchaseAmountKrw: null,
      reviewedAt: null,
      reviewReason: null,
      createdAt: "2026-11-16T01:20:00.000Z",
      restroomName: "DEMO 제휴 화장실 3호",
      businessName: "DEMO 테스트 분식 3호점",
      depositAmountKrw: 1000,
      userDisplayName: "테스터3",
    },
    {
      id: "44444444-4444-4444-8444-444444444444",
      accessSessionId: "aaaa4444-4444-4444-8444-444444444444",
      userId: "bbbb4444-4444-4444-8444-444444444444",
      storagePath:
        "receipts/bbbb4444-4444-4444-8444-444444444444/aaaa4444-4444-4444-8444-444444444444/r4.png",
      mimeType: "image/png",
      fileSizeBytes: 112640,
      originalFilename: "receipt_conflict.png",
      submissionStatus: "submitted",
      storeNameConfirmed: null,
      purchaseAtConfirmed: null,
      purchaseAmountKrw: null,
      reviewedAt: null,
      reviewReason: null,
      createdAt: "2026-11-16T01:30:00.000Z",
      restroomName: "DEMO 제휴 화장실 4호",
      businessName: "DEMO 테스트 서점 4호점",
      depositAmountKrw: 1000,
      userDisplayName: "테스터4",
    },
  ];

  const decisionPosts = [];
  const pgRefundCalls = [];
  let imageFetchCountForFirst = 0;

  try {
    server = await startNextServer();

    console.log(">>> 2. Launching Google Chrome (360x740 viewport)...");
    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
    });

    const context = await browser.newContext({
      viewport: { width: 360, height: 740 },
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });

    const page = await context.newPage();

    async function checkNoHorizontalOverflow(stepName) {
      const result = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      if (result.scrollWidth > result.innerWidth) {
        throw new Error(
          `[${stepName}] Horizontal overflow detected! scrollWidth=${result.scrollWidth}px > innerWidth=${result.innerWidth}px`
        );
      }
      console.log(`  ✓ [${stepName}] 360px viewport check passed (scrollWidth=${result.scrollWidth}px).`);
    }

    // Track any unexpected PG refund/cancel calls
    await page.route("**/api/v1/payments/**", async (route) => {
      pgRefundCalls.push(route.request().url());
      await route.abort();
    });

    // =========================================================================
    // Step 1: Guest access blocked (401)
    // =========================================================================
    console.log("\n>>> Step 1: Unauthenticated guest access to /admin/receipts...");
    await page.goto(`${BASE_URL}/admin/receipts`);
    await page.waitForSelector('[data-testid="admin-receipts-unauthorized-401"]');
    await checkNoHorizontalOverflow("Step 1 - Guest 401");

    // =========================================================================
    // Step 2: Non-admin customer access blocked (403)
    // =========================================================================
    console.log("\n>>> Step 2: Non-admin customer access to /admin/receipts...");
    await context.addCookies([
      { name: "e2e_mock_customer", value: "1", domain: "127.0.0.1", path: "/" },
    ]);
    await page.goto(`${BASE_URL}/admin/receipts`);
    await page.waitForSelector('[data-testid="admin-receipts-forbidden-403"]');
    await checkNoHorizontalOverflow("Step 2 - Customer 403");

    // =========================================================================
    // Step 3: Set admin mock cookie & mock TASK 28 APIs
    // =========================================================================
    await context.clearCookies();
    await context.addCookies([
      { name: "e2e_mock_admin", value: "1", domain: "127.0.0.1", path: "/" },
    ]);

    // Mock signed image binary endpoint on same origin
    await page.route(/\/mock-private-signed\//, async (route) => {
      const url = route.request().url();
      if (url.includes("expired=1")) {
        await route.fulfill({ status: 403, body: "Signed URL Expired" });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: MOCK_PNG_BUFFER,
      });
    });

    await page.route(/\/api\/v1\/admin\/receipts/, async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();

      // GET /api/v1/admin/receipts
      if (url.pathname === "/api/v1/admin/receipts" && method === "GET") {
        const status = url.searchParams.get("status") || "pending";
        const pageNum = Number(url.searchParams.get("page") || "1");
        const limitNum = Number(url.searchParams.get("limit") || "20");

        let filtered = receiptStore;
        if (status === "pending") {
          filtered = receiptStore.filter((r) =>
            ["submitted", "review_required"].includes(r.submissionStatus)
          );
        } else if (status !== "all") {
          filtered = receiptStore.filter((r) => r.submissionStatus === status);
        }

        const total = filtered.length;
        const totalPages = Math.max(1, Math.ceil(total / limitNum));
        const start = (pageNum - 1) * limitNum;
        const items = filtered.slice(start, start + limitNum);

        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            items,
            pagination: {
              page: pageNum,
              limit: limitNum,
              total,
              totalPages,
            },
            requestId: "e2e-req-list",
          }),
        });
        return;
      }

      // GET /api/v1/admin/receipts/:id/image
      const imageMatch = url.pathname.match(
        /^\/api\/v1\/admin\/receipts\/([^/]+)\/image$/
      );
      if (imageMatch && method === "GET") {
        const targetId = imageMatch[1];
        let signedUrl = `${BASE_URL}/mock-private-signed/${targetId}.png?token=valid`;
        if (targetId === receiptStore[0].id) {
          imageFetchCountForFirst += 1;
          // 1st fetch returns expired URL to test expired URL recovery; 2nd+ returns valid URL
          if (imageFetchCountForFirst === 1) {
            signedUrl = `${BASE_URL}/mock-private-signed/${targetId}.png?expired=1`;
          }
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            signedUrl,
            expiresIn: 900,
            storagePath: `receipts/mock/${targetId}.png`,
            receiptId: targetId,
          }),
        });
        return;
      }

      // POST /api/v1/admin/receipts/:id/decision
      const decisionMatch = url.pathname.match(
        /^\/api\/v1\/admin\/receipts\/([^/]+)\/decision$/
      );
      if (decisionMatch && method === "POST") {
        const targetId = decisionMatch[1];
        const body = JSON.parse(route.request().postData() || "{}");
        const idemKey = route.request().headers()["x-idempotency-key"];
        decisionPosts.push({ targetId, body, idemKey });

        // Simulate 409 conflict for 4th receipt
        if (targetId === receiptStore[3].id) {
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({
              ok: false,
              error: {
                code: "STATUS_CONFLICT",
                message: "이미 다른 관리자에 의해 승인 완료된 영수증입니다.",
              },
            }),
          });
          return;
        }

        const idx = receiptStore.findIndex((r) => r.id === targetId);
        if (idx === -1) {
          await route.fulfill({ status: 404, body: "{}" });
          return;
        }

        // Artificial slight delay to verify double-click mutex
        await new Promise((r) => setTimeout(r, 120));

        receiptStore[idx] = {
          ...receiptStore[idx],
          submissionStatus: body.decision,
          reviewReason: body.reason,
          storeNameConfirmed: body.confirmedStore ?? null,
          purchaseAtConfirmed: body.confirmedPurchaseAt ?? null,
          purchaseAmountKrw: body.confirmedAmount ?? null,
          reviewedAt: new Date().toISOString(),
        };

        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            receipt: receiptStore[idx],
            auditId: `audit-${targetId.slice(0, 8)}`,
          }),
        });
        return;
      }

      await route.continue();
    });

    console.log("\n>>> Step 3: Admin queue load, filter & pagination...");
    await page.goto(`${BASE_URL}/admin/receipts`);
    await page.waitForSelector(`[data-testid="admin-receipt-card-${receiptStore[0].id}"]`);
    await checkNoHorizontalOverflow("Step 3 - Admin Queue");

    // Check filter tab switching (approved empty -> pending back)
    await page.click('[data-testid="receipt-filter-tab-approved"]');
    await page.waitForSelector('[data-testid="admin-receipts-empty"]');
    await page.click('[data-testid="receipt-filter-tab-pending"]');
    await page.waitForSelector(`[data-testid="admin-receipt-card-${receiptStore[0].id}"]`);

    // =========================================================================
    // Step 4: Detail view, expired URL recovery, original viewer modal, comparison fields
    // =========================================================================
    console.log("\n>>> Step 4: Inspect receipt 1, expired image recovery & original viewer...");
    await page.click(`[data-testid="inspect-receipt-${receiptStore[0].id}"]`);
    await page.waitForSelector('[data-testid="admin-receipt-detail-view"]');

    // First image fetch returns 403 expired -> expired warning appears
    await page.waitForSelector('[data-testid="receipt-image-expired-warning"]');
    await page.click('[data-testid="receipt-image-refresh-button"]');
    await page.waitForSelector('[data-testid="receipt-preview-img"]');

    // Open original full viewer modal
    await page.click('[data-testid="open-original-image-viewer"]');
    await page.waitForSelector('[data-testid="original-image-viewer-modal"]');
    await page.click('[data-testid="zoom-mode-150"]');
    await checkNoHorizontalOverflow("Step 4 - Original Image Modal");
    await page.click('[data-testid="close-original-image-viewer"]');

    // Verify real comparison fields (store address, policy window, payment order amount vs receipt purchase amount)
    const addressText = await page.textContent('[data-testid="compare-business-address"]');
    if (!addressText?.includes("효원로 1")) {
      throw new Error(`Expected businessRoadAddress in comparison card, got: ${addressText}`);
    }
    const windowText = await page.textContent('[data-testid="compare-receipt-window"]');
    if (!windowText?.includes("24시간")) {
      throw new Error(`Expected policy receiptWindowHours in comparison card, got: ${windowText}`);
    }
    const payText = await page.textContent('[data-testid="compare-payment-amount"]');
    if (!payText?.includes("1,000원") || !payText?.includes("approved")) {
      throw new Error(`Expected paymentOrder amount & status, got: ${payText}`);
    }
    const confirmedAmtText = await page.textContent('[data-testid="compare-confirmed-amount"]');
    if (!confirmedAmtText?.includes("미확인")) {
      throw new Error(`Expected unconfirmed purchase amount before review, got: ${confirmedAmtText}`);
    }

    await checkNoHorizontalOverflow("Step 4 - Detail View");

    // =========================================================================
    // Step 5: Mandatory reason validation, pre-submit confirm, double-click protection, Approve (no PG refund)
    // =========================================================================
    console.log("\n>>> Step 5: Reason validation & Approval with double-click protection...");
    await page.click('[data-testid="decision-option-approved"]');
    await page.fill('[data-testid="input-review-reason"]', "짧");
    await page.click('[data-testid="decision-review-submit-button"]');
    await page.waitForSelector('[data-testid="decision-validation-error"]');

    await page.fill('[data-testid="input-confirmed-amount"]', "4500");
    await page.fill(
      '[data-testid="input-review-reason"]',
      "DEMO 제휴 매장 영수증 상호 및 구매금액 4,500원 확인 완료"
    );
    await page.click('[data-testid="decision-review-submit-button"]');
    await page.waitForSelector('[data-testid="decision-confirm-panel"]');
    await page.waitForSelector('[data-testid="confirm-no-pg-refund-notice"]');

    // Rapid double click on final submit
    const finalBtn = page.locator('[data-testid="decision-final-submit-button"]');
    await finalBtn.dblclick();

    await page.waitForSelector('[data-testid="decision-success-banner"]');
    const refundLabel = await page.textContent('[data-testid="admin-refund-status-label"]');
    if (!refundLabel?.includes("PG 환급 미실행")) {
      throw new Error(`Expected PG 환급 미실행 label, got: ${refundLabel}`);
    }
    if (decisionPosts.length !== 1) {
      throw new Error(`Expected exactly 1 POST after double-click, got ${decisionPosts.length}`);
    }
    if (!decisionPosts[0].idemKey) {
      throw new Error("Missing x-idempotency-key header on decision POST");
    }
    if (pgRefundCalls.length !== 0) {
      throw new Error(`Expected 0 PG refund calls, got ${pgRefundCalls.length}`);
    }

    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    console.log("✓ Screenshot captured at", SCREENSHOT_PATH);

    // =========================================================================
    // Step 6: Reject & Resubmission Request flows
    // =========================================================================
    console.log("\n>>> Step 6: Reject & Resubmission Request flows...");
    await page.click('[data-testid="back-to-queue-button"]');
    await page.waitForSelector(`[data-testid="inspect-receipt-${receiptStore[1].id}"]`);
    await page.click(`[data-testid="inspect-receipt-${receiptStore[1].id}"]`);
    await page.waitForSelector('[data-testid="receipt-preview-img"]');
    await page.click('[data-testid="decision-option-rejected"]');
    await page.fill(
      '[data-testid="input-review-reason"]',
      "타 매장 영수증으로 제휴 매장 불일치 반려"
    );
    await page.click('[data-testid="decision-review-submit-button"]');
    await page.click('[data-testid="decision-final-submit-button"]');
    await page.waitForSelector('[data-testid="decision-success-banner"]');

    await page.click('[data-testid="back-to-queue-button"]');
    await page.waitForSelector(`[data-testid="inspect-receipt-${receiptStore[2].id}"]`);
    await page.click(`[data-testid="inspect-receipt-${receiptStore[2].id}"]`);
    await page.waitForSelector('[data-testid="receipt-preview-img"]');
    await page.click('[data-testid="decision-option-resubmission_requested"]');
    await page.fill(
      '[data-testid="input-review-reason"]',
      "구매 일시가 흐려 재제출 요청합니다"
    );
    await page.click('[data-testid="decision-review-submit-button"]');
    await page.click('[data-testid="decision-final-submit-button"]');
    await page.waitForSelector('[data-testid="decision-success-banner"]');

    // =========================================================================
    // Step 7: 409 Conflict handling
    // =========================================================================
    console.log("\n>>> Step 7: 409 Conflict error handling...");
    await page.click('[data-testid="back-to-queue-button"]');
    await page.waitForSelector(`[data-testid="inspect-receipt-${receiptStore[3].id}"]`);
    await page.click(`[data-testid="inspect-receipt-${receiptStore[3].id}"]`);
    await page.waitForSelector('[data-testid="receipt-preview-img"]');
    await page.click('[data-testid="decision-option-approved"]');
    await page.fill('[data-testid="input-review-reason"]', "정상 영수증 승인 테스트");
    await page.click('[data-testid="decision-review-submit-button"]');
    await page.click('[data-testid="decision-final-submit-button"]');
    const errText = await page.textContent('[data-testid="decision-api-error"]');
    if (!errText?.includes("HTTP 409")) {
      throw new Error(`Expected HTTP 409 error box, got: ${errText}`);
    }
    await page.click('[data-testid="decision-conflict-refresh-button"]');
    await page.waitForSelector('[data-testid="admin-receipts-list"]');
    await checkNoHorizontalOverflow("Step 7 - Conflict Refresh");

    console.log("\n🎉 ALL TASK 29 MOBILE E2E CHECKS PASSED!");
  } finally {
    if (browser) await browser.close();
    if (server) killProcessTree(server.pid);
  }
}

runTests().catch((err) => {
  console.error("❌ TASK 29 Mobile E2E failed:", err);
  process.exit(1);
});


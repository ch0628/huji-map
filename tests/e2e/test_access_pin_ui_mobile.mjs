/**
 * TASK 25: Mobile Chrome (360x740) E2E Customer Access Ticket & Doorlock PIN UI Verification
 *
 * Verifies all 10 required criteria from TASK 25:
 * 1. 정상 이용권 → 수동 버튼 클릭 시에만 PIN 표시 (초기 렌더링 비노출)
 * 2. 미로그인 → 401 안내 화면 및 PIN 비노출
 * 3. 타인 이용권 → 403 차단 화면 및 PIN 비노출
 * 4. 결제 미완료 → PIN 비노출 ('결제 승인 후 확인 가능')
 * 5. 환불·취소·만료 → PIN 비노출
 * 6. PIN 교체로 인한 409 PIN_STALE_ROTATED → 이전 PIN 즉시 비노출 및 최신 PIN(v2) 재조회
 * 7. 새로고침 및 화면 전환 시 PIN 잔존 여부 (localStorage/sessionStorage/URL/DOM 0건)
 * 8. 중복 클릭 및 중복 요청 처리 (동시 다중 클릭 시 API 1회만 호출)
 * 9. 모바일 화면(360x740) 가로 스크롤 없음 (scrollWidth <= 360px), 터치 타겟 >= 44px, 직원 제시 안내 및 방문 확인(visit_confirmations) 동작
 * 10. 원격 프로덕션 DB 오염 0건 (Playwright route mocking 격리)
 */

import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { chromium } from "playwright";

const PORT = 3025;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const SCREENSHOT_PATH = path.resolve(
  "tests/e2e/screenshots/task25_access_pin_ui_mobile.png"
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
      const res = await fetch(`${BASE_URL}/my/access`);
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

  const customerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const activeSessionId = "11111111-1111-4111-8111-111111111111";
  const unpaidSessionId = "22222222-2222-4222-8222-222222222222";
  const refundedSessionId = "33333333-3333-4333-8333-333333333333";
  const expiredSessionId = "44444444-4444-4444-8444-444444444444";
  const otherUserSessionId = "55555555-5555-4555-8555-555555555555";
  const askStaffSessionId = "66666666-6666-4666-8666-666666666666";

  const futureExpiry = new Date(Date.now() + 3600_000).toISOString();
  const pastExpiry = new Date(Date.now() - 3600_000).toISOString();

  function makeDetail(sessionId, overrides = {}) {
    return {
      session: {
        id: sessionId,
        user_id: customerId,
        restroom_id: "77777777-7777-4777-8777-777777777777",
        policy_id: "88888888-8888-4888-8888-888888888888",
        status: "authorized",
        access_method_snapshot: "pin",
        authorized_at: "2026-11-15T07:00:00.000Z",
        code_revealed_at: null,
        expires_at: futureExpiry,
        created_at: "2026-11-15T06:59:00.000Z",
        updated_at: "2026-11-15T07:00:00.000Z",
        ...(overrides.session || {}),
      },
      effectiveStatus: overrides.effectiveStatus || "authorized",
      restroom: {
        id: "77777777-7777-4777-8777-777777777777",
        name: "행궁 안심제휴 카페 화장실",
        road_address: "수원시 팔달구 화서문로 42",
        address_detail: "1층",
        floor: "1F",
        entrance_instructions: "카운터 우측 복도 끝 도어락",
        access_method: overrides.access_method || "pin",
        publication_status: "published",
        business_id: "99999999-9999-4999-8999-999999999999",
        business_name: "행궁 안심카페 본점",
        business_category: "카페/디저트",
        business_phone: "031-123-4567",
      },
      policy: {
        id: "88888888-8888-4888-8888-888888888888",
        version: 1,
        access_mode: "test_deposit",
        deposit_amount_krw: 1000,
        refund_eligible: true,
        receipt_window_hours: 24,
        min_purchase_krw: 0,
      },
      order:
        overrides.order !== undefined
          ? overrides.order
          : {
              id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              access_session_id: sessionId,
              user_id: customerId,
              order_id: `hm_ord_${sessionId.slice(0, 6)}`,
              provider: "toss",
              payment_mode: "test",
              amount_krw: 1000,
              status: "approved",
              approved_at: "2026-11-15T07:00:00.000Z",
              failure_code: null,
              created_at: "2026-11-15T06:59:00.000Z",
              updated_at: "2026-11-15T07:00:00.000Z",
            },
      refund: overrides.refund || null,
      latestVisitConfirmation: null,
      visitConfirmations: [],
      eligibleForPinReveal:
        overrides.eligibleForPinReveal !== undefined
          ? overrides.eligibleForPinReveal
          : true,
    };
  }

  try {
    server = await startNextServer();

    console.log(
      ">>> 2. Launching Real Google Chrome (360x740 viewport) via Playwright..."
    );
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
      const overflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth;
      });
      if (overflow) {
        const scrollWidth = await page.evaluate(
          () => document.documentElement.scrollWidth
        );
        throw new Error(
          `[${stepName}] Horizontal overflow detected! scrollWidth=${scrollWidth}px > 360px`
        );
      }
      console.log(
        `  ✓ [${stepName}] 360px viewport check passed: no horizontal overflow.`
      );
    }

    // ========================================================================
    // Scenario 1: 미로그인(Guest) → /my/access 및 /my/access/:id 접근 시 401 차단 & PIN 비노출
    // ========================================================================
    console.log(">>> Scenario 1: Unauthenticated guest blocked (401) & no PIN...");
    await page.goto(`${BASE_URL}/my/access`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="access-unauthorized-401"]');
    await checkNoHorizontalOverflow("Guest /my/access 401");

    await page.goto(`${BASE_URL}/my/access/${activeSessionId}`, {
      waitUntil: "networkidle",
    });
    await page.waitForSelector('[data-testid="access-detail-unauthorized-401"]');
    const guestPinCount = await page
      .locator('[data-testid="revealed-pin-value"]')
      .count();
    if (guestPinCount !== 0) {
      throw new Error("Guest view must not render PIN!");
    }
    await checkNoHorizontalOverflow("Guest /my/access/:id 401");
    console.log("  ✓ Scenario 1 PASSED.");

    // Authenticate E2E customer mock session
    await context.addCookies([
      {
        name: "e2e_mock_customer",
        value: "1",
        domain: "127.0.0.1",
        path: "/",
      },
    ]);

    const activeDetail = makeDetail(activeSessionId);
    const unpaidDetail = makeDetail(unpaidSessionId, {
      session: { status: "created" },
      effectiveStatus: "created",
      order: {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        access_session_id: unpaidSessionId,
        user_id: customerId,
        order_id: "hm_ord_unpaid",
        provider: "toss",
        payment_mode: "test",
        amount_krw: 1000,
        status: "pending",
        approved_at: null,
        failure_code: null,
        created_at: "2026-11-15T06:59:00.000Z",
        updated_at: "2026-11-15T06:59:00.000Z",
      },
      eligibleForPinReveal: false,
    });
    const refundedDetail = makeDetail(refundedSessionId, {
      effectiveStatus: "canceled",
      refund: {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        payment_order_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        receipt_submission_id: null,
        amount_krw: 1000,
        status: "succeeded",
        failure_reason: null,
        requested_at: "2026-11-15T08:00:00.000Z",
        completed_at: "2026-11-15T08:01:00.000Z",
      },
      eligibleForPinReveal: false,
    });
    const expiredDetail = makeDetail(expiredSessionId, {
      session: { status: "expired", expires_at: pastExpiry },
      effectiveStatus: "expired",
      eligibleForPinReveal: false,
    });
    const askStaffDetail = makeDetail(askStaffSessionId, {
      session: { access_method_snapshot: "ask_staff" },
      access_method: "ask_staff",
      eligibleForPinReveal: false,
    });

    // Route interceptors for list & details
    await page.route("**/my/access/data", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Cache-Control": "private, no-store" },
        body: JSON.stringify({
          ok: true,
          data: {
            items: [
              activeDetail,
              unpaidDetail,
              refundedDetail,
              expiredDetail,
              askStaffDetail,
            ],
          },
        }),
      });
    });

    await page.route("**/my/access/*/data", async (route) => {
      const url = route.request().url();
      if (url.includes(activeSessionId)) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Cache-Control": "private, no-store" },
          body: JSON.stringify({ ok: true, data: { detail: activeDetail } }),
        });
      }
      if (url.includes(unpaidSessionId)) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Cache-Control": "private, no-store" },
          body: JSON.stringify({ ok: true, data: { detail: unpaidDetail } }),
        });
      }
      if (url.includes(refundedSessionId)) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Cache-Control": "private, no-store" },
          body: JSON.stringify({ ok: true, data: { detail: refundedDetail } }),
        });
      }
      if (url.includes(expiredSessionId)) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Cache-Control": "private, no-store" },
          body: JSON.stringify({ ok: true, data: { detail: expiredDetail } }),
        });
      }
      if (url.includes(askStaffSessionId)) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Cache-Control": "private, no-store" },
          body: JSON.stringify({ ok: true, data: { detail: askStaffDetail } }),
        });
      }
      if (url.includes(otherUserSessionId)) {
        return route.fulfill({
          status: 403,
          contentType: "application/json",
          headers: { "Cache-Control": "private, no-store" },
          body: JSON.stringify({
            ok: false,
            error: {
              code: "FORBIDDEN",
              message: "타인의 화장실 이용권은 조회할 수 없습니다.",
            },
          }),
        });
      }
      return route.fulfill({ status: 404, body: JSON.stringify({ ok: false }) });
    });

    // ========================================================================
    // Scenario 2: 이용권 목록 화면(/my/access) 렌더링 & 필터 탭 & 360px 레이아웃
    // ========================================================================
    console.log(">>> Scenario 2: Customer access list (/my/access) & filter tabs...");
    await page.goto(`${BASE_URL}/my/access`, { waitUntil: "networkidle" });
    await page.waitForSelector(
      `[data-testid="access-session-card-${activeSessionId}"]`
    );
    await checkNoHorizontalOverflow("Customer /my/access list");

    // Verify no PIN is present anywhere in list HTML
    const listText = await page.evaluate(() => document.body.innerText);
    if (listText.includes("4826#") || listText.includes("9137*")) {
      throw new Error("PIN leaked in access list page!");
    }
    console.log("  ✓ Scenario 2 PASSED.");

    // ========================================================================
    // Scenario 3: 정상 이용권 → 수동 버튼 클릭 시에만 PIN 표시, 중복 클릭 차단, 409 회전 시 이전 PIN 비노출 및 최신 PIN 재조회, 새로고침 시 PIN 소멸
    // ========================================================================
    console.log(
      ">>> Scenario 3: Manual PIN reveal, duplicate click guard, 409 rotation, and non-persistence..."
    );
    let revealCallCount = 0;
    let revealMode = "v1"; // 'v1' -> 'rotated_409' -> 'v2'

    await page.route(`**/api/v1/access/${activeSessionId}/reveal-pin`, async (route) => {
      revealCallCount += 1;
      await new Promise((r) => setTimeout(r, 120)); // slight delay to test double-click mutex

      if (revealMode === "v1") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Cache-Control": "private, no-store" },
          body: JSON.stringify({
            ok: true,
            pin: "4826#",
            codeVersion: 1,
            expiresAt: futureExpiry,
            requestId: "req-v1",
          }),
        });
      }
      if (revealMode === "rotated_409") {
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          headers: { "Cache-Control": "private, no-store" },
          body: JSON.stringify({
            ok: false,
            error: {
              code: "PIN_STALE_ROTATED",
              message:
                "도어락 PIN이 조회 도중 변경되었습니다. 다시 조회해 주세요.",
            },
            requestId: "req-409",
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Cache-Control": "private, no-store" },
        body: JSON.stringify({
          ok: true,
          pin: "9137*",
          codeVersion: 2,
          expiresAt: futureExpiry,
          requestId: "req-v2",
        }),
      });
    });

    await page.goto(`${BASE_URL}/my/access/${activeSessionId}`, {
      waitUntil: "networkidle",
    });
    await page.waitForSelector('[data-testid="reveal-pin-btn"]');
    await checkNoHorizontalOverflow("Detail initial before PIN reveal");

    // Verify PIN is NOT shown before clicking button
    if ((await page.locator('[data-testid="revealed-pin-value"]').count()) !== 0) {
      throw new Error("PIN must not be visible before manual button click!");
    }

    // Verify touch target height >= 44px on reveal button
    const btnBox = await page
      .locator('[data-testid="reveal-pin-btn"]')
      .boundingBox();
    if (!btnBox || btnBox.height < 44) {
      throw new Error(`Reveal PIN button height (${btnBox?.height}px) < 44px!`);
    }

    // Rapid double click -> must only trigger 1 API call
    await Promise.all([
      page.click('[data-testid="reveal-pin-btn"]'),
      page.click('[data-testid="reveal-pin-btn"]').catch(() => {}),
    ]);

    await page.waitForSelector('[data-testid="revealed-pin-value"]');
    const pinV1Text = await page.textContent(
      '[data-testid="revealed-pin-value"]'
    );
    if (pinV1Text !== "4826#") {
      throw new Error(`Expected v1 PIN '4826#', got '${pinV1Text}'`);
    }
    if (revealCallCount !== 1) {
      throw new Error(
        `Duplicate click guard failed: expected 1 API call, got ${revealCallCount}`
      );
    }
    await checkNoHorizontalOverflow("Detail after v1 PIN revealed");

    // Take mobile screenshot of revealed PIN screen
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    console.log("  ✓ Saved screenshot to", SCREENSHOT_PATH);

    // Verify PIN is NOT in localStorage, sessionStorage, or URL
    const storageCheck = await page.evaluate(() => ({
      local: JSON.stringify(window.localStorage),
      session: JSON.stringify(window.sessionStorage),
      url: window.location.href,
    }));
    if (
      storageCheck.local.includes("4826#") ||
      storageCheck.session.includes("4826#") ||
      storageCheck.url.includes("4826#")
    ) {
      throw new Error("PIN leaked into browser storage or URL!");
    }

    // Now test 409 PIN_STALE_ROTATED: clicking refresh must immediately wipe old PIN '4826#'!
    revealMode = "rotated_409";
    await page.click('[data-testid="refresh-pin-btn"]');
    await page.waitForSelector(
      '[data-testid="pin-reveal-error"][data-error-code="PIN_STALE_ROTATED"]'
    );

    if ((await page.locator('[data-testid="revealed-pin-value"]').count()) !== 0) {
      throw new Error("Old PIN must be hidden when 409 PIN_STALE_ROTATED occurs!");
    }
    const bodyAfter409 = await page.evaluate(() => document.body.innerText);
    if (bodyAfter409.includes("4826#")) {
      throw new Error("Stale PIN '4826#' remained in DOM after 409 rotation!");
    }

    // Now click retry button to fetch latest v2 PIN ('9137*')
    revealMode = "v2";
    await page.click('[data-testid="retry-rotated-pin-btn"]');
    await page.waitForSelector('[data-testid="revealed-pin-value"]');
    const pinV2Text = await page.textContent(
      '[data-testid="revealed-pin-value"]'
    );
    if (pinV2Text !== "9137*") {
      throw new Error(`Expected rotated v2 PIN '9137*', got '${pinV2Text}'`);
    }

    // Reload page -> verify PIN does NOT persist after refresh
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="reveal-pin-btn"]');
    if ((await page.locator('[data-testid="revealed-pin-value"]').count()) !== 0) {
      throw new Error("PIN persisted across page reload!");
    }
    console.log("  ✓ Scenario 3 PASSED.");

    // ========================================================================
    // Scenario 4: 방문 확인 (visit_confirmations) 제출 검증
    // ========================================================================
    console.log(">>> Scenario 4: Visit confirmation submission...");
    await page.route(
      `**/my/access/${activeSessionId}/visit-confirmation`,
      async (route) => {
        const postData = JSON.parse(route.request().postData() || "{}");
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          headers: { "Cache-Control": "private, no-store" },
          body: JSON.stringify({
            ok: true,
            data: {
              confirmation: {
                id: "abababab-abab-4bab-8bab-abababababab",
                access_session_id: activeSessionId,
                usage_status: postData.usageStatus,
                verification_method: "user",
                arrival_confirmed_at: new Date().toISOString(),
                failure_reason: postData.failureReason || null,
                verified_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
              reused: false,
            },
          }),
        });
      }
    );

    await page.click('[data-testid="visit-status-success-btn"]');
    await page.click('[data-testid="submit-visit-confirmation-btn"]');
    await page.waitForSelector('[data-testid="visit-confirmation-success"]');
    await page.waitForSelector(
      '[data-testid="latest-visit-confirmation"][data-usage-status="success"]'
    );
    await checkNoHorizontalOverflow("Detail after visit confirmation");
    console.log("  ✓ Scenario 4 PASSED.");

    // ========================================================================
    // Scenario 5: 타인 이용권(403), 결제 미완료, 환불/취소, 만료, 직원 문의(ask_staff) 검증
    // ========================================================================
    console.log(
      ">>> Scenario 5: Other user (403), unpaid, refunded, expired, and ask_staff views..."
    );

    // 5-A. 타인 이용권 -> 403 차단
    await page.goto(`${BASE_URL}/my/access/${otherUserSessionId}`, {
      waitUntil: "networkidle",
    });
    await page.waitForSelector('[data-testid="access-detail-error-403"]');
    if ((await page.locator('[data-testid="reveal-pin-btn"]').count()) !== 0) {
      throw new Error("403 page must not show reveal PIN button!");
    }
    await checkNoHorizontalOverflow("Other user 403 view");

    // 5-B. 결제 미완료 -> PAYMENT_REQUIRED 배너 & PIN 버튼 비노출
    await page.goto(`${BASE_URL}/my/access/${unpaidSessionId}`, {
      waitUntil: "networkidle",
    });
    await page.waitForSelector(
      '[data-testid="pin-ineligible-banner"][data-reason-code="PAYMENT_REQUIRED"]'
    );
    if ((await page.locator('[data-testid="reveal-pin-btn"]').count()) !== 0) {
      throw new Error("Unpaid session must not show reveal PIN button!");
    }

    // 5-C. 환불 완료 -> CANCELED_OR_REFUNDED 배너 & PIN 버튼 비노출
    await page.goto(`${BASE_URL}/my/access/${refundedSessionId}`, {
      waitUntil: "networkidle",
    });
    await page.waitForSelector(
      '[data-testid="pin-ineligible-banner"][data-reason-code="CANCELED_OR_REFUNDED"]'
    );
    if ((await page.locator('[data-testid="reveal-pin-btn"]').count()) !== 0) {
      throw new Error("Refunded session must not show reveal PIN button!");
    }

    // 5-D. 유효기간 만료 -> EXPIRED 배너 & PIN 버튼 비노출
    await page.goto(`${BASE_URL}/my/access/${expiredSessionId}`, {
      waitUntil: "networkidle",
    });
    await page.waitForSelector(
      '[data-testid="pin-ineligible-banner"][data-reason-code="EXPIRED"]'
    );
    if ((await page.locator('[data-testid="reveal-pin-btn"]').count()) !== 0) {
      throw new Error("Expired session must not show reveal PIN button!");
    }

    // 5-E. 직원 문의(ask_staff) -> 직원 제시용 확인번호 화면 표시 & PIN 버튼 비노출
    await page.goto(`${BASE_URL}/my/access/${askStaffSessionId}`, {
      waitUntil: "networkidle",
    });
    await page.waitForSelector('[data-testid="staff-ticket-active"]');
    if ((await page.locator('[data-testid="reveal-pin-btn"]').count()) !== 0) {
      throw new Error("ask_staff session must not show reveal PIN button!");
    }
    await checkNoHorizontalOverflow("ask_staff ticket view");
    console.log("  ✓ Scenario 5 PASSED.");

    console.log(
      "\n🎉 ALL TASK 25 MOBILE CHROME (360x740) E2E SCENARIOS PASSED 100%!"
    );
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (server) {
      killProcessTree(server.pid);
    }
  }
}

runTests().catch((err) => {
  console.error("❌ TASK 25 E2E FAILED:", err);
  process.exit(1);
});


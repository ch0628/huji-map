/**
 * TASK 14: Mobile Chrome (360x740) E2E User Flow Verification
 * Tests the admin restroom review, coordinate & business verification,
 * publication approval, rejection, and suspension flows.
 */

import { spawn, execSync } from "node:child_process";
import { chromium } from "playwright";

const PORT = 3015;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const GLOBAL_TIMEOUT_MS = 60000;

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
  const server = spawn("cmd.exe", ["/c", `npx next start -p ${PORT} -H 127.0.0.1`], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    env: { ...process.env, PORT: String(PORT), ALLOW_E2E_MOCK: "1" },
  });

  server.stdout.on("data", (d) => {
    console.log("[server out]", d.toString().trim());
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
        console.log("✓ Next.js server ready at", BASE_URL, `(status: ${res.status})`);
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

    console.log(">>> 2. Launching Real Google Chrome (360x740 viewport) via Playwright...");
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
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        throw new Error(
          `[${stepName}] Horizontal overflow detected! scrollWidth=${scrollWidth}px > 360px`
        );
      }
      console.log(`  ✓ [${stepName}] 360px viewport check passed: no horizontal overflow.`);
    }

    // =========================================================================
    // Step 1: 비로그인(Guest) 관리자 화면 접근 차단 (401 Unauthorized UI)
    // =========================================================================
    console.log("\n>>> Step 1: Guest Access Protection to /admin/restrooms...");
    await page.goto(`${BASE_URL}/admin/restrooms`);
    await page.waitForSelector('[data-testid="admin-restrooms-unauthorized-401"]');
    await checkNoHorizontalOverflow("Step 1 - Guest 401");
    console.log("  ✓ Guest blocked with 401 UI and login link.");

    // =========================================================================
    // Step 2: 일반 회원(Customer) 접근 시 403 Forbidden 차단 검증
    // =========================================================================
    console.log("\n>>> Step 2: Customer Access Protection (403 Forbidden UI)...");
    await context.addCookies([
      { name: "e2e_mock_customer", value: "1", domain: "127.0.0.1", path: "/" },
    ]);
    await page.goto(`${BASE_URL}/admin/restrooms`);
    await page.waitForSelector('[data-testid="admin-restrooms-forbidden-403"]');
    await checkNoHorizontalOverflow("Step 2 - Customer 403");
    console.log("  ✓ Customer without admin role blocked with 403 Forbidden UI.");

    // Clear cookies and set admin mock cookie
    await context.clearCookies();
    await context.addCookies([
      { name: "e2e_mock_admin", value: "1", domain: "127.0.0.1", path: "/" },
    ]);

    // Mock Restroom Fixtures
    let mockRestroomComplete = {
      id: "a1111111-1111-1111-1111-111111111111",
      business_id: "b1111111-1111-1111-1111-111111111111",
      name: "수원역 카페 1층 화장실",
      type: "partner",
      publication_status: "pending",
      road_address: "경기도 수원시 팔달구 매산로 1",
      address_detail: "101호 복도 끝",
      latitude: 37.2636,
      longitude: 127.0286,
      floor: "1층",
      gender_type: "separate",
      access_method: "ask_staff",
      wheelchair_accessible: true,
      baby_changing_available: false,
      sanitary_products_available: true,
      business_name: "수원역 카페",
      business_registration_status: "approved",
      active_policy_mode: "test_deposit",
      active_deposit_amount_krw: 1000,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      business: {
        id: "b1111111-1111-1111-1111-111111111111",
        name: "수원역 카페",
        category: "카페",
        road_address: "경기도 수원시 팔달구 매산로 1",
        registration_status: "approved",
        phone: "031-123-4567",
      },
      policies: [
        {
          id: "p1",
          restroom_id: "a1111111-1111-1111-1111-111111111111",
          version: 1,
          access_mode: "test_deposit",
          deposit_amount_krw: 1000,
          refund_eligible: true,
          is_active: true,
        },
      ],
      hours: [],
      photos: [],
      audit_logs: [],
    };

    let mockRestroomIncomplete = {
      id: "a2222222-2222-2222-2222-222222222222",
      business_id: "b2222222-2222-2222-2222-222222222222",
      name: "좌표 미등록 화장실",
      type: "partner",
      publication_status: "pending",
      road_address: "경기도 수원시 팔달구 효원로 10",
      latitude: null, // MISSING COORDS!
      longitude: null,
      floor: "B1층",
      gender_type: "unisex",
      access_method: "open",
      business_name: "효원 베이커리",
      business_registration_status: "draft", // UNAPPROVED BUSINESS!
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      business: {
        id: "b2222222-2222-2222-2222-222222222222",
        name: "효원 베이커리",
        category: "베이커리",
        road_address: "경기도 수원시 팔달구 효원로 10",
        registration_status: "draft",
        phone: null,
      },
      policies: [],
      hours: [],
      photos: [],
      audit_logs: [],
    };

    // Route interceptors for Admin API
    await page.route("**/api/v1/admin/restrooms?*", async (route) => {
      const url = route.request().url();
      let list = [mockRestroomComplete, mockRestroomIncomplete];
      if (url.includes("status=published")) {
        list = list.filter((r) => r.publication_status === "published");
      } else if (url.includes("status=pending")) {
        list = list.filter((r) => r.publication_status === "pending");
      } else if (url.includes("status=suspended")) {
        list = list.filter((r) => r.publication_status === "suspended");
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: list,
          count: list.length,
          total: list.length,
        }),
      });
    });

    await page.route("**/api/v1/admin/restrooms/**", async (route) => {
      const url = route.request().url();
      const method = route.request().method();

      if (url.includes("/decision") && method === "POST") {
        const body = JSON.parse(route.request().postData() || "{}");
        const target = url.includes(mockRestroomComplete.id)
          ? mockRestroomComplete
          : mockRestroomIncomplete;

        if (body.decision === "publish") {
          target.publication_status = "published";
          target.approved_by = "admin-user";
          target.last_verified_at = new Date().toISOString();
          target.audit_logs.unshift({
            id: `aud-${Date.now()}`,
            action: "restroom_published",
            reason: body.review_notes || "관리자 공개 승인",
            created_at: new Date().toISOString(),
          });
        } else if (body.decision === "reject") {
          target.publication_status = "draft";
          target.audit_logs.unshift({
            id: `aud-${Date.now()}`,
            action: "restroom_rejected",
            reason: body.reason,
            created_at: new Date().toISOString(),
          });
        } else if (body.decision === "suspend") {
          target.publication_status = "suspended";
          target.audit_logs.unshift({
            id: `aud-${Date.now()}`,
            action: "restroom_suspended",
            reason: body.reason,
            created_at: new Date().toISOString(),
          });
        }

        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, data: target }),
        });
      }

      if (method === "GET") {
        const target = url.includes(mockRestroomComplete.id)
          ? mockRestroomComplete
          : mockRestroomIncomplete;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, data: target }),
        });
      }

      return route.fallback();
    });

    // =========================================================================
    // Step 3: 관리자 목록 화면 렌더링 및 360px 확인
    // =========================================================================
    console.log("\n>>> Step 3: Admin Restrooms Queue & 360px Layout Check...");
    await page.goto(`${BASE_URL}/admin/restrooms`);
    await page.waitForSelector('[data-testid="admin-restrooms-container"]');
    await page.waitForSelector('[data-testid="restrooms-list"]');
    await checkNoHorizontalOverflow("Step 3 - Admin Queue 360px");
    console.log("  ✓ Admin restrooms queue displayed cleanly in 360px.");

    // =========================================================================
    // Step 4: 필수 승인 정보 누락 화장실 검수 확인 (승인 불가 비활성화)
    // =========================================================================
    console.log("\n>>> Step 4: Missing Requirements Inspection Check...");
    await page.waitForSelector('[data-testid="missing-info-warning"]');
    const warningText = await page.textContent('[data-testid="missing-info-warning"]');
    if (!warningText?.includes("위치 좌표(위/경도) 미등록") || !warningText?.includes("소속 가게 미승인")) {
      throw new Error(`Expected missing coordinate & unapproved business warning, got: ${warningText}`);
    }
    console.log("  ✓ Missing info warning rendered correctly on incomplete restroom card.");

    // Open incomplete restroom inspection modal
    await page.click(`[data-testid="inspect-restroom-btn-${mockRestroomIncomplete.id}"]`);
    await page.waitForSelector('[data-testid="admin-restroom-detail-modal"]');
    await checkNoHorizontalOverflow("Step 4 - Incomplete Detail Modal");

    const isPublishDisabled = await page.isDisabled('[data-testid="decision-btn-publish"]');
    if (!isPublishDisabled) {
      throw new Error("Publish button must be disabled for incomplete restrooms!");
    }
    console.log("  ✓ Publish button strictly disabled for incomplete restroom.");
    await page.click('[data-testid="close-detail-modal-btn"]');

    // =========================================================================
    // Step 5: 정상 화장실 검수 및 공개 승인 (publish)
    // =========================================================================
    console.log("\n>>> Step 5: Complete Restroom Inspection & Publish Approval...");
    await page.click(`[data-testid="inspect-restroom-btn-${mockRestroomComplete.id}"]`);
    await page.waitForSelector('[data-testid="admin-restroom-detail-modal"]');

    await page.click('[data-testid="decision-btn-publish"]');
    await page.waitForSelector('[data-testid="confirm-decision-submit-btn"]');
    await page.fill('[data-testid="decision-notes-input"]', "현장 시설 확인 완료 후 공개 승인");
    await page.click('[data-testid="confirm-decision-submit-btn"]');

    await page.waitForSelector('[data-testid="decision-success-alert"]');
    const successText = await page.textContent('[data-testid="decision-success-alert"]');
    if (!successText?.includes("공개 승인")) {
      throw new Error(`Expected publish success alert, got: ${successText}`);
    }
    console.log("  ✓ Restroom published successfully by administrator.");
    await page.click('[data-testid="close-detail-modal-btn"]');

    // =========================================================================
    // Step 6: 공개된 화장실 '공개 중 (published)' 탭 확인 및 중단 (suspend)
    // =========================================================================
    console.log("\n>>> Step 6: Published Tab Inspection & Suspension Flow...");
    await page.click('[data-testid="tab-published"]');
    await page.waitForSelector(`[data-testid="admin-restroom-card-${mockRestroomComplete.id}"]`);

    await page.click(`[data-testid="inspect-restroom-btn-${mockRestroomComplete.id}"]`);
    await page.waitForSelector('[data-testid="admin-restroom-detail-modal"]');

    await page.click('[data-testid="decision-btn-suspend"]');
    await page.waitForSelector('[data-testid="decision-reason-textarea"]');
    await page.fill('[data-testid="decision-reason-textarea"]', "수도 배관 동파로 인한 일시 이용 중단");
    await page.click('[data-testid="confirm-decision-submit-btn"]');

    await page.waitForSelector('[data-testid="decision-success-alert"]');
    console.log("  ✓ Restroom suspended with required reason.");
    await page.click('[data-testid="close-detail-modal-btn"]');

    // =========================================================================
    // Step 7: 미완성 화장실 반려 (reject) 흐름 검증
    // =========================================================================
    console.log("\n>>> Step 7: Incomplete Restroom Rejection Flow...");
    await page.click('[data-testid="tab-pending"]');
    await page.waitForSelector(`[data-testid="admin-restroom-card-${mockRestroomIncomplete.id}"]`);

    await page.click(`[data-testid="inspect-restroom-btn-${mockRestroomIncomplete.id}"]`);
    await page.waitForSelector('[data-testid="admin-restroom-detail-modal"]');

    await page.click('[data-testid="decision-btn-reject"]');
    await page.waitForSelector('[data-testid="decision-reason-textarea"]');
    await page.fill('[data-testid="decision-reason-textarea"]', "정확한 WGS84 위경도 좌표를 입력 후 다시 신청해주세요.");
    await page.click('[data-testid="confirm-decision-submit-btn"]');

    await page.waitForSelector('[data-testid="decision-success-alert"]');
    console.log("  ✓ Restroom rejected and transitioned to draft.");
    await page.click('[data-testid="close-detail-modal-btn"]');

    console.log("\n============================================================");
    console.log("✓ ALL TASK 14 MOBILE CHROME E2E TESTS PASSED (100%)");
    console.log("============================================================\n");
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
    if (server && server.pid) {
      killProcessTree(server.pid);
    }
  }
}

const timer = setTimeout(() => {
  console.error(`\n❌ Global E2E timeout exceeded (${GLOBAL_TIMEOUT_MS / 1000}s)! Force exiting.`);
  process.exit(1);
}, GLOBAL_TIMEOUT_MS);
timer.unref();

runTests()
  .then(() => {
    clearTimeout(timer);
    console.log("✓ E2E process finished and cleanly exiting.");
    process.exit(0);
  })
  .catch((err) => {
    clearTimeout(timer);
    console.error("\n❌ E2E Test Failed:", err);
    process.exit(1);
  });


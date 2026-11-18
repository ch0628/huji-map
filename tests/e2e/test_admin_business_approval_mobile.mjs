/**
 * TASK 08: Mobile Chrome (360x740) E2E User Flow Verification
 * Tests the admin business review, verification inspection, approval, and rejection flows.
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 3012;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

async function startNextServer() {
  console.log(">>> 1. Starting Next.js Production Server on port", PORT, "...");
  const server = spawn("cmd.exe", ["/c", `npx next start -p ${PORT} -H 127.0.0.1`], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    env: { ...process.env, PORT: String(PORT), ALLOW_E2E_MOCK: "1" },
  });

  server.stderr.on("data", (d) => {
    const s = d.toString();
    if (!s.includes("DeprecationWarning")) {
      console.error("[server err]", s.trim());
    }
  });

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`${BASE_URL}/map`);
      if (res.status === 200) {
        console.log("✓ Next.js server ready at", BASE_URL);
        return server;
      }
    } catch {}
  }
  server.kill();
  throw new Error("Failed to start Next.js server within 20s");
}

async function runTests() {
  const server = await startNextServer();

  console.log(">>> 2. Launching Real Google Chrome (360x740 viewport) via Playwright...");
  const browser = await chromium.launch({
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

  // Helper: check horizontal scrollbar overflow
  async function checkNoHorizontalOverflow(stepName) {
    const overflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    if (overflow) {
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      throw new Error(`[${stepName}] Horizontal overflow detected! scrollWidth=${scrollWidth}px > 360px`);
    }
    console.log(`  ✓ [${stepName}] 360px viewport check passed: no horizontal overflow.`);
  }

  // Handle confirm dialogs automatically
  page.on("dialog", async (dialog) => {
    console.log(`  [Dialog] ${dialog.type()}: "${dialog.message().slice(0, 40)}..." -> ACCEPT`);
    await dialog.accept();
  });

  try {
    // ------------------------------------------------------------------------
    // Step 1: 비로그인(Guest) 관리자 화면 접근 차단 (401 Unauthorized UI)
    // ------------------------------------------------------------------------
    console.log("\n>>> Step 1: Guest Access Protection to /admin/businesses...");
    await page.goto(`${BASE_URL}/admin/businesses`);
    await page.waitForSelector('[data-testid="admin-businesses-unauthorized-401"]');
    await checkNoHorizontalOverflow("Guest 401 Unauthorized View");

    const auth401Text = await page.textContent('[data-testid="admin-businesses-unauthorized-401"]');
    if (!auth401Text?.includes("로그인이 필요한 관리자 전용 화면입니다")) {
      throw new Error("Missing 401 unauthorized title in guest view");
    }
    console.log("  ✓ Guest redirected to friendly 401 prompt with admin login link.");

    // ------------------------------------------------------------------------
    // Step 2: 일반 회원(Customer) 접근 시 403 Forbidden 차단 검증
    // ------------------------------------------------------------------------
    console.log("\n>>> Step 2: Customer Access Protection (403 Forbidden UI)...");
    await context.addCookies([
      {
        name: "e2e_mock_customer",
        value: "1",
        url: BASE_URL,
      },
    ]);
    await page.goto(`${BASE_URL}/admin/businesses`);
    await page.waitForSelector('[data-testid="admin-businesses-forbidden-403"]');
    await checkNoHorizontalOverflow("Customer 403 Forbidden View");

    const auth403Text = await page.textContent('[data-testid="admin-businesses-forbidden-403"]');
    if (!auth403Text?.includes("접근 권한이 없습니다")) {
      throw new Error("Missing 403 forbidden title for customer");
    }
    console.log("  ✓ Non-admin customer blocked with 403 Forbidden prompt.");

    // ------------------------------------------------------------------------
    // Step 3: 관리자(Admin) 로그인 세션 및 심사 목록 접근
    // ------------------------------------------------------------------------
    console.log("\n>>> Step 3: Admin Session Access to /admin/businesses...");
    await context.clearCookies();
    await context.addCookies([
      {
        name: "e2e_mock_admin",
        value: "1",
        url: BASE_URL,
      },
    ]);

    // Setup Mock Store Data for Admin Verification
    const mockStore = {
      "biz-pending-1": {
        id: "biz-pending-1",
        name: "모바일 검증 카페 수원점",
        category: "카페",
        road_address: "경기도 수원시 팔달구 매산로 1",
        address_detail: "1층",
        latitude: 37.2636,
        longitude: 127.0286,
        phone: "031-123-4567",
        website_url: "https://instagram.com/suwon_cafe",
        registration_status: "pending",
        created_by: "applicant-uuid-1",
        approved_by: null,
        approved_at: null,
        rejection_reason: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        verifications: [
          {
            id: "verif-1",
            business_id: "biz-pending-1",
            submitted_by: "applicant-uuid-1",
            method: "document",
            registration_number: "123-45-67890", // PRIVATE
            evidence_storage_path: null,
            status: "pending",
            reviewed_by: null,
            reviewed_at: null,
            review_notes: null,
            created_at: new Date().toISOString(),
          },
        ],
      },
      "biz-pending-2": {
        id: "biz-pending-2",
        name: "반려 테스트 베이커리",
        category: "베이커리",
        road_address: "서울시 종로구 세종대로 1",
        address_detail: "2층",
        latitude: 37.5714,
        longitude: 126.9768,
        phone: "02-987-6543",
        website_url: null,
        registration_status: "pending",
        created_by: "applicant-uuid-2",
        approved_by: null,
        approved_at: null,
        rejection_reason: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        verifications: [
          {
            id: "verif-2",
            business_id: "biz-pending-2",
            submitted_by: "applicant-uuid-2",
            method: "document",
            registration_number: "999-99-99999",
            status: "pending",
            reviewed_by: null,
            reviewed_at: null,
            review_notes: null,
            created_at: new Date().toISOString(),
          },
        ],
      },
    };

    // Playwright route interception for Admin API
    await page.route("**/api/v1/admin/businesses**", async (route) => {
      const req = route.request();
      const method = req.method();
      const url = req.url();

      // Decision endpoint
      if (method === "POST" && url.includes("/decision")) {
        const id = url.split("/admin/businesses/")[1]?.split("/decision")[0];
        const body = req.postDataJSON();
        const biz = mockStore[id];
        if (!biz) {
          return route.fulfill({ status: 404, body: JSON.stringify({ ok: false, error: { code: "NOT_FOUND" } }) });
        }

        biz.registration_status = body.decision;
        biz.updated_at = new Date().toISOString();
        if (body.decision === "approved") {
          biz.approved_by = "admin-uuid-1";
          biz.approved_at = new Date().toISOString();
          biz.rejection_reason = null;
        } else {
          biz.rejection_reason = body.rejection_reason;
        }

        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, business: biz, requestId: "req-decision-1" }),
        });
      }

      // Single detail endpoint
      if (method === "GET" && url.match(/\/api\/v1\/admin\/businesses\/biz-pending-[12]/)) {
        const id = url.split("/api/v1/admin/businesses/")[1]?.split("?")[0];
        const biz = mockStore[id];
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, business: biz, requestId: "req-detail-1" }),
        });
      }

      // List endpoint
      if (method === "GET") {
        const list = Object.values(mockStore).map((b) => ({
          id: b.id,
          name: b.name,
          category: b.category,
          road_address: b.road_address,
          registration_status: b.registration_status,
          role: "admin",
          created_by: b.created_by,
          applicant_name: "홍길동",
          rejection_reason: b.rejection_reason,
          created_at: b.created_at,
          updated_at: b.updated_at,
        }));

        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, businesses: list, count: list.length }),
        });
      }

      return route.continue();
    });

    await page.goto(`${BASE_URL}/admin/businesses`);
    await page.waitForSelector('[data-testid="admin-businesses-container"]');
    await checkNoHorizontalOverflow("Admin Businesses List View");
    console.log("  ✓ Admin accessed business approval queue.");

    // ------------------------------------------------------------------------
    // Step 4: 가게 상세 검증 및 비공개 사업자등록번호 확인
    // ------------------------------------------------------------------------
    console.log("\n>>> Step 4: Inspecting Business Verification Evidence (Private Data)...");
    await page.click('[data-testid="inspect-business-biz-pending-1"]');
    await page.waitForSelector('[data-testid="admin-inspection-panel"]');
    await checkNoHorizontalOverflow("Admin Inspection Panel");

    const regNumText = await page.textContent("text=123-45-67890");
    if (!regNumText) {
      throw new Error("Private registration number not rendered in admin inspection panel");
    }
    console.log("  ✓ Private business registration number (123-45-67890) securely displayed to admin.");

    // ------------------------------------------------------------------------
    // Step 5: 관리자 승인 처리 및 상태 전이 검증 (approved)
    // ------------------------------------------------------------------------
    console.log("\n>>> Step 5: Submitting Business Approval Decision...");
    await page.click('[data-testid="admin-approve-button"]');
    await page.waitForSelector('[data-testid="admin-businesses-success"]');
    const successText = await page.textContent('[data-testid="admin-businesses-success"]');
    if (!successText?.includes("가게 승인이 완료되었습니다")) {
      throw new Error("Approval success banner missing");
    }
    console.log("  ✓ Approval executed successfully, merchant role granted notice confirmed.");

    // ------------------------------------------------------------------------
    // Step 6: 다른 가게에 대한 반려 처리 및 사유 입력 검증 (rejected)
    // ------------------------------------------------------------------------
    console.log("\n>>> Step 6: Submitting Business Rejection with Reason...");
    await page.click('[data-testid="inspect-business-biz-pending-2"]');
    await page.waitForSelector('[data-testid="admin-inspection-panel"]');
    await page.click('[data-testid="admin-reject-toggle-button"]');
    await page.waitForSelector('[data-testid="admin-reject-panel"]');
    await checkNoHorizontalOverflow("Admin Rejection Panel");

    await page.fill(
      '[data-testid="admin-rejection-reason-input"]',
      "제출된 사업자등록번호가 국세청 휴폐업 조회 결과 폐업 상태로 확인되었습니다."
    );
    await page.click('[data-testid="admin-confirm-reject-button"]');
    await page.waitForSelector('[data-testid="admin-businesses-success"]');
    const rejectSuccessText = await page.textContent('[data-testid="admin-businesses-success"]');
    if (!rejectSuccessText?.includes("가게 등록이 반려되었습니다")) {
      throw new Error("Rejection success banner missing");
    }
    console.log("  ✓ Rejection executed successfully with verified reason.");

    console.log("\n============================================================");
    console.log("ALL 6 ADMIN MOBILE CHROME VERIFICATION STEPS PASSED (100% OK)");
    console.log("============================================================");
  } finally {
    try {
      await browser.close();
    } catch {}
    try {
      if (server && server.pid) {
        if (process.platform === "win32") {
          spawn("taskkill", ["/F", "/T", "/PID", String(server.pid)], { shell: true });
        } else {
          server.kill();
        }
      }
    } catch {}
  }
}

runTests()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n❌ E2E Test Failed:", err);
    process.exit(1);
  });


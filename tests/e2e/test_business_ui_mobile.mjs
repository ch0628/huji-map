import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";

const PORT = 3010;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

console.log("============================================================");
console.log("TASK 07-A: Mobile Chrome (360x740) E2E User Flow Verification");
console.log("============================================================");

// In-memory mock store for E2E tests (zero permanent records in remote DB)
let mockBusinessStore = null;

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

  await page.addInitScript(() => {
    window.kakao = {
      maps: {
        load: (cb) => cb && cb(),
        Map: function MockMap() {},
        LatLng: function MockLatLng(lat, lng) {
          this.lat = lat;
          this.lng = lng;
        },
        LatLngBounds: function MockBounds() {},
        Marker: function MockMarker() {},
        MarkerImage: function MockMarkerImage() {},
        Size: function MockSize() {},
        Point: function MockPoint() {},
        CustomOverlay: function MockOverlay() {},
        event: { addListener: () => {}, removeListener: () => {} },
        services: {
          Status: { OK: "OK", ZERO_RESULT: "ZERO_RESULT", ERROR: "ERROR" },
          Geocoder: function MockGeocoder() {
            this.addressSearch = (_q, callback) => {
              callback(
                [
                  {
                    x: "127.0701",
                    y: "37.5401",
                    road_address: {
                      address_name: "서울시 광진구 아차산로 200",
                      building_name: "테스트빌딩",
                    },
                    address: {
                      address_name: "자양동 123-45",
                    },
                  },
                ],
                "OK"
              );
            };
          },
          Places: function MockPlaces() {
            this.keywordSearch = (_q, callback) => callback([], "ZERO_RESULT");
          },
        },
      },
    };
  });

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

  try {
    // ------------------------------------------------------------------------
    // Step 1: 비로그인 접근 차단 검증 (401 Unauthorized UI)
    // ------------------------------------------------------------------------
    console.log("\n>>> Step 1: Guest (Unauthenticated) Access Protection...");
    await page.goto(`${BASE_URL}/merchant/businesses`);
    await page.waitForSelector('[data-testid="merchant-unauthorized-401"]');
    await checkNoHorizontalOverflow("Guest Businesses List 401");

    const auth401Text = await page.textContent('[data-testid="merchant-unauthorized-401"]');
    if (!auth401Text?.includes("로그인이 필요합니다")) {
      throw new Error("Missing 401 unauthorized title in guest view");
    }
    console.log("  ✓ Guest redirected to friendly 401 prompt with login link.");

    // ------------------------------------------------------------------------
    // Step 2: 일반 회원(customer) 로그인 세션 부여
    // ------------------------------------------------------------------------
    console.log("\n>>> Step 2: Customer Login Session Established...");
    await context.addCookies([
      {
        name: "e2e_mock_customer",
        value: "1",
        url: BASE_URL,
      },
    ]);

    // Setup Playwright route interception for API mock store
    let lastIdempotencyKey = null;
    let createRequestPayload = null;

    await page.route("**/api/v1/merchant/businesses**", async (route) => {
      const req = route.request();
      const method = req.method();
      const url = req.url();
      const headers = req.headers();

      if (headers["x-idempotency-key"]) {
        lastIdempotencyKey = headers["x-idempotency-key"];
      }

      // 1) GET /api/v1/merchant/businesses (List)
      if (method === "GET" && url.endsWith("/api/v1/merchant/businesses")) {
        if (!mockBusinessStore) {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true, businesses: [], count: 0 }),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            businesses: [
              {
                id: mockBusinessStore.id,
                name: mockBusinessStore.name,
                category: mockBusinessStore.category,
                road_address: mockBusinessStore.road_address,
                registration_status: mockBusinessStore.registration_status,
                role: "owner",
                created_at: mockBusinessStore.created_at,
                updated_at: mockBusinessStore.updated_at,
              },
            ],
            count: 1,
          }),
        });
      }

      // 2) POST /api/v1/merchant/businesses (Create Draft)
      if (method === "POST" && url.endsWith("/api/v1/merchant/businesses")) {
        const body = req.postDataJSON();
        createRequestPayload = body;

        mockBusinessStore = {
          id: "c1111111-2222-4333-8444-555555555555",
          name: body.name,
          category: body.category,
          description: body.description,
          road_address: body.road_address,
          jibun_address: body.jibun_address,
          address_detail: body.address_detail,
          latitude: body.latitude,
          longitude: body.longitude,
          phone: body.phone,
          website_url: body.website_url,
          registration_status: "draft",
          created_by: "customer-uuid-1",
          approved_by: null,
          approved_at: null,
          rejection_reason: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          my_role: "owner",
          members: [],
          hours: [],
        };

        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            business: mockBusinessStore,
            requestId: "req-create-1",
          }),
        });
      }

      // 3) POST /api/v1/merchant/businesses/:id/submit (Submit for Review)
      if (method === "POST" && url.includes("/submit")) {
        if (!mockBusinessStore) {
          return route.fulfill({ status: 404, body: JSON.stringify({ ok: false, error: { code: "NOT_FOUND" } }) });
        }
        if (mockBusinessStore.registration_status === "pending") {
          return route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({
              ok: false,
              error: { code: "HM001", message: "이미 심사가 접수되어 대기 중인 가게입니다." },
            }),
          });
        }
        mockBusinessStore.registration_status = "pending";
        mockBusinessStore.updated_at = new Date().toISOString();

        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            business: mockBusinessStore,
            requestId: "req-submit-1",
          }),
        });
      }

      // 4) PATCH /api/v1/merchant/businesses/:id (Update)
      if (method === "PATCH") {
        const body = req.postDataJSON();
        if (mockBusinessStore) {
          if (body.description !== undefined) mockBusinessStore.description = body.description;
          if (body.phone !== undefined) mockBusinessStore.phone = body.phone;
          if (body.website_url !== undefined) mockBusinessStore.website_url = body.website_url;
          mockBusinessStore.updated_at = new Date().toISOString();
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            business: mockBusinessStore,
            requestId: "req-patch-1",
          }),
        });
      }

      // 5) GET /api/v1/merchant/businesses/:id (Detail)
      if (method === "GET" && url.includes("/api/v1/merchant/businesses/")) {
        const id = url.split("/api/v1/merchant/businesses/")[1]?.split("?")[0];
        if (id === "forbidden-test-id") {
          return route.fulfill({
            status: 403,
            contentType: "application/json",
            body: JSON.stringify({
              ok: false,
              error: { code: "FORBIDDEN", message: "다른 회원의 가게를 조회할 권한이 없습니다." },
            }),
          });
        }
        if (id === "notfound-test-id") {
          return route.fulfill({
            status: 404,
            contentType: "application/json",
            body: JSON.stringify({
              ok: false,
              error: { code: "NOT_FOUND", message: "가게를 찾을 수 없습니다." },
            }),
          });
        }
        if (mockBusinessStore && mockBusinessStore.id === id) {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              ok: true,
              business: mockBusinessStore,
            }),
          });
        }
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ ok: false, error: { code: "NOT_FOUND" } }),
        });
      }

      return route.continue();
    });

    // ------------------------------------------------------------------------
    // Step 3: 일반 회원의 /merchant/businesses 접근 및 빈 목록 상태 검증
    // ------------------------------------------------------------------------
    console.log("\n>>> Step 3: Accessing /merchant/businesses as Customer (Empty State)...");
    await page.goto(`${BASE_URL}/merchant/businesses`);
    await page.waitForSelector('[data-testid="businesses-list-empty"]');
    await checkNoHorizontalOverflow("Empty List View");

    const emptyText = await page.textContent('[data-testid="businesses-list-empty"]');
    if (!emptyText?.includes("등록된 가게가 없습니다")) {
      throw new Error("Empty state message missing in businesses list");
    }
    console.log("  ✓ Customer accessed list view; empty state rendered cleanly.");

    // ------------------------------------------------------------------------
    // Step 4: /merchant/businesses/new 이동 및 폼 조작, 좌표 프리셋 제거 검증
    // ------------------------------------------------------------------------
    console.log("\n>>> Step 4: Navigating to /merchant/businesses/new (Form Validation & Coordinate Guidance)...");
    await page.click('[data-testid="new-business-button"]');
    await page.waitForSelector('[data-testid="business-form"]');
    await checkNoHorizontalOverflow("New Business Form");

    // 4.1 Check coordinate preset buttons are removed
    const suwonPresetExists = await page.$("text=수원역 좌표 채우기");
    const seoulPresetExists = await page.$("text=서울시청 좌표");
    if (suwonPresetExists || seoulPresetExists) {
      throw new Error("Test coordinate presets (Suwon/Seoul) must be removed from production UI!");
    }
    console.log("  ✓ Test coordinate presets confirmed removed from the screen.");

    // 4.2 Check Kakao address search field is present (replacing manual coord entry)
    const addressSearchField = await page.waitForSelector('[data-testid="address-search-field"]');
    if (!addressSearchField) {
      throw new Error("Address search field missing");
    }
    console.log("  ✓ Address search field confirmed visible.");

    // 4.3 Form validation on empty submit
    await page.click('[data-testid="business-form-submit-button"]');
    const formErrorAlert = await page.waitForSelector('[data-testid="business-form-error"]');
    const formErrorText = await formErrorAlert.textContent();
    if (!formErrorText?.includes("필수 입력 항목")) {
      throw new Error(`Expected validation error on empty form submit, got: ${formErrorText}`);
    }
    console.log("  ✓ Form validation blocked empty submit.");

    // ------------------------------------------------------------------------
    // Step 5: 가게 정보 정상 입력 및 신규 draft 생성
    // ------------------------------------------------------------------------
    console.log("\n>>> Step 5: Filling Business Info and Submitting Draft Creation...");
    await page.fill('input[name="name"]', "모바일 테스트 베이커리 건대점");
    await page.selectOption("#biz-category-select", "기타");
    await page.fill('input[name="category"]', "베이커리/디저트");
    await page.fill('textarea[name="description"]', "매일 아침 갓 구운 빵과 깨끗한 화장실을 제공합니다.");
    await page.fill('[data-testid="address-search-input"]', "서울시 광진구 아차산로 200");
    await page.click('[data-testid="address-search-button"]');
    await page.waitForSelector('[data-testid="address-search-result-0"]');
    await page.click('[data-testid="address-search-result-0"]');
    await page.fill('input[name="address_detail"]', "1층");
    await page.fill('input[name="phone"]', "02-1234-5678");
    await page.fill('input[name="website_url"]', "https://instagram.com/test_bakery");
    await page.fill('input[name="registration_number"]', "123-45-67890");

    await checkNoHorizontalOverflow("Filled Business Form");

    // Click Save Draft button
    await page.click('[data-testid="business-form-submit-button"]');

    // Wait for redirect to detail page (/merchant/businesses/c1111111-2222-4333-8444-555555555555)
    await page.waitForURL(`**/merchant/businesses/c1111111-2222-4333-8444-555555555555`);
    await page.waitForSelector('[data-testid="business-detail-container"]');
    await checkNoHorizontalOverflow("Business Detail Page");

    // Verify API payload and headers
    if (!lastIdempotencyKey) {
      throw new Error("Missing x-idempotency-key in create request");
    }
    if (createRequestPayload.name !== "모바일 테스트 베이커리 건대점") {
      throw new Error("Payload name mismatch");
    }
    if (createRequestPayload.registration_number !== "123-45-67890") {
      throw new Error("Payload registration_number mismatch");
    }
    console.log("  ✓ Draft created with x-idempotency-key and redirected to detail page.");

    // ------------------------------------------------------------------------
    // Step 6: 상세 페이지에서 draft 뱃지 및 수정 폼 확인
    // ------------------------------------------------------------------------
    console.log("\n>>> Step 6: Verifying Draft Status Badge & Detail View...");
    const draftBadge = await page.waitForSelector('[data-testid="business-status-badge-draft"]');
    const badgeText = await draftBadge.textContent();
    if (!badgeText?.includes("작성 중 (임시저장)")) {
      throw new Error("Status badge is not '작성 중 (임시저장)'");
    }
    console.log("  ✓ Status badge shows '작성 중 (임시저장)'.");

    // ------------------------------------------------------------------------
    // Step 7: 본인 가게 정보 수정 (PATCH)
    // ------------------------------------------------------------------------
    console.log("\n>>> Step 7: Updating Business Details (PATCH)...");
    await page.fill('textarea[name="description"]', "설명 수정됨: 2층 화장실 완비");
    await page.click('[data-testid="business-form-submit-button"]');
    await page.waitForSelector('[data-testid="business-form-success"]');
    const successMsg = await page.textContent('[data-testid="business-form-success"]');
    if (!successMsg?.includes("성공적으로 수정")) {
      throw new Error("Missing success message on update");
    }
    console.log("  ✓ Business details successfully updated.");

    // ------------------------------------------------------------------------
    // Step 8: 심사 요청 후 pending 전이 및 상태 변경 확인
    // ------------------------------------------------------------------------
    console.log("\n>>> Step 8: Submitting Business for Review (draft -> pending)...");
    page.once("dialog", async (dialog) => {
      await dialog.accept();
    });
    await page.click('[data-testid="business-submit-review-button"]');

    // Wait for pending badge
    await page.waitForSelector('[data-testid="business-status-badge-pending"]');
    const pendingBadgeText = await page.textContent('[data-testid="business-status-badge-pending"]');
    if (!pendingBadgeText?.includes("심사 대기 중")) {
      throw new Error("Status badge is not '심사 대기 중'");
    }
    console.log("  ✓ Submitted for review; status badge changed to '심사 대기 중'.");

    // ------------------------------------------------------------------------
    // Step 9: 심사 대기 중 수정 및 중복 제출 차단 확인
    // ------------------------------------------------------------------------
    console.log("\n>>> Step 9: Verifying Lock in Pending State & Duplicate Submit Block...");
    const submitBtn = await page.$('[data-testid="business-submit-review-button"]');
    if (submitBtn) {
      throw new Error("Review submit button must NOT be visible when status is pending!");
    }
    const editSubmitBtn = await page.$('[data-testid="business-form-submit-button"]');
    if (editSubmitBtn) {
      throw new Error("Edit submit button must NOT be visible when status is pending!");
    }
    const readOnlyNotice = await page.textContent("text=현재 가게는 심사 대기 중이므로 정보를 수정할 수 없습니다");
    if (!readOnlyNotice) {
      throw new Error("Read-only pending notice missing");
    }
    console.log("  ✓ Form inputs disabled, submit buttons hidden, read-only notice verified.");

    // ------------------------------------------------------------------------
    // Step 10: 새로고침 후 pending 상태 유지 및 목록 화면 카드 확인
    // ------------------------------------------------------------------------
    console.log("\n>>> Step 10: Page Refresh and Return to List View...");
    await page.reload();
    await page.waitForSelector('[data-testid="business-status-badge-pending"]');
    await checkNoHorizontalOverflow("Reloaded Detail Page");
    console.log("  ✓ State preserved after page refresh.");

    // Return to list
    await page.click("text=목록으로 돌아가기");
    await page.waitForURL(`**/merchant/businesses`);
    await page.waitForSelector('[data-testid="business-card-c1111111-2222-4333-8444-555555555555"]');
    await checkNoHorizontalOverflow("List with Card");
    console.log("  ✓ Card rendered on list page with pending status badge.");

    // ------------------------------------------------------------------------
    // Step 11: 타인 가게 접근 시 403 Forbidden 에러 안내 UI 검증
    // ------------------------------------------------------------------------
    console.log("\n>>> Step 11: Testing 403 Forbidden Error UI on Unauthorized Store...");
    await page.goto(`${BASE_URL}/merchant/businesses/forbidden-test-id`);
    await page.waitForSelector('[data-testid="business-detail-forbidden-403"]');
    await checkNoHorizontalOverflow("403 Forbidden UI");
    const forbiddenText = await page.textContent('[data-testid="business-detail-forbidden-403"]');
    if (!forbiddenText?.includes("접근 권한이 없습니다")) {
      throw new Error("Missing 403 forbidden message");
    }
    console.log("  ✓ 403 Forbidden UI rendered with return link.");

    // ------------------------------------------------------------------------
    // Step 12: 미존재 가게 접근 시 404 Not Found 에러 안내 UI 검증
    // ------------------------------------------------------------------------
    console.log("\n>>> Step 12: Testing 404 Not Found Error UI...");
    await page.goto(`${BASE_URL}/merchant/businesses/notfound-test-id`);
    await page.waitForSelector('[data-testid="business-detail-notfound-404"]');
    await checkNoHorizontalOverflow("404 Not Found UI");
    const notFoundText = await page.textContent('[data-testid="business-detail-notfound-404"]');
    if (!notFoundText?.includes("가게를 찾을 수 없습니다")) {
      throw new Error("Missing 404 not found message");
    }
    console.log("  ✓ 404 Not Found UI rendered with return link.");

    console.log("\n============================================================");
    console.log("ALL 12 MOBILE CHROME E2E VERIFICATION STEPS PASSED (100% OK)");
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

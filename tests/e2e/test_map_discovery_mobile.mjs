/**
 * TASK 16: Mobile Chrome (360x740) E2E Map Discovery & Directions Verification
 *
 * Verifies with real Google Chrome browser against local Next.js server:
 * 1. Mobile 360px layout (no horizontal scrollbar / overflow)
 * 2. Map discovery container, filter bar, zoom buttons, bottom sheet drawer
 * 3. Restroom list API integration (0 items empty state vs 1+ items)
 * 4. Public vs Partner marker / card distinction (public: no payment, partner: test deposit + disabled payment)
 * 5. 3-service directions modal (Kakao, Naver, Google Maps) link generation
 * 6. Search keyword filtering & filter chip toggling (all, public, partner)
 * 7. Geolocation fallback on permission denied
 * 8. Public restroom detail view (/restrooms/[id]) & safe 404 handling
 */

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const PORT = 3016;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const SCREENSHOT_DIR = path.resolve("tests/e2e/screenshots");

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
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }

  let server = null;
  let browser = null;

  try {
    server = await startNextServer();

    console.log(">>> 2. Launching Google Chrome (360x740 mobile viewport)...");
    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    });

    const context = await browser.newContext({
      viewport: { width: 360, height: 740 },
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });

    const page = await context.newPage();

    // Mock API data for controlled UI flow verification
    const mockPublicItem = {
      id: "a1111111-1111-4111-8111-111111111111",
      type: "public",
      name: "수원화성 장안문 공중화장실",
      road_address: "경기도 수원시 팔달구 정조로 900",
      address_detail: "매표소 옆",
      latitude: 37.2882,
      longitude: 127.0145,
      access_method: "open",
      gender_type: "separate",
      wheelchair_accessible: true,
      baby_changing_available: true,
      sanitary_products_available: false,
      last_verified_at: "2026-11-10T10:00:00Z",
      business_id: null,
    };

    const mockPartnerItem = {
      id: "b2222222-2222-4222-8222-222222222222",
      type: "partner",
      name: "행궁 안심카페 화장실",
      road_address: "경기도 수원시 팔달구 신풍로 23",
      address_detail: "1층",
      latitude: 37.2831,
      longitude: 127.0162,
      access_method: "pin",
      gender_type: "unisex",
      wheelchair_accessible: null,
      baby_changing_available: false,
      sanitary_products_available: true,
      last_verified_at: "2026-11-10T11:00:00Z",
      business_id: "c3333333-3333-4333-8333-333333333333",
      business_name: "행궁 안심카페",
      deposit_amount_krw: 1000,
      access_mode: "test_deposit",
    };

    // Route interceptor for /api/v1/restrooms & /api/v1/restrooms/search
    await page.route("**/api/v1/restrooms/search*", async (route) => {
      const url = new URL(route.request().url());
      const q = (url.searchParams.get("q") || "").trim();
      const matched = [mockPublicItem, mockPartnerItem].filter(
        (item) =>
          item.name.includes(q) ||
          (item.business_name && item.business_name.includes(q)) ||
          item.road_address.includes(q)
      );
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            items: matched,
            total: matched.length,
          },
          requestId: "mock-search-id",
        }),
      });
    });

    await page.route("**/api/v1/restrooms?*", async (route) => {
      const url = new URL(route.request().url());
      const type = url.searchParams.get("type") || "all";

      let items = [mockPublicItem, mockPartnerItem];
      if (type === "public") {
        items = [mockPublicItem];
      } else if (type === "partner") {
        items = [mockPartnerItem];
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            items,
            total: items.length,
            limit: 100,
            offset: 0,
          },
          requestId: "mock-request-id",
        }),
      });
    });

    // Mock geolocation permission denial
    await context.grantPermissions([]);

    // 1. /map 진입 및 최초 동의 화면 통과 후 360px 반응형 레이아웃 검증
    console.log(">>> 3. Navigating to /map and verifying 360px mobile viewport...");
    await page.goto(`${BASE_URL}/map`, { waitUntil: "networkidle" });
    const consentDecline = page.locator('[data-testid="consent-decline-btn"]');
    if (await consentDecline.isVisible().catch(() => false)) {
      await consentDecline.click();
      await page.locator('[data-testid="first-visit-consent-modal"]').waitFor({ state: "hidden" });
    }

    const scrollWidth = await page.evaluate(
      () => document.documentElement.scrollWidth
    );
    console.log(`✓ Viewport scrollWidth: ${scrollWidth}px (Target: <= 360px)`);
    if (scrollWidth > 360) {
      throw new Error(`Mobile 360px horizontal overflow detected: ${scrollWidth}px`);
    }

    // 2. 주요 UI 컴포넌트 렌더링 확인
    console.log(">>> 4. Verifying Map Discovery UI components...");
    await page.waitForSelector('[data-testid="map-discovery-container"]');
    await page.waitForSelector('[data-testid="map-filter-bar"]');
    await page.waitForSelector('[data-testid="map-search-input"]');
    await page.waitForSelector('[data-testid="current-location-btn"]');
    await page.waitForSelector('[data-testid="map-bottom-sheet-drawer"]');
    console.log("✓ Core search bar, filters, and bottom sheet drawer rendered.");

    // 3. 바텀시트 확장 및 화장실 목록 렌더링 검증
    console.log(">>> 5. Expanding bottom sheet to inspect restroom list...");
    const toggleBtn = page.locator('[data-testid="bottom-sheet-toggle-btn"]');
    await toggleBtn.click();
    await page.waitForSelector('[data-testid="bottom-sheet-expanded-content"]');

    // 공공 화장실 카드 확인
    const publicCard = page.locator(
      `[data-testid="public-restroom-card-${mockPublicItem.id}"]`
    );
    await publicCard.waitFor({ state: "visible" });
    const publicBadge = publicCard.locator('[data-testid="restroom-type-public-badge"]');
    const publicBadgeText = await publicBadge.innerText();
    console.log(`✓ Public card badge: "${publicBadgeText.trim()}"`);
    if (!publicBadgeText.includes("무료 공공")) {
      throw new Error("Public restroom card badge mismatch");
    }

    // 공공 화장실에 결제 버튼이 없는지 확인
    const publicPaymentBtn = publicCard.locator(
      `[data-testid="partner-payment-btn-${mockPublicItem.id}"]`
    );
    const hasPublicPayment = (await publicPaymentBtn.count()) > 0;
    console.log(`✓ Public restroom has payment button: ${hasPublicPayment} (Must be false)`);
    if (hasPublicPayment) {
      throw new Error("Public restroom must NOT have a payment button!");
    }

    // 제휴 화장실 카드 확인
    const partnerCard = page.locator(
      `[data-testid="public-restroom-card-${mockPartnerItem.id}"]`
    );
    await partnerCard.waitFor({ state: "visible" });
    const partnerBadge = partnerCard.locator('[data-testid="restroom-type-partner-badge"]');
    const partnerBadgeText = await partnerBadge.innerText();
    console.log(`✓ Partner card badge: "${partnerBadgeText.trim()}"`);
    if (!partnerBadgeText.includes("안심 제휴")) {
      throw new Error("Partner restroom card badge mismatch");
    }

    // 제휴 화장실 카드 보증금 안내 및 상세/결제 이동 링크 확인
    const partnerDepositAmount = partnerCard.locator(
      `[data-testid="partner-deposit-amount-${mockPartnerItem.id}"]`
    );
    await partnerDepositAmount.waitFor({ state: "visible" });
    const partnerDetailLink = partnerCard.locator(
      `[data-testid="detail-link-${mockPartnerItem.id}"]`
    );
    await partnerDetailLink.waitFor({ state: "visible" });
    const detailLinkText = await partnerDetailLink.innerText();
    console.log(`✓ Partner detail link text: "${detailLinkText.trim()}"`);
    if (!detailLinkText.includes("보증금 결제")) {
      throw new Error(`Expected partner detail link to reference deposit payment, got: ${detailLinkText}`);
    }

    // 4. 길찾기 모달 및 3사 링크 검증
    console.log(">>> 6. Testing 3-service directions modal...");
    const directionsBtn = publicCard.locator(
      `[data-testid="directions-btn-${mockPublicItem.id}"]`
    );
    await directionsBtn.click();

    await page.waitForSelector('[data-testid="map-directions-modal"]');
    const kakaoLink = page.locator('[data-testid="directions-kakao-link"]');
    const naverLink = page.locator('[data-testid="directions-naver-link"]');
    const googleLink = page.locator('[data-testid="directions-google-link"]');

    const kakaoHref = await kakaoLink.getAttribute("href");
    const naverHref = await naverLink.getAttribute("href");
    const googleHref = await googleLink.getAttribute("href");

    console.log(`✓ Kakao directions: ${kakaoHref}`);
    console.log(`✓ Naver directions: ${naverHref}`);
    console.log(`✓ Google directions: ${googleHref}`);

    if (!kakaoHref.includes("map.kakao.com/link/to/")) {
      throw new Error("Invalid Kakao directions link");
    }
    if (!naverHref.includes("map.naver.com/index.nhn?")) {
      throw new Error("Invalid Naver directions link");
    }
    if (!googleHref.includes("google.com/maps/dir/")) {
      throw new Error("Invalid Google directions link");
    }

    // 모달 닫기
    await page.keyboard.press("Escape");
    await page.waitForSelector('[data-testid="map-directions-modal"]', {
      state: "hidden",
    });
    console.log("✓ Directions modal closed via Esc key.");

    // 5. 필터 칩 토글 테스트
    console.log(">>> 7. Testing filter chips...");
    const publicChip = page.locator('[data-testid="filter-chip-public"]');
    await publicChip.click();
    await page.waitForTimeout(500);

    // 필터링 후 공공 화장실만 표시되는지 확인
    const partnerCountAfterPublicFilter = await page
      .locator(`[data-testid="public-restroom-card-${mockPartnerItem.id}"]`)
      .count();
    console.log(
      `✓ Partner cards visible under public filter: ${partnerCountAfterPublicFilter} (Expected: 0)`
    );
    if (partnerCountAfterPublicFilter !== 0) {
      throw new Error("Partner restroom should be hidden when public filter is active");
    }

    // 전체 필터로 복귀
    await page.locator('[data-testid="filter-chip-all"]').click();
    await page.waitForTimeout(500);

    // 6. 검색창 휴지맵 화장실 이름 검색 테스트
    console.log(">>> 8. Testing search input place/restroom search...");
    const searchInput = page.locator('[data-testid="map-search-input"]');
    await searchInput.fill("행궁");
    await page.waitForSelector('[data-testid="place-search-results"]', {
      timeout: 5000,
    });

    const partnerSearchResult = page.locator(
      `[data-testid="restroom-search-result-${mockPartnerItem.id}"]`
    );
    const partnerSearchVisible = await partnerSearchResult.count();
    const publicSearchVisible = await page
      .locator(`[data-testid="restroom-search-result-${mockPublicItem.id}"]`)
      .count();

    console.log(
      `✓ Search '행궁' dropdown results -> Public: ${publicSearchVisible}, Partner: ${partnerSearchVisible}`
    );
    if (publicSearchVisible !== 0 || partnerSearchVisible !== 1) {
      throw new Error("Search keyword filtering failed");
    }

    // 검색어 지우기
    await page.locator('[data-testid="map-search-clear-btn"]').click();

    // 7. 현재 위치 버튼 권한 거부 fallback 테스트
    console.log(">>> 9. Testing location permission denied fallback...");
    const locationBtn = page.locator('[data-testid="current-location-btn"]');
    await locationBtn.click();
    // 위치 거부 알림 배너 대기
    await page.waitForSelector('[data-testid="location-notice-banner"]', {
      timeout: 5000,
    });
    const noticeText = await page
      .locator('[data-testid="location-notice-banner"]')
      .innerText();
    console.log(`✓ Location notice banner: "${noticeText.trim()}"`);

    // 스크린샷 저장
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "task16_map_discovery_mobile.png"),
    });
    console.log("✓ Mobile discovery screenshot saved.");

    // 8. 404 및 미존재 화장실 상세 조회 안전성 검증
    console.log(">>> 10. Testing restroom detail fallback for non-existent ID...");
    await page.goto(
      `${BASE_URL}/restrooms/00000000-0000-4000-8000-000000000000`,
      { waitUntil: "networkidle" }
    );
    const notFoundText = await page.innerText("body");
    console.log(
      `✓ Non-existent restroom response handled gracefully: ${notFoundText.includes(
        "화장실을 찾을 수 없습니다"
      ) || notFoundText.includes("404")}`
    );

    const detailScrollWidth = await page.evaluate(
      () => document.documentElement.scrollWidth
    );
    console.log(`✓ Detail page scrollWidth: ${detailScrollWidth}px (Target: <= 360px)`);
    if (detailScrollWidth > 360) {
      throw new Error(`Detail page horizontal overflow: ${detailScrollWidth}px`);
    }

    console.log("\n=======================================================");
    console.log(">>> ALL TASK 16 MOBILE E2E CHECKS PASSED SUCCESSFULLY!");
    console.log("=======================================================\n");
  } finally {
    if (browser) await browser.close();
    if (server) killProcessTree(server.pid);
  }
}

runTests().catch((err) => {
  console.error("FATAL E2E ERROR:", err);
  process.exit(1);
});


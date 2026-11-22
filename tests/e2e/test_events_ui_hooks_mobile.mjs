/**
 * Mobile / Desktop Chrome E2E Verification: Optional Behavioral Analytics & Privacy Consent
 *
 * Verifies with real Google Chrome browser against local Next.js server (NEXT_PUBLIC_ANALYTICS_ENABLED=true):
 * 1. Mobile 360px / 390px and Desktop 1280px layout (no horizontal overflow)
 * 2. Default-OFF optional analytics: 0 /api/v1/sessions, 0 /api/v1/events, no hm_browser_id before consent
 * 3. Header menu -> /settings/privacy opt-in toggle & /privacy policy link
 * 4. Strict 6 optional events only (NO landing_view, NO A19 travel survey banner, NO premature payment_button_clicked):
 *    - map_loaded
 *    - restroom_marker_clicked
 *    - restroom_card_viewed
 *    - directions_clicked
 *    - restroom_detail_opened
 *    - payment_button_clicked
 * 5. Withdrawal via /settings/privacy clears hm_browser_id & hm_session_id and stops future event emission
 * 6. Privacy integrity: zero PII / PIN / coordinates in event payloads
 */

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const PORT = 3018;
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
  } catch { }
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
    } catch { }
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

    // Stub Kakao Maps SDK so MapCanvas reaches "ready" and marker clicks can be triggered deterministically
    await page.addInitScript(() => {
      const markers = [];
      let listeners = [];
      window.__hmMockMarkers = markers;
      window.__hmTriggerMarkerClick = (titleSubstring) => {
        const entry = markers.find(
          (m) =>
            m.map !== null &&
            (!titleSubstring || (m.params?.title || "").includes(titleSubstring))
        );
        if (!entry) return false;
        const found = listeners.filter((l) => l.target === entry && l.type === "click");
        found.forEach((l) => l.handler());
        return found.length > 0;
      };
      window.kakao = {
        maps: {
          load: (cb) => cb && cb(),
          LatLng: function MockLatLng(lat, lng) {
            this.lat = lat;
            this.lng = lng;
            this.getLat = () => this.lat;
            this.getLng = () => this.lng;
          },
          LatLngBounds: function MockBounds() {
            this.getSouthWest = () => ({ getLat: () => 37.27, getLng: () => 127.00 });
            this.getNorthEast = () => ({ getLat: () => 37.30, getLng: () => 127.03 });
          },
          Map: function MockMap(_el, opts) {
            this.center = opts?.center || new window.kakao.maps.LatLng(37.2845, 127.0155);
            this.level = opts?.level || 4;
            this.getCenter = () => this.center;
            this.setCenter = (c) => { this.center = c; };
            this.panTo = (c) => { this.center = c; };
            this.getLevel = () => this.level;
            this.setLevel = (l) => { this.level = l; };
            this.setMinLevel = () => { };
            this.setMaxLevel = () => { };
            this.getBounds = () => new window.kakao.maps.LatLngBounds();
            this.relayout = () => { };
          },
          Marker: function MockMarker(params) {
            this.params = params;
            this.map = params?.map ?? null;
            this.setMap = (m) => {
              this.map = m;
            };
            this.setPosition = () => { };
            this.setImage = () => { };
            markers.push(this);
          },
          MarkerImage: function MockMarkerImage() { },
          Size: function MockSize() { },
          Point: function MockPoint() { },
          CustomOverlay: function MockOverlay() {
            this.setMap = () => { };
          },
          event: {
            addListener: (target, type, handler) => {
              listeners.push({ target, type, handler });
            },
            removeListener: (target, type, handler) => {
              listeners = listeners.filter(
                (l) => !(l.target === target && l.type === type && l.handler === handler)
              );
            },
          },
        },
      };
    });

    // Mock fixtures
    const mockPartnerRestroom = {
      id: "b2222222-2222-4222-8222-222222222222",
      type: "partner",
      name: "행궁 안심제휴 카페 화장실",
      road_address: "수원시 팔달구 화서문로 42",
      address_detail: "1층",
      latitude: 37.2845,
      longitude: 127.0155,
      access_method: "pin",
      gender_type: "separate",
      wheelchair_accessible: true,
      baby_changing_available: true,
      sanitary_products_available: false,
      last_verified_at: "2026-11-10T10:00:00Z",
      business_id: "c3333333-3333-4333-8333-333333333333",
      business_name: "행궁 안심카페",
      deposit_amount_krw: 1000,
      access_mode: "test_deposit",
      active_policy: {
        id: "pol-partner-1",
        access_mode: "test_deposit",
        deposit_amount_krw: 1000,
        receipt_window_hours: 24,
      },
    };

    const mockPublicRestroom = {
      id: "a1111111-1111-4111-8111-111111111111",
      type: "public",
      name: "화홍문 공중화장실",
      road_address: "수원시 팔달구 정조로 880",
      address_detail: null,
      latitude: 37.2871,
      longitude: 127.0182,
      access_method: "open",
      gender_type: "separate",
      wheelchair_accessible: true,
      baby_changing_available: false,
      sanitary_products_available: false,
      last_verified_at: "2026-11-10T09:00:00Z",
      business_id: null,
      deposit_amount_krw: 0,
      access_mode: "free",
    };

    const capturedEvents = [];
    const capturedSessions = [];
    const capturedConsentRequests = [];

    await page.route("**/api/v1/privacy/consent", async (route) => {
      const postData = route.request().postDataJSON();
      capturedConsentRequests.push(postData);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            analyticsConsent: Boolean(postData.analyticsConsent),
            policyVersion: postData.policyVersion || "2026-11-22",
          },
        }),
      });
    });

    // Intercept network APIs for deterministic verification
    await page.route("**/api/v1/sessions", async (route) => {
      const postData = route.request().postDataJSON();
      capturedSessions.push(postData);
      console.log("  [API Intercept] POST /api/v1/sessions:", postData.landingPath);
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            sessionId: "d4444444-4444-4444-8444-444444444444",
            browserId: postData.browserId,
            sessionToken: "tok_test_e2e_12345",
            startedAt: new Date().toISOString(),
            isTest: true,
          },
        }),
      });
    });

    await page.route("**/api/v1/events", async (route) => {
      const payload = route.request().postDataJSON();
      capturedEvents.push(payload);
      console.log("  [API Intercept] POST /api/v1/events:", payload.eventName, JSON.stringify(payload.properties || {}));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            clientEventId: payload.clientEventId,
            receivedAt: new Date().toISOString(),
            deduplicated: false,
          },
        }),
      });
    });

    await page.route("**/api/v1/restrooms*", async (route) => {
      const url = route.request().url();
      if (url.includes("/api/v1/restrooms/b2222222-2222-4222-8222-222222222222")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            data: {
              ...mockPartnerRestroom,
              description: "행궁동 카페 제휴 화장실 상세 정보",
              entrance_instructions: "카운터 우측 계단 반층 위",
              hours: [{ weekday: 1, opens_at: "09:00", closes_at: "22:00", is_closed: false }],
              business: {
                name: "행궁 안심카페 본점",
                category: "카페/디저트",
                road_address: "수원시 팔달구 화서문로 42",
                phone: "031-123-4567",
              },
              photos: [],
            },
          }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            items: [mockPartnerRestroom, mockPublicRestroom],
            total: 2,
          },
        }),
      });
    });

    console.log(">>> 3. Verifying / SSR & first-visit consent flow (guest, undecided)...");
    const rootSsrHtml = await (await fetch(`${BASE_URL}/`)).text();
    if (!rootSsrHtml.includes('data-testid="first-visit-consent-modal"') || !rootSsrHtml.includes("휴지맵 시작하기")) {
      throw new Error("SSR HTML for / must render first-visit consent UI immediately to prevent flash");
    }
    const mapSsrHtml = await (await fetch(`${BASE_URL}/map`)).text();
    if (!mapSsrHtml.includes('data-testid="first-visit-consent-modal"') || !mapSsrHtml.includes("휴지맵 시작하기")) {
      throw new Error("SSR HTML for /map must render first-visit consent UI immediately to prevent flash");
    }
    console.log("✓ SSR HTML for / and /map renders full-screen consent UI immediately (zero flash)");

    await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
    const consentModal = page.locator('[data-testid="first-visit-consent-modal"]');
    await consentModal.waitFor({ state: "visible", timeout: 5000 });
    const modalText = await consentModal.innerText();
    if (
      !modalText.includes("휴지맵 시작하기") ||
      !modalText.includes("더 편리한 화장실 지도를 만들 수 있도록 서비스 이용 통계 수집에 참여해 주세요.") ||
      !modalText.includes("어떤 정보를 수집하나요?") ||
      !modalText.includes("어디에 활용하나요?") ||
      !modalText.includes("동의하지 않아도 이용할 수 있나요?") ||
      !modalText.includes("개인정보 처리 안내") ||
      !modalText.includes("동의하고 시작하기") ||
      !modalText.includes("동의 없이 시작하기")
    ) {
      throw new Error(`First-visit consent modal text mismatch: ${modalText}`);
    }

    // Verify all 4 accordions start collapsed and toggle cleanly without exposing internal tech terms
    const FORBIDDEN_UI_TERMS = [
      "map_loaded",
      "restroom_marker_clicked",
      "restroom_card_viewed",
      "restroom_detail_opened",
      "directions_clicked",
      "payment_button_clicked",
      "hm_browser_id",
      "hm_session_id",
      "is_authenticated",
      "visitor_sessions",
      "event_logs",
      "consent_records",
    ];
    for (const acc of [
      { testId: "consent-accordion-collected", expected: "지도 방문, 화장실 조회, 길찾기, 결제 버튼 클릭 등의 이용 기록을 수집합니다." },
      { testId: "consent-accordion-purpose", expected: "어떤 화장실에 관심이 많은지, 길찾기를 얼마나 이용하는지 확인해 화장실 정보와 지도 서비스를 개선합니다." },
      { testId: "consent-accordion-optional", expected: "네. 동의하지 않아도 지도와 길찾기 등 모든 기능을 이용할 수 있습니다." },
      { testId: "consent-accordion-privacy", expected: "상세 개인정보 처리 안내 보기" },
    ]) {
      const contentLoc = page.locator(`[data-testid="${acc.testId}-content"]`);
      if ((await contentLoc.count()) > 0) {
        throw new Error(`Accordion ${acc.testId} must be collapsed by default`);
      }
      await page.click(`[data-testid="${acc.testId}"]`);
      await contentLoc.waitFor({ state: "visible" });
      const contentText = await contentLoc.innerText();
      if (!contentText.includes(acc.expected)) {
        throw new Error(`Accordion ${acc.testId} content mismatch: ${contentText}`);
      }
      for (const term of FORBIDDEN_UI_TERMS) {
        if (contentText.includes(term)) {
          throw new Error(`Forbidden technical term '${term}' exposed in ${acc.testId}: ${contentText}`);
        }
      }
    }

    // Expand nested detailed privacy policy and verify no tech terms + collapse back
    await page.click('[data-testid="consent-privacy-details-toggle"]');
    const detailsPanel = page.locator('[data-testid="consent-privacy-details-panel"]');
    await detailsPanel.waitFor({ state: "visible" });
    const detailsText = await detailsPanel.innerText();
    if (!detailsText.includes("처리 목적 및 수집 항목") || !detailsText.includes("보유 및 파기 기준") || !detailsText.includes("외부 처리업체")) {
      throw new Error(`Detailed privacy panel missing required sections: ${detailsText}`);
    }
    for (const term of FORBIDDEN_UI_TERMS) {
      if (detailsText.includes(term)) {
        throw new Error(`Forbidden technical term '${term}' exposed in detailed privacy panel`);
      }
    }
    await page.click('[data-testid="consent-accordion-privacy"]');
    if ((await detailsPanel.count()) > 0) {
      throw new Error("Privacy accordion failed to collapse");
    }

    // Responsive check across 360px / 390px / 1280px + bottom buttons not clipped
    for (const vp of [
      { width: 360, height: 740 },
      { width: 390, height: 844 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(vp);
      const sw = await page.evaluate(() => document.documentElement.scrollWidth);
      if (sw > vp.width) {
        throw new Error(`Horizontal overflow at ${vp.width}px with consent screen: ${sw}px`);
      }
      const declineBox = await page.locator('[data-testid="consent-decline-btn"]').boundingBox();
      if (!declineBox || declineBox.y + declineBox.height > vp.height + 1) {
        throw new Error(`Bottom button clipped at ${vp.width}x${vp.height}: ${JSON.stringify(declineBox)}`);
      }
    }
    await page.setViewportSize({ width: 360, height: 740 });
    console.log("✓ / First-visit full-screen consent UI & 4 accordions verified across 360px/390px/1280px");

    // Step 2: Verify no events/browserId before consent
    if (capturedSessions.length > 0 || capturedEvents.length > 0) {
      throw new Error(
        `Analytics fired before consent! sessions=${capturedSessions.length}, events=${capturedEvents.length}`
      );
    }
    const browserIdBeforeConsent = await page.evaluate(() => localStorage.getItem("hm_browser_id"));
    if (browserIdBeforeConsent !== null) {
      throw new Error(`hm_browser_id must not exist before consent, got: ${browserIdBeforeConsent}`);
    }
    console.log("✓ Undecided default verified: 0 sessions, 0 events, hm_browser_id=null");

    // Step 3: Click '동의 없이 시작하기' on / -> enters home service, 0 events, NO repeat on / or /map
    await page.click('[data-testid="consent-decline-btn"]');
    await consentModal.waitFor({ state: "hidden", timeout: 5000 });
    await page.locator('[data-testid="home-map-cta"]').waitFor({ state: "visible" });
    await page.waitForTimeout(300);
    if (capturedSessions.length > 0 || capturedEvents.length > 0) {
      throw new Error("Analytics fired after declining consent!");
    }
    const browserIdAfterDecline = await page.evaluate(() => localStorage.getItem("hm_browser_id"));
    if (browserIdAfterDecline !== null) {
      throw new Error(`hm_browser_id must remain null after decline, got: ${browserIdAfterDecline}`);
    }

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    if ((await consentModal.count()) > 0) {
      throw new Error("Consent modal repeatedly popped up on / after user already declined!");
    }
    await page.goto(`${BASE_URL}/map`, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    if ((await consentModal.count()) > 0) {
      throw new Error("Consent modal repeatedly popped up on /map after user already declined!");
    }
    const surveyBannerCount = await page.locator('[data-testid="travel-survey-banner"]').count();
    if (surveyBannerCount > 0) {
      throw new Error("A19 travel-survey-banner must NOT be rendered");
    }
    console.log("✓ Decline on / persists across reload and /map without repeating or issuing hm_browser_id");

    // Step 3b: Fresh guest context directly visiting /map -> consent UI appears -> accept enters map & emits map_loaded
    const directMapCtx = await browser.newContext({
      viewport: { width: 360, height: 740 },
      isMobile: true,
      hasTouch: true,
    });
    const directMapPage = await directMapCtx.newPage();
    await directMapPage.addInitScript(() => {
      window.kakao = {
        maps: {
          load: (cb) => cb && cb(),
          LatLng: function (lat, lng) { this.lat = lat; this.lng = lng; this.getLat = () => lat; this.getLng = () => lng; },
          LatLngBounds: function () { this.getSouthWest = () => ({ getLat: () => 37.27, getLng: () => 127.00 }); this.getNorthEast = () => ({ getLat: () => 37.30, getLng: () => 127.03 }); },
          Map: function (_el, opts) { this.center = opts?.center; this.level = opts?.level || 4; this.getCenter = () => this.center; this.setCenter = () => {}; this.getLevel = () => this.level; this.setLevel = () => {}; this.getBounds = () => new window.kakao.maps.LatLngBounds(); this.relayout = () => {}; },
          Marker: function () { this.setMap = () => {}; },
          MarkerImage: function () {},
          Size: function () {},
          Point: function () {},
          event: { addListener: () => {}, removeListener: () => {} },
        },
      };
    });
    const directMapEvents = [];
    await directMapPage.route("**/api/v1/privacy/consent", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: { analytics: true, analyticsStatus: "accepted" } }) });
    });
    await directMapPage.route("**/api/v1/sessions", async (route) => {
      const postData = route.request().postDataJSON();
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ok: true, data: { sessionId: "e5555555-5555-4555-8555-555555555555", browserId: postData.browserId, sessionToken: "tok_direct_1", startedAt: new Date().toISOString(), isTest: true } }) });
    });
    await directMapPage.route("**/api/v1/events", async (route) => {
      const p = route.request().postDataJSON();
      directMapEvents.push(p.eventName);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: { clientEventId: p.clientEventId, receivedAt: new Date().toISOString(), deduplicated: false } }) });
    });
    await directMapPage.route("**/api/v1/restrooms*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: { items: [], total: 0 } }) });
    });
    await directMapPage.goto(`${BASE_URL}/map`, { waitUntil: "networkidle" });
    await directMapPage.locator('[data-testid="first-visit-consent-modal"]').waitFor({ state: "visible" });
    if (directMapEvents.length > 0) {
      throw new Error("Direct /map visit emitted events before consent!");
    }
    await directMapPage.click('[data-testid="consent-accept-btn"]');
    await directMapPage.locator('[data-testid="first-visit-consent-modal"]').waitFor({ state: "hidden" });
    await directMapPage.waitForTimeout(800);
    if (!directMapEvents.includes("map_loaded")) {
      throw new Error(`Direct /map accept did not emit map_loaded: ${JSON.stringify(directMapEvents)}`);
    }
    await directMapCtx.close();
    console.log("✓ Direct /map first visit shows consent UI -> accept enters map & emits map_loaded");

    // Step 4: Open header menu -> '이용 통계 설정' modal -> enable analytics -> also verify legacy /privacy redirect
    console.log(">>> 4. Opening '이용 통계 설정' modal via header menu & checking /privacy redirect...");
    await page.click('[data-testid="header-menu-toggle"]');
    await page.locator('[data-testid="nav-link-privacy-settings"]').waitFor({ state: "visible" });
    if ((await page.locator('[data-testid="nav-link-privacy-policy"]').count()) > 0) {
      throw new Error("Menu must not contain standalone /privacy link");
    }
    await page.click('[data-testid="nav-link-privacy-settings"]');
    await page.waitForSelector('[data-testid="analytics-settings-modal"]');

    const initialChecked = await page
      .locator('[data-testid="analytics-consent-toggle"]')
      .getAttribute("aria-checked");
    if (initialChecked !== "false") {
      throw new Error(`Expected initial analytics toggle aria-checked="false", got ${initialChecked}`);
    }

    // Opt in to analytics from modal on /map -> closes modal & emits map_loaded on already-ready map!
    await page.click('[data-testid="analytics-consent-toggle"]');
    await page.waitForSelector('[data-testid="analytics-consent-feedback"]');
    const enabledChecked = await page
      .locator('[data-testid="analytics-consent-toggle"]')
      .getAttribute("aria-checked");
    if (enabledChecked !== "true") {
      throw new Error(`Expected toggled analytics aria-checked="true", got ${enabledChecked}`);
    }
    await page.click('[data-testid="analytics-settings-close-btn"]');
    await page.locator('[data-testid="analytics-settings-modal"]').waitFor({ state: "hidden" });
    await page.waitForTimeout(1000);
    console.log("✓ '이용 통계 설정' modal opt-in verified");

    // Step 5: Verify 6 optional events emitted as guest
    console.log(">>> 5. Verifying 6 optional events emitted cleanly after opt-in...");
    if (capturedSessions.length === 0) {
      throw new Error("Visitor session was not initialized after analytics opt-in");
    }
    const landingEvent = capturedEvents.find((e) => e.eventName === "landing_view");
    if (landingEvent) {
      throw new Error("Removed event landing_view must not be emitted");
    }

    const mapLoadedEvents = capturedEvents.filter((e) => e.eventName === "map_loaded");
    if (mapLoadedEvents.length !== 1) {
      throw new Error(`Expected exactly 1 map_loaded event right after consent on ready map, got ${mapLoadedEvents.length}`);
    }
    console.log("✓ map_loaded emitted once:", mapLoadedEvents[0].properties);

    // Click marker -> triggers restroom_marker_clicked + restroom_card_viewed (selected card)
    const clickedMarker = await page.evaluate(() => window.__hmTriggerMarkerClick("행궁"));
    if (!clickedMarker) {
      throw new Error("Failed to trigger Kakao mock marker click");
    }
    await page.waitForTimeout(600);

    const markerEvent = capturedEvents.find(
      (e) => e.eventName === "restroom_marker_clicked" && e.properties.restroom_id === mockPartnerRestroom.id
    );
    if (!markerEvent) {
      throw new Error("restroom_marker_clicked was not emitted on marker selection");
    }
    const cardViewedEvent = capturedEvents.find(
      (e) => e.eventName === "restroom_card_viewed" && e.properties.restroom_id === mockPartnerRestroom.id
    );
    if (!cardViewedEvent) {
      throw new Error("restroom_card_viewed was not emitted when selected card appeared");
    }
    console.log("✓ restroom_marker_clicked & restroom_card_viewed emitted");

    // Check card does NOT emit payment_button_clicked prematurely
    const prematurePayment = capturedEvents.filter((e) => e.eventName === "payment_button_clicked");
    if (prematurePayment.length > 0) {
      throw new Error("payment_button_clicked must not be emitted on map card alone");
    }

    // Open Directions modal and click Kakao link -> directions_clicked
    const directionsBtn = page.locator(`[data-testid="directions-btn-${mockPartnerRestroom.id}"]`);
    await directionsBtn.waitFor({ state: "visible" });
    await directionsBtn.click();
    const directionsModal = page.locator('[data-testid="map-directions-modal"]');
    await directionsModal.waitFor({ state: "visible" });
    await page.locator('[data-testid="directions-kakao-link"]').click();
    await page.waitForTimeout(500);

    const directionsEvent = capturedEvents.find(
      (e) => e.eventName === "directions_clicked" && e.properties.service === "kakao"
    );
    if (!directionsEvent) {
      throw new Error("directions_clicked event was not emitted");
    }
    console.log("✓ directions_clicked emitted:", directionsEvent.properties);

    // Close modal & navigate to /restrooms/[id] -> restroom_detail_opened -> payment_button_clicked
    await directionsModal.locator('button:has-text("✕")').click();
    await page.waitForTimeout(200);
    await page.locator(`[data-testid="detail-link-${mockPartnerRestroom.id}"]`).click();
    await page.waitForSelector('[data-testid="public-restroom-detail-view"]');
    await page.waitForTimeout(800);

    const detailOpenedEvents = capturedEvents.filter(
      (e) => e.eventName === "restroom_detail_opened" && e.properties.restroom_id === mockPartnerRestroom.id
    );
    if (detailOpenedEvents.length !== 1) {
      throw new Error(`Expected 1 restroom_detail_opened, got ${detailOpenedEvents.length}`);
    }
    console.log("✓ restroom_detail_opened emitted once");

    // Click deposit payment button on partner restroom detail
    await page.locator('[data-testid="detail-partner-payment-btn"]').click();
    await page.waitForTimeout(500);
    const paymentClickedEvent = capturedEvents.find(
      (e) => e.eventName === "payment_button_clicked" && e.properties.restroom_id === mockPartnerRestroom.id
    );
    if (!paymentClickedEvent) {
      throw new Error("payment_button_clicked event was not emitted on detail payment click");
    }
    console.log("✓ payment_button_clicked emitted:", paymentClickedEvent.properties);

    // Verify only allowed 6 events were emitted
    const ALLOWED_EVENTS = new Set([
      "map_loaded",
      "restroom_marker_clicked",
      "restroom_card_viewed",
      "restroom_detail_opened",
      "directions_clicked",
      "payment_button_clicked",
    ]);
    for (const evt of capturedEvents) {
      if (!ALLOWED_EVENTS.has(evt.eventName)) {
        throw new Error(`Unexpected non-allowlisted event emitted: ${evt.eventName}`);
      }
    }

    // Step 6: Verify auth transition rotates visitor session while preserving consent
    console.log(">>> 6. Verifying login session isolation (no pre-login session reuse)...");
    const sessionBeforeAuth = await page.evaluate(() => sessionStorage.getItem("hm_session_id"));
    const sessionsCountBeforeAuth = capturedSessions.length;
    await context.addCookies([{ name: "e2e_mock_customer", value: "1", url: BASE_URL }]);
    await page.goto(`${BASE_URL}/map`, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    if (capturedSessions.length <= sessionsCountBeforeAuth) {
      throw new Error(`Expected new visitor_sessions after login boundary transition (prev session=${sessionBeforeAuth})`);
    }
    console.log("✓ Auth transition created isolated visitor session while preserving accepted consent");

    // Step 7: Visit legacy /privacy & /settings/privacy bookmarks -> redirect to /map -> open details/settings modal -> withdraw
    console.log(">>> 7. Verifying /privacy & /settings/privacy redirects -> modal -> withdrawal & 390px/1280px...");
    await page.goto(`${BASE_URL}/privacy`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="analytics-settings-modal"]');
    await page.waitForSelector('[data-testid="consent-accordion-privacy-content"]');
    await page.waitForSelector('[data-testid="consent-privacy-details-panel"]');
    await page.goto(`${BASE_URL}/settings/privacy`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="analytics-settings-modal"]');
    for (const vp of [
      { width: 390, height: 844 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(vp);
      const sw = await page.evaluate(() => document.documentElement.scrollWidth);
      if (sw > vp.width) {
        throw new Error(`Horizontal overflow at ${vp.width}px on settings modal: ${sw}px`);
      }
    }
    await page.setViewportSize({ width: 360, height: 740 });

    // Withdraw consent
    await page.click('[data-testid="analytics-consent-toggle"]');
    await page.waitForTimeout(400);
    const withdrawnChecked = await page
      .locator('[data-testid="analytics-consent-toggle"]')
      .getAttribute("aria-checked");
    if (withdrawnChecked !== "false") {
      throw new Error(`Expected withdrawn aria-checked="false", got ${withdrawnChecked}`);
    }
    const browserIdAfterWithdraw = await page.evaluate(() => ({
      browserId: localStorage.getItem("hm_browser_id"),
      sessionId: sessionStorage.getItem("hm_session_id"),
    }));
    if (browserIdAfterWithdraw.browserId !== null || browserIdAfterWithdraw.sessionId !== null) {
      throw new Error(
        `Storage identifiers must be cleared after withdrawal: ${JSON.stringify(browserIdAfterWithdraw)}`
      );
    }

    const eventCountBeforeRevisit = capturedEvents.length;
    const sessionCountBeforeRevisit = capturedSessions.length;
    await page.goto(`${BASE_URL}/map`, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    if (
      capturedEvents.length !== eventCountBeforeRevisit ||
      capturedSessions.length !== sessionCountBeforeRevisit
    ) {
      throw new Error("Events or sessions were still sent after analytics withdrawal!");
    }
    console.log("✓ Withdrawal cleared identifiers and blocked further tracking");

    // Take screenshot
    const screenshotPath = path.join(SCREENSHOT_DIR, "task18_events_ui_hooks_mobile.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`✓ Screenshot saved: ${screenshotPath}`);

    // Step 9: Verify Privacy & Forbidden Property Keys
    console.log(">>> 7. Verifying event properties privacy (no PII, credentials, or GPS trails)...");
    const FORBIDDEN_WORDS = ["pin", "password", "token", "secret", "lat", "lng", "phone", "email"];
    for (const evt of capturedEvents) {
      const keys = Object.keys(evt.properties || {});
      for (const k of keys) {
        if (FORBIDDEN_WORDS.includes(k.toLowerCase())) {
          throw new Error(`Privacy violation: Forbidden key '${k}' found in event '${evt.eventName}' properties`);
        }
      }
    }
    console.log(`✓ Checked ${capturedEvents.length} emitted events: 6-event allowlist & zero PII violations verified`);

    console.log("\n=======================================================");
    console.log(" 🎉 ANALYTICS & PRIVACY CHROME E2E VERIFICATION PASSED (100%)");
    console.log("=======================================================\n");
  } finally {
    if (browser) {
      await browser.close().catch(() => { });
    }
    if (server) {
      killProcessTree(server.pid);
    }
  }
}

runTests().catch((err) => {
  console.error("\n❌ E2E Verification Failed:", err);
  process.exit(1);
});

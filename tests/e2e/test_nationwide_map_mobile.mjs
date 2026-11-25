/**
 * TASK 7: Mobile Chrome (360x740) Nationwide Map, Candidate Index & Re-search E2E
 */

import { spawn, execSync } from "node:child_process";
import { chromium } from "playwright";

const PORT = 3026;
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
  const server = spawn("cmd.exe", ["/c", `npx next start -p ${PORT} -H 127.0.0.1`], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    env: { ...process.env, PORT: String(PORT), ALLOW_E2E_MOCK: "1" },
  });

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`${BASE_URL}/map`);
      if (res.status >= 200 && res.status < 400) {
        return server;
      }
    } catch {}
  }
  killProcessTree(server.pid);
  throw new Error("Failed to start Next.js server within 30s");
}

function assert(cond, msg) {
  if (!cond) {
    throw new Error(`E2E Assertion Failed: ${msg}`);
  }
}

async function run() {
  let server = null;
  let browser = null;

  try {
    console.log(">>> Starting Next.js server for mobile E2E...");
    server = await startNextServer();

    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    });

    const context = await browser.newContext({
      viewport: { width: 360, height: 740 },
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    });

    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];

    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    let candidateCalls = 0;
    const basicUsageCalls = [];

    await page.route("**/api/v1/usage-counts", async (route) => {
      try {
        const body = route.request().postDataJSON();
        if (body?.feature) basicUsageCalls.push(body.feature);
      } catch {}
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: { statDate: "2026-11-25" } }),
      });
    });

    // Kakao SDK를 결정적 테스트용 Mock으로 주입해 360px 모바일 환경에서 실시간 장소/주소 보완 및 재검색 동작 검증
    await page.addInitScript(() => {
      class MockLatLng {
        constructor(lat, lng) {
          this.lat = lat;
          this.lng = lng;
        }
        getLat() {
          return this.lat;
        }
        getLng() {
          return this.lng;
        }
      }
      class MockLatLngBounds {
        constructor(sw, ne) {
          this.sw = sw;
          this.ne = ne;
        }
        getSouthWest() {
          return this.sw;
        }
        getNorthEast() {
          return this.ne;
        }
      }
      class MockMap {
        constructor(_el, opts) {
          this._center = opts?.center ?? new MockLatLng(37.2635727, 127.0286009);
          this._level = opts?.level ?? 4;
          this._listeners = {};
        }
        setCenter(c) {
          this._center = c;
        }
        getCenter() {
          return this._center;
        }
        setLevel(l) {
          this._level = l;
        }
        getLevel() {
          return this._level;
        }
        getBounds() {
          const lat = this._center.getLat();
          const lng = this._center.getLng();
          return new MockLatLngBounds(
            new MockLatLng(lat - 0.015, lng - 0.02),
            new MockLatLng(lat + 0.015, lng + 0.02)
          );
        }
        relayout() {}
      }
      class MockMarker {
        setMap() {}
        setZIndex() {}
        setImage() {}
      }
      window.kakao = {
        maps: {
          load: (cb) => cb(),
          LatLng: MockLatLng,
          LatLngBounds: MockLatLngBounds,
          Map: MockMap,
          Marker: MockMarker,
          MarkerImage: function () {},
          Size: function () {},
          Point: function () {},
          event: {
            addListener: (target, type, fn) => {
              target._listeners = target._listeners || {};
              target._listeners[type] = target._listeners[type] || [];
              target._listeners[type].push(fn);
            },
            removeListener: () => {},
          },
          services: {
            Status: { OK: "OK", ZERO_RESULT: "ZERO_RESULT", ERROR: "ERROR" },
            Places: class {
              keywordSearch(q, cb) {
                if (String(q).includes("효원공원")) {
                  cb(
                    [
                      {
                        place_name: "효원공원 공중화장실",
                        road_address_name: "경기도 수원시 팔달구 동수원로 397",
                        address_name: "경기도 수원시 팔달구 인계동 1117",
                        y: "37.2615",
                        x: "127.0335",
                      },
                    ],
                    "OK"
                  );
                } else {
                  cb([], "ZERO_RESULT");
                }
              }
            },
            Geocoder: class {
              addressSearch(_addr, cb) {
                cb([], "ZERO_RESULT");
              }
            },
          },
        },
      };
    });

    await page.route("**/dapi.kakao.com/**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
    });

    await page.route("**/api/v1/restrooms?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            items: [
              {
                id: "off-suwon-1",
                type: "public",
                name: "수원시청 별관 화장실",
                road_address: "경기도 수원시 팔달구 효원로 241",
                address_detail: "1층",
                latitude: 37.26357,
                longitude: 127.0286,
                access_method: "open",
                gender_type: "separate",
                wheelchair_accessible: true,
                baby_changing_available: true,
                sanitary_products_available: null,
                last_verified_at: "2026-06-30",
                business_id: null,
              },
              {
                id: "off-partner-1",
                type: "partner",
                name: "진미 통닭",
                road_address: "경기도 수원시 팔달구 정조로 800번길 21",
                address_detail: "1층",
                latitude: 37.279,
                longitude: 127.018,
                access_method: "pin",
                gender_type: "separate",
                wheelchair_accessible: false,
                baby_changing_available: false,
                sanitary_products_available: null,
                last_verified_at: "2026-11-10",
                business_id: "biz-1",
                access_mode: "test_deposit",
                deposit_amount_krw: 1000,
              },
            ],
            total: 2,
          },
        }),
      });
    });

    await page.route("**/api/v1/restrooms/candidates?*", async (route) => {
      candidateCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            items: [
              {
                id: "cand-hyowon-1",
                source_provider: "전국표준데이터",
                source_dataset_id: "15012892",
                source_record_id: "HYO-1",
                name: "효원공원 공중화장실",
                normalized_name: "효원공원 공중화장실",
                road_address: "경기도 수원시 팔달구 동수원로 397",
                jibun_address: "경기도 수원시 팔달구 인계동 1117",
                normalized_address: "경기도 수원시 팔달구 동수원로 397",
                sido_code: "41",
                sigungu_code: "41115",
                eupmyeondong_code: null,
                sido_name: "경기도",
                sigungu_name: "수원시 팔달구",
                eupmyeondong_name: "인계동",
                facility_type: "공중화장실",
                open_hours: "06:00~22:00",
                closed_days: "연중무휴",
                gender_type: "separate",
                wheelchair_accessible: true,
                baby_changing_available: false,
                coordinate_status: "unlocated",
                facility_hash: "hash_hyowon_mobile_001",
                source_base_date: "2026-06-30",
                attribution_text: "경기도 수원시",
              },
            ],
            regionCodes: ["41115"],
            regionNames: ["경기도 수원시 팔달구"],
            tooWide: false,
            totalReturned: 1,
          },
        }),
      });
    });

    await page.goto(`${BASE_URL}/map`, { waitUntil: "domcontentloaded" });

    const consentDecline = page.locator('[data-testid="consent-decline-btn"]');
    if (await consentDecline.isVisible().catch(() => false)) {
      await consentDecline.click();
      await page.locator('[data-testid="first-visit-consent-modal"]').waitFor({ state: "hidden" });
    }

    // 1. 360px 모바일 뷰포트 가로 스크롤 없음 + 공식 DB 2곳 즉시 표시 + 후보 선조회 0회
    const overflowWidth = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    assert(overflowWidth <= 0, `Horizontal overflow detected on 360px: ${overflowWidth}`);

    await page.getByText("이 지역 화장실 2곳").waitFor({ timeout: 5000 });
    assert(candidateCalls === 0, `Expected 0 candidate calls on initial load, got ${candidateCalls}`);

    // 2. 지도 확대(-) / 축소(+) 조작 시 '이 지역에서 재검색' 버튼 표시 확인
    await page.getByTestId("map-zoom-in-btn").click();
    await page.getByTestId("search-this-area-btn").waitFor({ timeout: 3000 });

    // 3. '이 지역에서 재검색' 클릭 -> 후보 조회 + 실시간 참고 위치 통합(총 3곳)
    await page.getByTestId("search-this-area-btn").click();
    await page.getByText("이 지역 화장실 3곳").waitFor({ timeout: 5000 });
    assert(candidateCalls === 1, `Expected 1 candidate call after search-here, got ${candidateCalls}`);

    // 4. 바텀시트 확장해 공식 위치 / 안심 제휴 / 주소 기반 참고 위치 구분 확인
    await page.getByTestId("bottom-sheet-toggle-btn").click();
    await page.getByText("효원공원 공중화장실").waitFor({ timeout: 3000 });
    await page.getByTestId("restroom-type-candidate-badge").waitFor({ timeout: 3000 });
    await page.getByTestId("detail-link-off-partner-1").waitFor({ timeout: 3000 });

    // 5. 참고 위치 길찾기 모달 안내 문구 검증
    await page.getByTestId("directions-btn-candidate:cand-hyowon-1").click();
    await page.getByTestId("directions-candidate-coord-notice").waitFor({ timeout: 3000 });

    // 6. 카카오 좌표가 localStorage / sessionStorage에 전혀 저장되지 않음 검증
    const storageDump = await page.evaluate(() => ({
      local: JSON.stringify(window.localStorage),
      session: JSON.stringify(window.sessionStorage),
    }));
    assert(!storageDump.local.includes("37.2615"), "Candidate lat leaked into localStorage");
    assert(!storageDump.session.includes("37.2615"), "Candidate lat leaked into sessionStorage");
    assert(basicUsageCalls.includes("map_opened"), "Expected consent-free map_opened basic usage count");
    assert(
      consoleErrors.length === 0 && pageErrors.length === 0,
      `Browser errors found: console=${JSON.stringify(consoleErrors)}, page=${JSON.stringify(pageErrors)}`
    );

    console.log("✓ TASK 7 Mobile 360px Nationwide Map E2E PASSED!");
  } finally {
    if (browser) await browser.close();
    if (server) killProcessTree(server.pid);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

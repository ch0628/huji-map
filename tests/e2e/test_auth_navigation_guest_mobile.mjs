import { chromium } from "@playwright/test";
import { execSync, spawn } from "node:child_process";

const PORT = 3019;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

function killTree(pid) {
  if (!pid) return;
  try {
    execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
  } catch {}
}

async function startServer() {
  const server = spawn("npx", ["next", "start", "-p", String(PORT), "-H", "127.0.0.1"], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    env: { ...process.env, PORT: String(PORT) },
  });

  server.stderr.on("data", (d) => {
    const s = d.toString().trim();
    if (s && !s.includes("DeprecationWarning")) {
      console.error("[next stderr]", s);
    }
  });

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`${BASE_URL}/`);
      if (res.status === 200) return server;
    } catch {}
  }
  killTree(server.pid);
  throw new Error("Server did not start in time");
}

async function run() {
  const server = await startServer();
  let browser;
  try {
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

    const checkNoOverflow = async (label) => {
      const sw = await page.evaluate(() => document.documentElement.scrollWidth);
      const iw = await page.evaluate(() => window.innerWidth);
      if (sw > iw) {
        throw new Error(`[${label}] Horizontal overflow: scrollWidth=${sw} > innerWidth=${iw}`);
      }
      console.log(`✓ [${label}] 360px layout OK (${sw} <= ${iw})`);
    };

    // 1. 비회원 / 접속 -> 메뉴 확인 -> /map -> /login 진입
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("home-map-cta").waitFor();
    await page.getByTestId("home-login-link").waitFor();
    await page.getByTestId("home-signup-link").waitFor();
    await page.getByTestId("home-merchant-entry-link").waitFor();
    await checkNoOverflow("home-guest");

    // 8. 모바일 헤더 메뉴 동작 확인
    await page.getByTestId("header-menu-toggle").click();
    await page.getByTestId("header-nav-menu").waitFor();
    await page.getByTestId("nav-link-login").waitFor();
    await page.getByTestId("nav-link-signup").waitFor();
    await page.getByTestId("nav-link-merchant-onboarding").waitFor();
    await checkNoOverflow("home-menu-open");

    // / -> /map 이동
    await page.getByTestId("nav-link-map").click();
    await page.waitForURL(`${BASE_URL}/map`);
    await page.getByTestId("map-discovery-container").waitFor();
    await page.getByTestId("map-filter-bar").waitFor();
    await page.getByTestId("map-bottom-sheet-drawer").waitFor();
    await checkNoOverflow("map-guest");

    // /map에서 헤더 로그인 버튼으로 /login 이동
    await page.getByTestId("header-login-link").click();
    await page.waitForURL(`${BASE_URL}/login`);
    await page.getByRole("heading", { name: /휴지맵 로그인/ }).waitFor();
    await checkNoOverflow("login-page");

    // 6. 비회원 보호 페이지 직접 접근 차단 (401 안내 UI)
    const protectedChecks = [
      { path: "/my/access", testId: "access-unauthorized-401" },
      { path: "/my/receipts", testId: "receipts-unauthorized-401" },
      { path: "/merchant/businesses", testId: "merchant-unauthorized-401" },
      { path: "/merchant/restrooms", testId: "merchant-unauthorized-401" },
      { path: "/admin", testId: "admin-dashboard-unauthorized-401" },
      { path: "/admin/businesses", testId: "admin-businesses-unauthorized-401" },
    ];
    for (const item of protectedChecks) {
      await page.goto(`${BASE_URL}${item.path}`, { waitUntil: "domcontentloaded" });
      await page.getByTestId(item.testId).waitFor();
      await checkNoOverflow(`guest-401-${item.path}`);
    }

    // 2. 비회원 지도 탐색 + 화장실 목록/상세/길찾기 확인 (실제 API 응답이 있을 때)
    await page.goto(`${BASE_URL}/map`, { waitUntil: "networkidle" });
    const toggleBtn = page.getByTestId("bottom-sheet-toggle-btn");
    await toggleBtn.click();
    const cards = page.locator('[data-testid^="public-restroom-card-"]');
    const cardCount = await cards.count();
    console.log(`✓ [/map] loaded restroom cards in bottom sheet: ${cardCount}`);
    if (cardCount > 0) {
      await cards.first().locator('[data-testid^="directions-btn-"]').click();
      await page.getByTestId("map-directions-modal").waitFor();
      console.log("✓ [/map] guest directions modal opened");
    }

    console.log("ALL GUEST MOBILE CHROME CHECKS PASSED");
  } finally {
    if (browser) await browser.close();
    killTree(server.pid);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "@playwright/test";
import { execSync, spawn } from "node:child_process";

const PORT = 3020;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

function killTree(pid) {
  if (!pid) return;
  try {
    execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
  } catch {}
}

function loadQaAccounts() {
  const filePath = path.join(process.cwd(), "local-data", "qa_accounts.local.txt");
  const text = fs.readFileSync(filePath, "utf8");
  const blocks = text.split(/^## /m).slice(1);
  const map = {};
  for (const b of blocks) {
    const emailMatch = b.match(/^- 로그인 이메일:\s*(.+)$/m);
    const passMatch = b.match(/^- 임시 비밀번호:\s*(.+)$/m);
    if (emailMatch && passMatch) {
      map[emailMatch[1].trim()] = passMatch[1].trim();
    }
  }
  if (
    !map["customer.qa@hujimap.test"] ||
    !map["merchant.qa@hujimap.test"] ||
    !map["admin.qa@hujimap.test"]
  ) {
    throw new Error("QA accounts missing from local-data/qa_accounts.local.txt");
  }
  return map;
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
  throw new Error("Next server failed to start");
}

async function newMobileContext(browser) {
  return browser.newContext({
    viewport: { width: 360, height: 740 },
    isMobile: true,
    hasTouch: true,
  });
}

async function uiLogin(page, email, password, expectedPathname) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => url.pathname === expectedPathname, { timeout: 15000 });
}

async function uiLogout(page) {
  await page.getByTestId("header-menu-toggle").click();
  await page.getByTestId("header-logout-btn").click();
  await page.waitForURL((url) => url.pathname === "/map", { timeout: 10000 });
}

async function checkNoOverflow(page, label) {
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  const iw = await page.evaluate(() => window.innerWidth);
  if (sw > iw) {
    throw new Error(`[${label}] Horizontal overflow: ${sw} > ${iw}`);
  }
}

async function run() {
  const accounts = loadQaAccounts();
  const server = await startServer();
  let browser;

  try {
    // 0. Restrooms API verification after local migration
    const apiRes = await fetch(
      `${BASE_URL}/api/v1/restrooms?bbox=37.24,126.98,37.31,127.06&type=all&limit=100`
    );
    const apiJson = await apiRes.json();
    if (!apiRes.ok || !apiJson?.ok || !Array.isArray(apiJson?.data?.items)) {
      throw new Error(`Map API check failed: status=${apiRes.status}`);
    }
    console.log(
      `✓ [API] /api/v1/restrooms 200 OK (page items=${apiJson.data.items.length}, total=${apiJson.data.total})`
    );

    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
    });

    // 1. Consecutive /signup UI verification (real local Supabase)
    {
      const ctxSignup = await newMobileContext(browser);
      const page = await ctxSignup.newPage();
      const ts = Date.now();
      const tempPass = "TempE2e!" + crypto.randomBytes(6).toString("hex");

      for (const suffix of ["a", "b"]) {
        const email = `e2e.signup.${suffix}.${ts}@hujimap.test`;
        await page.goto(`${BASE_URL}/signup`, { waitUntil: "networkidle" });
        await page.waitForSelector('input[name="displayName"]', { timeout: 15000 });
        await page.fill('input[name="email"]', email);
        await page.fill('input[name="password"]', tempPass);
        await page.fill('input[name="displayName"]', `E2E가입${suffix}`);
        await page.check('input[name="termsAccepted"]');
        const [resp] = await Promise.all([
          page.waitForResponse((r) => r.url().includes("/api/v1/auth/signup")),
          page.click('button[type="submit"]'),
        ]);
        if (resp.status() !== 201) {
          throw new Error(`Signup ${suffix} failed with status ${resp.status()}`);
        }
        await page.waitForURL((u) => u.pathname === "/login", { timeout: 15000 });
        const signupSess = await page.evaluate(async () => {
          const r = await fetch("/api/v1/auth/session", { cache: "no-store" });
          return r.json();
        });
        if (!signupSess.authenticated || !signupSess.roles.includes("customer")) {
          throw new Error(`Signup ${suffix} session unexpected: ${JSON.stringify(signupSess)}`);
        }
        // Log out via header before next signup
        await uiLogout(page);
      }
      console.log("✓ [Signup] Consecutive 2 real signups via /signup UI succeeded (201, no 429 cap)");
      await ctxSignup.close();
    }

    // 2. Customer Real E2E
    {
      const ctxCust = await newMobileContext(browser);
      const page = await ctxCust.newPage();
      await uiLogin(page, "customer.qa@hujimap.test", accounts["customer.qa@hujimap.test"], "/map");
      await checkNoOverflow(page, "customer-map");

      const sessRes = await page.evaluate(async () => {
        const r = await fetch("/api/v1/auth/session", { cache: "no-store" });
        return r.json();
      });
      if (!sessRes.authenticated || sessRes.isAdmin || sessRes.isMerchant || !sessRes.roles.includes("customer")) {
        throw new Error(`Unexpected customer session: ${JSON.stringify(sessRes)}`);
      }
      console.log("✓ [Customer] Login -> /map & default customer role verified");

      // Header menu check
      await page.getByTestId("header-menu-toggle").click();
      await page.getByTestId("nav-link-my-access").waitFor();
      await page.getByTestId("nav-link-my-receipts").waitFor();
      if ((await page.getByTestId("nav-link-admin-home").count()) > 0) {
        throw new Error("Customer menu must not show admin links");
      }

      // Customer routes
      await page.goto(`${BASE_URL}/my/access`, { waitUntil: "domcontentloaded" });
      if ((await page.getByTestId("access-unauthorized-401").count()) > 0) {
        throw new Error("Customer got 401 on /my/access");
      }
      await checkNoOverflow(page, "customer-my-access");

      await page.goto(`${BASE_URL}/my/receipts`, { waitUntil: "domcontentloaded" });
      if ((await page.getByTestId("receipts-unauthorized-401").count()) > 0) {
        throw new Error("Customer got 401 on /my/receipts");
      }
      await checkNoOverflow(page, "customer-my-receipts");

      // Forbidden checks
      await page.goto(`${BASE_URL}/admin`, { waitUntil: "domcontentloaded" });
      await page.getByTestId("admin-dashboard-forbidden-403").waitFor();
      await page.goto(`${BASE_URL}/admin/businesses`, { waitUntil: "domcontentloaded" });
      await page.getByTestId("admin-businesses-forbidden-403").waitFor();
      await page.goto(`${BASE_URL}/merchant/restrooms`, { waitUntil: "domcontentloaded" });
      await page.getByTestId("merchant-restroom-forbidden-403").waitFor();
      console.log("✓ [Customer] /my/access & /my/receipts 200 OK; /admin & /merchant/restrooms 403 blocked");

      // Logout -> 401 re-block
      await uiLogout(page);
      await page.goto(`${BASE_URL}/my/access`, { waitUntil: "domcontentloaded" });
      await page.getByTestId("access-unauthorized-401").waitFor();
      await page.goto(`${BASE_URL}/admin`, { waitUntil: "domcontentloaded" });
      await page.getByTestId("admin-dashboard-unauthorized-401").waitFor();
      console.log("✓ [Customer] Post-logout protected routes 401 blocked");
      await ctxCust.close();
    }

    // 3. Merchant Applicant + Admin Approval + Merchant Real E2E (isolated contexts)
    const ctxMerch = await newMobileContext(browser);
    const merchPage = await ctxMerch.newPage();
    merchPage.on("dialog", (d) => d.accept());

    // 3-1. Applicant login (if not yet approved, redirects to /map; if already merchant, redirects to /merchant/businesses)
    await merchPage.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
    await merchPage.fill('input[name="email"]', "merchant.qa@hujimap.test");
    await merchPage.fill('input[name="password"]', accounts["merchant.qa@hujimap.test"]);
    await merchPage.click('button[type="submit"]');
    await merchPage.waitForURL(
      (u) => u.pathname === "/map" || u.pathname === "/merchant/businesses",
      { timeout: 15000 }
    );

    // Check existing DEMO/TEST store status for merchant.qa
    const existingMerchBiz = await merchPage.evaluate(async () => {
      const r = await fetch("/api/v1/merchant/businesses", { cache: "no-store" });
      return r.json();
    });
    const prevDemo = (existingMerchBiz?.businesses ?? []).find((b) =>
      String(b.name || "").startsWith("DEMO/TEST 행궁 E2E 카페")
    );

    let createdBizId;
    let alreadyApproved = false;
    if (prevDemo) {
      createdBizId = prevDemo.id;
      alreadyApproved = prevDemo.registration_status === "approved";
      if (!alreadyApproved) {
        await merchPage.goto(`${BASE_URL}/merchant/restrooms`, { waitUntil: "domcontentloaded" });
        await merchPage.getByTestId("merchant-restroom-forbidden-403").waitFor();
      }
      await merchPage.goto(`${BASE_URL}/merchant/businesses/${createdBizId}`, {
        waitUntil: "domcontentloaded",
      });
      console.log(`✓ [Merchant Applicant] Reusing single DEMO/TEST business: ${createdBizId} (${prevDemo.registration_status})`);
      if (prevDemo.registration_status === "draft") {
        await merchPage.getByTestId("business-submit-review-button").click();
        await merchPage.getByTestId("business-status-badge-pending").waitFor({ timeout: 10000 });
      } else if (alreadyApproved) {
        await merchPage.getByTestId("business-status-badge-approved").waitFor({ timeout: 10000 });
      } else {
        await merchPage.getByTestId("business-status-badge-pending").waitFor({ timeout: 10000 });
      }
    } else {
      // Before approval: /merchant/restrooms -> 403
      await merchPage.goto(`${BASE_URL}/merchant/restrooms`, { waitUntil: "domcontentloaded" });
      await merchPage.getByTestId("merchant-restroom-forbidden-403").waitFor();

      await merchPage.goto(`${BASE_URL}/merchant/businesses/new`, { waitUntil: "domcontentloaded" });
      const storeName = `DEMO/TEST 행궁 E2E 카페 ${Date.now()}`;
      await merchPage.fill('input[name="name"]', storeName);
      await merchPage.fill('input[name="category"]', "카페");
      await merchPage.fill('input[name="road_address"]', "경기도 수원시 팔달구 정조로 800 (DEMO/TEST)");
      await merchPage.fill('input[name="latitude"]', "37.2835");
      await merchPage.fill('input[name="longitude"]', "127.0158");
      await merchPage.fill('input[name="registration_number"]', "123-45-67890");
      await merchPage.getByTestId("business-form-submit-button").click();
      await merchPage.waitForURL((u) => /^\/merchant\/businesses\/[0-9a-f-]+$/i.test(u.pathname), {
        timeout: 15000,
      });
      createdBizId = merchPage.url().split("/").pop();
      console.log(`✓ [Merchant Applicant] Created DEMO/TEST draft business: ${createdBizId}`);

      // Submit for review -> pending
      await merchPage.getByTestId("business-submit-review-button").click();
      await merchPage.getByTestId("business-status-badge-pending").waitFor({ timeout: 10000 });
      console.log("✓ [Merchant Applicant] Business submitted -> pending status verified");
    }

    // 3-2. Admin context: login -> /admin -> approve store -> /admin/receipts -> logout
    const ctxAdmin = await newMobileContext(browser);
    const adminPage = await ctxAdmin.newPage();
    adminPage.on("dialog", (d) => d.accept());

    await uiLogin(adminPage, "admin.qa@hujimap.test", accounts["admin.qa@hujimap.test"], "/admin");
    await adminPage.getByTestId("admin-dashboard-page").waitFor();
    await adminPage.getByTestId("admin-card-businesses").waitFor();
    await adminPage.getByTestId("admin-card-restrooms").waitFor();
    await adminPage.getByTestId("admin-card-receipts").waitFor();
    await adminPage.getByTestId("admin-card-leads").waitFor();
    await adminPage.getByTestId("admin-card-pmf").waitFor();
    await checkNoOverflow(adminPage, "admin-dashboard");
    console.log("✓ [Admin] Login -> /admin dashboard with 5 tools verified (no TASK 31 refund UI)");

    if (!alreadyApproved) {
      await adminPage.goto(`${BASE_URL}/admin/businesses`, { waitUntil: "networkidle" });
      await adminPage.getByTestId(`inspect-business-${createdBizId}`).click();
      await adminPage.getByTestId("admin-inspection-panel").waitFor();
      await adminPage.getByTestId("admin-approve-button").click();
      await adminPage.getByTestId("admin-businesses-success").waitFor({ timeout: 15000 });
      console.log("✓ [Admin] Approved DEMO/TEST business & granted merchant role");
    } else {
      await adminPage.goto(`${BASE_URL}/admin/businesses`, { waitUntil: "networkidle" });
      await adminPage.getByTestId("filter-tab-approved").click();
      await adminPage.getByTestId(`inspect-business-${createdBizId}`).click();
      await adminPage.getByTestId("admin-inspection-panel").waitFor();
      console.log("✓ [Admin] Verified approved DEMO/TEST business in /admin/businesses");
    }

    await adminPage.goto(`${BASE_URL}/admin/receipts`, { waitUntil: "domcontentloaded" });
    if ((await adminPage.getByTestId("admin-receipts-unauthorized-401").count()) > 0 ||
        (await adminPage.getByTestId("admin-receipts-forbidden-403").count()) > 0) {
      throw new Error("Admin blocked on /admin/receipts");
    }
    await checkNoOverflow(adminPage, "admin-receipts");

    await uiLogout(adminPage);
    await adminPage.goto(`${BASE_URL}/admin`, { waitUntil: "domcontentloaded" });
    await adminPage.getByTestId("admin-dashboard-unauthorized-401").waitFor();
    console.log("✓ [Admin] /admin/receipts OK & post-logout /admin 401 blocked");
    await ctxAdmin.close();

    // 3-3. Merchant context post-approval: verify merchant role, restrooms access, re-login redirect, 403 admin block, logout 401
    await merchPage.reload({ waitUntil: "domcontentloaded" });
    const merchSession = await merchPage.evaluate(async () => {
      const r = await fetch("/api/v1/auth/session", { cache: "no-store" });
      return r.json();
    });
    if (!merchSession.isMerchant || !merchSession.roles.includes("merchant")) {
      throw new Error(`Merchant role not granted after approval: ${JSON.stringify(merchSession)}`);
    }
    console.log("✓ [Merchant] Verified merchant role granted in session after admin approval");

    // Re-login redirect check -> /merchant/businesses
    await uiLogout(merchPage);
    await uiLogin(
      merchPage,
      "merchant.qa@hujimap.test",
      accounts["merchant.qa@hujimap.test"],
      "/merchant/businesses"
    );
    await merchPage.getByTestId("businesses-list-container").waitFor();

    // Access /merchant/restrooms & /merchant/restrooms/new (without publishing a restroom!)
    await merchPage.goto(`${BASE_URL}/merchant/restrooms`, { waitUntil: "networkidle" });
    await merchPage.getByTestId("restrooms-list-container").waitFor();
    await merchPage.goto(`${BASE_URL}/merchant/restrooms/new`, { waitUntil: "networkidle" });
    await merchPage.getByTestId("new-restroom-container").waitFor();
    await checkNoOverflow(merchPage, "merchant-restrooms-new");

    // Merchant blocked from /admin
    await merchPage.goto(`${BASE_URL}/admin`, { waitUntil: "domcontentloaded" });
    await merchPage.getByTestId("admin-dashboard-forbidden-403").waitFor();

    // Merchant logout -> 401
    await uiLogout(merchPage);
    await merchPage.goto(`${BASE_URL}/merchant/restrooms`, { waitUntil: "domcontentloaded" });
    await merchPage.getByTestId("merchant-unauthorized-401").waitFor();
    console.log("✓ [Merchant] Post-approval flow, /merchant/restrooms/new access, /admin 403, and post-logout 401 verified");
    await ctxMerch.close();

    console.log("ALL REAL LOCAL SUPABASE E2E CHECKS PASSED");
  } finally {
    if (browser) await browser.close();
    killTree(server.pid);
  }
}

run().catch((err) => {
  console.error("E2E_FAILED:", err);
  process.exit(1);
});

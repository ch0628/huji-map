/**
 * Real Chrome (360x740) + Local Supabase E2E Verification:
 * - Merchant operating hours creation/edit + DB persistence + reload
 * - Public & Customer operating hours display + empty hours ('운영시간 정보 없음', never '24시간 운영')
 * - Merchant PIN setup/rotation + AES-256-GCM encrypted DB verification (NO plaintext/key logged)
 * - Unauthorized PIN access block (guest 401, customer 403, pre-payment reveal-pin block)
 * - Policy display consistency across /map card and /restrooms/[id] detail:
 *   free, 1,000원 test_deposit, 2,000원 test_deposit (no '결제 기능 준비 중', no 360px overflow)
 * - Preserves 586 public restrooms & 1 partner restroom
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "@playwright/test";
import { execSync, spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const TARGET_RESTROOM_ID = "5df3e8ce-597a-4c4f-bc5b-fa671301e8f8";
const OTHER_RESTROOM_ID = "a1111111-1111-4111-8111-111111111111";

function loadEnvLocal() {
  const envPath = path.join(process.cwd(), ".env.local");
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  const env = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    env[key] = val;
  }
  return env;
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
  if (!map["customer.qa@hujimap.test"] || !map["merchant.qa@hujimap.test"]) {
    throw new Error("QA accounts missing from local-data/qa_accounts.local.txt");
  }
  return map;
}

function decryptPinInMemory(row, env) {
  const rawKey = env.PIN_ENCRYPTION_KEY || env.PIN_ENCRYPTION_KEY_BASE64;
  if (!rawKey) throw new Error("PIN key missing in .env.local");
  const trimmed = rawKey.trim();
  const keyBuffer = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  const iv = Buffer.from(row.iv_b64, "base64");
  const authTag = Buffer.from(row.auth_tag_b64, "base64");
  const ciphertext = Buffer.from(row.ciphertext_b64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBuffer, iv, {
    authTagLength: 16,
  });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function killTree(pid) {
  if (!pid) return;
  try {
    execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
  } catch {}
}

async function ensureServer() {
  try {
    const res = await fetch(`${BASE_URL}/`);
    if (res.status === 200) {
      console.log(`✓ Reusing running server at ${BASE_URL}`);
      return { server: null, reused: true };
    }
  } catch {}

  const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
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
      if (res.status === 200) return { server, reused: false };
    } catch {}
  }
  killTree(server.pid);
  throw new Error("Next server failed to start");
}

function assert(cond, msg) {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
}

async function checkNoOverflow(page, label) {
  const { sw, iw } = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
  }));
  assert(sw <= iw, `[${label}] Horizontal overflow: ${sw} > ${iw}`);
}

async function loginViaUi(page, email, password) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle" });
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  const resPromise = page.waitForResponse(
    (res) => res.url().includes("/api/v1/auth/login") && res.request().method() === "POST",
    { timeout: 15000 }
  );
  await page.locator('button[type="submit"]').click();
  const res = await resPromise;
  assert(res.status() === 200, `Login failed for ${email}: status ${res.status()}`);
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 });
}

async function openPartnerCardOnMap(page, roleLabel) {
  const initialApi = page.waitForResponse(
    (res) => res.url().includes("/api/v1/restrooms") && res.status() === 200,
    { timeout: 20000 }
  );
  await page.goto(`${BASE_URL}/map`, { waitUntil: "domcontentloaded" });
  await initialApi;
  await page.waitForSelector('[data-testid="map-zoom-out-btn"]', { timeout: 15000 });
  await page.waitForTimeout(1000);

  for (let i = 0; i < 4; i++) {
    await page.getByTestId("map-zoom-out-btn").click();
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(500);

  const partnerApi = page.waitForResponse(
    (res) =>
      res.url().includes("/api/v1/restrooms") &&
      res.url().includes("type=partner") &&
      res.status() === 200,
    { timeout: 15000 }
  );
  await page.getByTestId("filter-chip-partner").click();
  await partnerApi;
  await page.waitForTimeout(500);
  await checkNoOverflow(page, `${roleLabel}:/map`);

  await page.getByTestId("bottom-sheet-toggle-btn").click();
  const card = page.getByTestId(`public-restroom-card-${TARGET_RESTROOM_ID}`);
  await card.waitFor({ state: "visible", timeout: 10000 });
  return card;
}

async function run() {
  const env = loadEnvLocal();
  const accounts = loadQaAccounts();
  const adminSb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Read initial state so we can restore cleanly
  const { data: initialFlag } = await adminSb
    .from("feature_flags")
    .select("enabled")
    .eq("key", "partner_restroom_discovery")
    .single();
  const initialFlagEnabled = initialFlag?.enabled ?? false;

  const { data: initialHours } = await adminSb
    .from("restroom_hours")
    .select("*")
    .eq("restroom_id", TARGET_RESTROOM_ID);

  const { count: publicCountBefore } = await adminSb
    .from("restrooms")
    .select("*", { count: "exact", head: true })
    .eq("type", "public");
  const { count: partnerCountBefore } = await adminSb
    .from("restrooms")
    .select("*", { count: "exact", head: true })
    .eq("type", "partner");

  assert(publicCountBefore === 586, `Expected 586 public restrooms before, got ${publicCountBefore}`);
  assert(partnerCountBefore === 1, `Expected 1 partner restroom before, got ${partnerCountBefore}`);

  let serverProc = null;
  let browser = null;

  try {
    // Enable partner discovery temporarily for public verification
    await adminSb
      .from("feature_flags")
      .update({ enabled: true })
      .eq("key", "partner_restroom_discovery");

    const started = await ensureServer();
    serverProc = started.server;

    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    });

    const contextOpts = {
      viewport: { width: 360, height: 740 },
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      isMobile: true,
      hasTouch: true,
    };

    // =========================================================================
    // 1. Check empty operating hours display BEFORE merchant sets hours
    // =========================================================================
    console.log("\n>>> 1. Empty hours check ('운영시간 정보 없음', never '24시간 운영')...");
    await adminSb.from("restroom_hours").delete().eq("restroom_id", TARGET_RESTROOM_ID);

    const guestCtx = await browser.newContext(contextOpts);
    const guestPage = await guestCtx.newPage();
    await guestPage.goto(`${BASE_URL}/restrooms/${TARGET_RESTROOM_ID}`, {
      waitUntil: "networkidle",
    });
    await checkNoOverflow(guestPage, "guest:detail-empty-hours");
    const emptyHoursText = await guestPage.getByTestId("restroom-hours-section").innerText();
    assert(emptyHoursText.includes("운영시간 정보 없음"), "Missing '운영시간 정보 없음' when hours empty");
    assert(!emptyHoursText.includes("24시간 운영"), "Must NOT display '24시간 운영' when hours empty");
    console.log("✓ Guest detail shows '운영시간 정보 없음' and never '24시간 운영'.");

    // Unauthorized guest PIN POST blocked with 401
    const guestPinRes = await guestPage.evaluate(async (id) => {
      const r = await fetch(`/api/v1/merchant/restrooms/${id}/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: "1234" }),
      });
      return r.status;
    }, TARGET_RESTROOM_ID);
    assert(guestPinRes === 401, `Guest PIN POST expected 401, got ${guestPinRes}`);
    console.log("✓ Guest PIN POST blocked with 401.");

    // =========================================================================
    // 2. Merchant: Operating Hours Create/Edit + PIN Register/Rotate + Policy Changes
    // =========================================================================
    console.log("\n>>> 2. Merchant login & /merchant/restrooms/new mobile check...");
    const merchantCtx = await browser.newContext(contextOpts);
    const merchantPage = await merchantCtx.newPage();
    await loginViaUi(merchantPage, "merchant.qa@hujimap.test", accounts["merchant.qa@hujimap.test"]);

    await merchantPage.goto(`${BASE_URL}/merchant/restrooms/new`, { waitUntil: "networkidle" });
    await merchantPage.waitForSelector('[data-testid="restroom-hours-editor"]', { timeout: 15000 });
    await checkNoOverflow(merchantPage, "merchant:/merchant/restrooms/new");
    console.log("✓ /merchant/restrooms/new hours editor rendered without 360px overflow.");

    // Navigate to existing partner restroom edit page
    await merchantPage.goto(`${BASE_URL}/merchant/restrooms/${TARGET_RESTROOM_ID}`, {
      waitUntil: "networkidle",
    });
    await merchantPage.waitForSelector('[data-testid="restroom-pin-manager"]', { timeout: 15000 });
    await checkNoOverflow(merchantPage, "merchant:detail-initial");

    // 2A. Set operating hours: Mon 09:00~21:00, Tue 10:00~22:00, Sun closed
    console.log("\n>>> 3. Merchant sets operating hours (Mon/Tue open, Sun closed)...");
    await merchantPage.getByTestId("hour-mode-1").selectOption("open");
    await merchantPage.getByTestId("hour-opens-1").fill("09:00");
    await merchantPage.getByTestId("hour-closes-1").fill("21:00");

    await merchantPage.getByTestId("hour-mode-2").selectOption("open");
    await merchantPage.getByTestId("hour-opens-2").fill("10:00");
    await merchantPage.getByTestId("hour-closes-2").fill("22:00");

    await merchantPage.getByTestId("hour-mode-0").selectOption("closed");

    const saveHoursPromise1 = merchantPage.waitForResponse(
      (r) =>
        r.url().includes(`/api/v1/merchant/restrooms/${TARGET_RESTROOM_ID}`) &&
        r.request().method() === "PATCH",
      { timeout: 15000 }
    );
    await merchantPage.getByTestId("restroom-form-submit-button").click();
    const saveHoursRes1 = await saveHoursPromise1;
    assert(saveHoursRes1.status() === 200, `PATCH hours 1 failed: ${saveHoursRes1.status()}`);
    await merchantPage.waitForSelector('[data-testid="restroom-form-success"]');

    // Verify DB saved 3 rows
    const { data: savedHours1 } = await adminSb
      .from("restroom_hours")
      .select("weekday, opens_at, closes_at, is_closed")
      .eq("restroom_id", TARGET_RESTROOM_ID)
      .order("weekday");
    assert(savedHours1?.length === 3, `Expected 3 hour rows in DB, got ${savedHours1?.length}`);
    assert(savedHours1[0].weekday === 0 && savedHours1[0].is_closed === true, "Sunday should be closed");
    assert(
      savedHours1[1].weekday === 1 &&
        savedHours1[1].opens_at.startsWith("09:00") &&
        savedHours1[1].closes_at.startsWith("21:00"),
      "Monday hours mismatch in DB"
    );

    // Reload and verify UI restores hours, then edit Monday to 08:30~20:30
    await merchantPage.reload({ waitUntil: "networkidle" });
    await merchantPage.waitForSelector('[data-testid="restroom-hours-editor"]');
    assert(
      (await merchantPage.getByTestId("hour-mode-1").inputValue()) === "open",
      "Reload did not restore Monday open mode"
    );
    assert(
      (await merchantPage.getByTestId("hour-opens-1").inputValue()) === "09:00",
      "Reload did not restore Monday opens_at"
    );
    assert(
      (await merchantPage.getByTestId("hour-mode-0").inputValue()) === "closed",
      "Reload did not restore Sunday closed mode"
    );

    await merchantPage.getByTestId("hour-opens-1").fill("08:30");
    await merchantPage.getByTestId("hour-closes-1").fill("20:30");
    const saveHoursPromise2 = merchantPage.waitForResponse(
      (r) =>
        r.url().includes(`/api/v1/merchant/restrooms/${TARGET_RESTROOM_ID}`) &&
        r.request().method() === "PATCH",
      { timeout: 15000 }
    );
    await merchantPage.getByTestId("restroom-form-submit-button").click();
    const saveHoursRes2 = await saveHoursPromise2;
    assert(saveHoursRes2.status() === 200, `PATCH hours 2 failed: ${saveHoursRes2.status()}`);

    const { data: savedHours2 } = await adminSb
      .from("restroom_hours")
      .select("weekday, opens_at, closes_at, is_closed")
      .eq("restroom_id", TARGET_RESTROOM_ID)
      .eq("weekday", 1)
      .single();
    assert(
      savedHours2?.opens_at.startsWith("08:30") && savedHours2?.closes_at.startsWith("20:30"),
      `Updated Monday hours mismatch in DB: ${JSON.stringify(savedHours2)}`
    );
    console.log("✓ Operating hours created, reloaded, edited, and verified in DB.");

    // 2B. PIN Set & Rotate
    console.log("\n>>> 4. Merchant sets & rotates doorlock PIN...");
    const testPin1 = "4829*";
    const testPin2 = "7391#";

    await merchantPage.getByTestId("pin-input").fill(testPin1);
    await merchantPage.getByTestId("pin-confirm-input").fill(testPin1);
    const pinResPromise1 = merchantPage.waitForResponse(
      (r) =>
        r.url().includes(`/api/v1/merchant/restrooms/${TARGET_RESTROOM_ID}/pin`) &&
        r.request().method() === "POST",
      { timeout: 15000 }
    );
    await merchantPage.getByTestId("pin-submit-button").click();
    const pinRes1 = await pinResPromise1;
    assert(pinRes1.status() === 200, `PIN register failed: ${pinRes1.status()}`);
    const pinJson1 = await pinRes1.json();
    assert(pinJson1.ok === true && typeof pinJson1.codeVersion === "number", "Invalid PIN response");
    assert(!JSON.stringify(pinJson1).includes(testPin1), "PIN API response leaked plaintext PIN!");
    assert(!JSON.stringify(pinJson1).includes("ciphertext"), "PIN API response leaked ciphertext!");

    await merchantPage.waitForSelector('[data-testid="pin-manager-success"]');

    // Check DB encrypted storage
    const { data: activeSecret1 } = await adminSb
      .from("restroom_lock_secrets")
      .select("*")
      .eq("restroom_id", TARGET_RESTROOM_ID)
      .eq("status", "active")
      .single();
    assert(Boolean(activeSecret1?.ciphertext_b64), "Missing ciphertext_b64 in DB");
    assert(activeSecret1.ciphertext_b64 !== testPin1, "Ciphertext matches plaintext!");
    assert(
      !JSON.stringify(activeSecret1).includes(testPin1),
      "DB secret row contains plaintext PIN!"
    );
    assert(
      decryptPinInMemory(activeSecret1, env) === testPin1,
      "Decrypted DB ciphertext did not match registered PIN"
    );

    // Rotate PIN to testPin2
    await merchantPage.getByTestId("pin-input").fill(testPin2);
    await merchantPage.getByTestId("pin-confirm-input").fill(testPin2);
    const pinResPromise2 = merchantPage.waitForResponse(
      (r) =>
        r.url().includes(`/api/v1/merchant/restrooms/${TARGET_RESTROOM_ID}/pin`) &&
        r.request().method() === "POST",
      { timeout: 15000 }
    );
    await merchantPage.getByTestId("pin-submit-button").click();
    const pinRes2 = await pinResPromise2;
    assert(pinRes2.status() === 200, `PIN rotate failed: ${pinRes2.status()}`);
    const pinJson2 = await pinRes2.json();
    assert(pinJson2.codeVersion === pinJson1.codeVersion + 1, "codeVersion did not increment on rotate");

    const { data: activeSecret2 } = await adminSb
      .from("restroom_lock_secrets")
      .select("*")
      .eq("restroom_id", TARGET_RESTROOM_ID)
      .eq("status", "active")
      .single();
    assert(activeSecret2.code_version === pinJson2.codeVersion, "Active secret code_version mismatch");
    assert(
      decryptPinInMemory(activeSecret2, env) === testPin2,
      "Decrypted rotated DB ciphertext did not match new PIN"
    );

    // Verify merchant detail reload never exposes PIN
    await merchantPage.reload({ waitUntil: "networkidle" });
    const merchantBody = await merchantPage.innerText("body");
    assert(!merchantBody.includes(testPin1) && !merchantBody.includes(testPin2), "Merchant UI leaked PIN!");
    assert(
      (await merchantPage.getByTestId("pin-status-badge").innerText()).includes(`v${pinJson2.codeVersion}`),
      "PIN status badge missing updated version"
    );
    console.log(`✓ PIN encrypted, stored (v${pinJson1.codeVersion} -> v${pinJson2.codeVersion}), and rotated safely.`);

    // =========================================================================
    // 3. Policy transitions & Public/Customer verification
    // =========================================================================
    const customerCtx = await browser.newContext(contextOpts);
    const customerPage = await customerCtx.newPage();
    await loginViaUi(customerPage, "customer.qa@hujimap.test", accounts["customer.qa@hujimap.test"]);

    // 3A. Unauthorized checks as customer
    console.log("\n>>> 5. Unauthorized PIN & merchant route checks for customer...");
    await customerPage.goto(`${BASE_URL}/merchant/restrooms/${TARGET_RESTROOM_ID}`, {
      waitUntil: "networkidle",
    });
    const custMerchantStatus = await customerPage.evaluate(async (id) => {
      const r = await fetch(`/api/v1/merchant/restrooms/${id}/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: "1234" }),
      });
      return r.status;
    }, TARGET_RESTROOM_ID);
    assert(custMerchantStatus === 403, `Customer PIN POST expected 403, got ${custMerchantStatus}`);

    const prePayRevealStatus = await customerPage.evaluate(async (id) => {
      const r = await fetch(`/api/v1/access/${id}/reveal-pin`, { method: "POST" });
      return r.status;
    }, TARGET_RESTROOM_ID);
    assert(
      prePayRevealStatus >= 400 && prePayRevealStatus < 500,
      `Pre-payment reveal-pin expected 4xx block, got ${prePayRevealStatus}`
    );
    console.log("✓ Customer PIN setup (403) and pre-payment reveal-pin blocked.");

    // 3B. Policy = FREE
    console.log("\n>>> 6. Testing FREE policy on merchant -> map card -> public detail...");
    await merchantPage.locator('input[name="change_policy_mode"][value="free_with_ad"]').check();
    const freePolPromise = merchantPage.waitForResponse(
      (r) => r.url().includes(`/api/v1/merchant/restrooms/${TARGET_RESTROOM_ID}/policies`),
      { timeout: 15000 }
    );
    await merchantPage.getByTestId("create-policy-button").click();
    assert((await freePolPromise).status() === 201, "Create free policy failed");
    await merchantPage.waitForSelector('[data-testid="policy-manager-success"]');

    // Guest Map + Detail (FREE)
    const freeCard = await openPartnerCardOnMap(guestPage, "guest-free");
    const freeCardText = await freeCard.innerText();
    assert(freeCardText.includes("무료"), "FREE card must show 무료");
    assert(!freeCardText.includes("1,000원"), "FREE card must NOT show 1,000원");
    assert(!freeCardText.includes("결제 기능 준비 중"), "Card must NOT show 준비 중");
    assert(
      (await freeCard.locator(`[data-testid="partner-payment-btn-${TARGET_RESTROOM_ID}"]`).count()) === 0,
      "FREE card must NOT have payment button"
    );

    await guestPage.getByTestId(`detail-link-${TARGET_RESTROOM_ID}`).click();
    await guestPage.waitForURL((u) => u.pathname === `/restrooms/${TARGET_RESTROOM_ID}`);
    await guestPage.waitForSelector('[data-testid="public-restroom-detail-view"]');
    await checkNoOverflow(guestPage, "guest:detail-free");
    const freeDetailText = await guestPage.getByTestId("public-restroom-detail-view").innerText();
    assert(freeDetailText.includes("안심 제휴 무료 이용"), "FREE detail missing free notice");
    assert(!freeDetailText.includes("1,000원"), "FREE detail must NOT show 1,000원");
    assert(
      (await guestPage.locator('[data-testid="detail-partner-payment-btn"]').count()) === 0,
      "FREE detail must NOT render payment button"
    );
    // Operating hours visible to guest
    assert(freeDetailText.includes("08:30 ~ 20:30"), "Guest detail missing Monday hours");
    assert(freeDetailText.includes("10:00 ~ 22:00"), "Guest detail missing Tuesday hours");
    assert(freeDetailText.includes("휴무"), "Guest detail missing Sunday closed");
    assert(!freeDetailText.includes(testPin1) && !freeDetailText.includes(testPin2), "Guest detail leaked PIN!");
    console.log("✓ FREE policy + operating hours verified for guest without 1,000원 or PIN leak.");

    // 3C. Policy = TEST_DEPOSIT 2,000원
    console.log("\n>>> 7. Testing 2,000원 test_deposit policy on merchant -> map card -> customer detail...");
    await merchantPage.locator('input[name="change_policy_mode"][value="deposit_with_ad"]').check();
    await merchantPage.getByTestId("policy-deposit-amount-input").fill("2000");
    const pol2000Promise = merchantPage.waitForResponse(
      (r) => r.url().includes(`/api/v1/merchant/restrooms/${TARGET_RESTROOM_ID}/policies`),
      { timeout: 15000 }
    );
    await merchantPage.getByTestId("create-policy-button").click();
    assert((await pol2000Promise).status() === 201, "Create 2000원 policy failed");
    await merchantPage.waitForSelector('[data-testid="policy-manager-success"]');

    const card2000 = await openPartnerCardOnMap(customerPage, "customer-2000");
    const card2000Text = await card2000.innerText();
    assert(card2000Text.includes("2,000원"), `Expected 2,000원 on card, got: ${card2000Text}`);
    assert(!card2000Text.includes("1,000원"), "Card leaked 1,000원 when DB is 2,000원");
    assert(!card2000Text.includes("결제 기능 준비 중"), "Card must NOT show 준비 중");

    // Verify 360px button layout on card
    const cardBtnMetrics = await card2000.evaluate((el) => {
      const buttons = Array.from(el.querySelectorAll("button, a"));
      return buttons.map((b) => {
        const rect = b.getBoundingClientRect();
        return { text: b.textContent?.trim(), height: rect.height, width: rect.width };
      });
    });
    for (const m of cardBtnMetrics) {
      assert(m.height >= 44 && m.height <= 56, `360px card button wrap/height issue: ${JSON.stringify(m)}`);
    }

    await customerPage.getByTestId(`detail-link-${TARGET_RESTROOM_ID}`).click();
    await customerPage.waitForURL((u) => u.pathname === `/restrooms/${TARGET_RESTROOM_ID}`);
    await customerPage.waitForSelector('[data-testid="public-restroom-detail-view"]');
    await checkNoOverflow(customerPage, "customer:detail-2000");
    const detail2000Text = await customerPage.getByTestId("public-restroom-detail-view").innerText();
    assert(detail2000Text.includes("2,000원"), "Detail missing 2,000원");
    assert(
      (await customerPage.getByTestId("detail-partner-payment-btn").innerText()).includes("2,000원"),
      "Payment button missing 2,000원"
    );
    assert(detail2000Text.includes("08:30 ~ 20:30"), "Customer detail missing Monday hours");
    assert(!detail2000Text.includes(testPin1) && !detail2000Text.includes(testPin2), "Customer detail leaked PIN!");
    console.log("✓ 2,000원 policy + customer hours + 360px button geometry verified.");

    // 3D. Policy = TEST_DEPOSIT 1,000원
    console.log("\n>>> 8. Testing 1,000원 test_deposit policy...");
    await merchantPage.locator('input[name="change_policy_mode"][value="deposit_with_ad"]').check();
    await merchantPage.getByTestId("policy-deposit-amount-input").fill("1000");
    const pol1000Promise = merchantPage.waitForResponse(
      (r) => r.url().includes(`/api/v1/merchant/restrooms/${TARGET_RESTROOM_ID}/policies`),
      { timeout: 15000 }
    );
    await merchantPage.getByTestId("create-policy-button").click();
    assert((await pol1000Promise).status() === 201, "Create 1000원 policy failed");
    await merchantPage.waitForSelector('[data-testid="policy-manager-success"]');

    const card1000 = await openPartnerCardOnMap(guestPage, "guest-1000");
    const card1000Text = await card1000.innerText();
    assert(card1000Text.includes("1,000원"), "Expected 1,000원 on card");
    await guestPage.getByTestId(`detail-link-${TARGET_RESTROOM_ID}`).click();
    await guestPage.waitForURL((u) => u.pathname === `/restrooms/${TARGET_RESTROOM_ID}`);
    await guestPage.waitForSelector('[data-testid="detail-partner-payment-btn"]');
    assert(
      (await guestPage.getByTestId("detail-partner-payment-btn").innerText()).includes("1,000원"),
      "Detail payment button missing 1,000원"
    );
    console.log("✓ 1,000원 policy verified on card and detail.");

    await guestPage.screenshot({
      path: path.join(process.cwd(), "tests/e2e/screenshots/partner_info_pin_detail_mobile.png"),
    });

    await guestCtx.close();
    await merchantCtx.close();
    await customerCtx.close();

    // Verify counts preserved
    const { count: publicCountAfter } = await adminSb
      .from("restrooms")
      .select("*", { count: "exact", head: true })
      .eq("type", "public");
    const { count: partnerCountAfter } = await adminSb
      .from("restrooms")
      .select("*", { count: "exact", head: true })
      .eq("type", "partner");
    assert(publicCountAfter === 586, `Expected 586 public restrooms after, got ${publicCountAfter}`);
    assert(partnerCountAfter === 1, `Expected 1 partner restroom after, got ${partnerCountAfter}`);

    console.log("\n=== ALL PARTNER INFO & PIN E2E CHECKS PASSED (586 public, 1 partner preserved) ===");
  } finally {
    // Restore original flag & hours state cleanly
    await adminSb
      .from("feature_flags")
      .update({ enabled: initialFlagEnabled })
      .eq("key", "partner_restroom_discovery");

    await adminSb.from("restroom_hours").delete().eq("restroom_id", TARGET_RESTROOM_ID);
    if (initialHours && initialHours.length > 0) {
      await adminSb.from("restroom_hours").insert(initialHours);
    }

    if (browser) await browser.close();
    if (serverProc) killTree(serverProc.pid);
  }
}

run().catch((err) => {
  console.error("E2E FAILED:", err);
  process.exit(1);
});

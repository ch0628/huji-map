import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { execSync, spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const TARGET_BUSINESS_ID = "06d803e0-bf16-473b-ac3e-4a917c24a77d";
const TARGET_RESTROOM_ID = "5df3e8ce-597a-4c4f-bc5b-fa671301e8f8";
const DRAFT_RESTROOM_ID = "bf3f1881-e0ac-4d64-89c0-b0f3137c0b48";
const SUWON_BBOX = "37.24,126.98,37.31,127.06";

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

function loadCustomerAccount() {
  const filePath = path.join(process.cwd(), "local-data", "qa_accounts.local.txt");
  const text = fs.readFileSync(filePath, "utf8");
  const blocks = text.split(/^## /m).slice(1);
  for (const b of blocks) {
    const emailMatch = b.match(/^- 로그인 이메일:\s*(.+)$/m);
    const passMatch = b.match(/^- 임시 비밀번호:\s*(.+)$/m);
    if (emailMatch?.[1]?.trim() === "customer.qa@hujimap.test" && passMatch?.[1]) {
      return {
        email: emailMatch[1].trim(),
        password: passMatch[1].trim(),
      };
    }
  }
  throw new Error("customer.qa@hujimap.test missing from local-data/qa_accounts.local.txt");
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

async function verifyMapAndDetailFlow(page, roleLabel, expectedDb) {
  // 1. /map 접속 (React 하이드레이션 + 초기 API + Kakao 지도 초기화 대기)
  const initialApiPromise = page.waitForResponse(
    (res) => res.url().includes("/api/v1/restrooms") && res.status() === 200,
    { timeout: 20000 }
  );
  await page.goto(`${BASE_URL}/map`, { waitUntil: "domcontentloaded" });
  await initialApiPromise;
  await page.waitForSelector('[data-testid="map-filter-bar"]', { timeout: 15000 });
  await page.waitForSelector('[data-testid="map-zoom-out-btn"]', { timeout: 15000 });
  await page.waitForTimeout(1200);
  await checkNoOverflow(page, `${roleLabel}:/map`);

  // 행궁동 좌표(37.2835, 127.0158)가 360px 뷰포트에 포함되도록 줌 아웃(4단계) 후 안심 제휴 필터 선택
  for (let i = 0; i < 4; i++) {
    await page.getByTestId("map-zoom-out-btn").click();
    await page.waitForTimeout(350);
  }
  await page.waitForTimeout(600);

  // 2. 안심 제휴 필터 선택
  const partnerApiPromise = page.waitForResponse(
    (res) =>
      res.url().includes("/api/v1/restrooms") &&
      res.url().includes("type=partner") &&
      res.status() === 200,
    { timeout: 15000 }
  );
  await page.getByTestId("filter-chip-partner").click();
  const partnerApiRes = await partnerApiPromise;
  const partnerJson = await partnerApiRes.json();
  assert(partnerJson.ok === true, `[${roleLabel}] partner API ok !== true`);
  assert(
    partnerJson.data.items.some((i) => i.id === TARGET_RESTROOM_ID),
    `[${roleLabel}] partner API did not include ${TARGET_RESTROOM_ID} (url=${partnerApiRes.url()}, count=${partnerJson.data.items.length})`
  );

  // 3. 승인된 제휴 화장실 마커 표시 확인 (카카오 지도 컨테이너 내 마커 SVG/area/img 확인)
  await page.waitForTimeout(1000);
  const markerDetected = await page.evaluate((restroomName) => {
    const imgs = Array.from(document.querySelectorAll("img"));
    const purpleMarkerImg = imgs.some((img) => {
      const src = img.getAttribute("src") || "";
      const title = img.getAttribute("title") || "";
      return src.includes("7e22ce") || title.includes("[제휴]");
    });
    const titledEl = Array.from(document.querySelectorAll("[title]")).some((el) =>
      (el.getAttribute("title") || "").includes(restroomName)
    );
    const tileCount = imgs.filter((img) => (img.src || "").includes("daumcdn") || (img.src || "").includes("kakaocdn")).length;
    return { purpleMarkerImg, titledEl, tileCount, imgCount: imgs.length };
  }, expectedDb.restroom.name);
  assert(
    markerDetected.purpleMarkerImg || markerDetected.titledEl,
    `[${roleLabel}] Partner marker not detected on map canvas: ${JSON.stringify(markerDetected)}`
  );
  console.log(`  [${roleLabel}] Kakao map marker detected:`, JSON.stringify(markerDetected));

  // 4. 목록(바텀시트)에서 제휴 화장실 확인
  await page.getByTestId("bottom-sheet-toggle-btn").click();
  const cardLocator = page.getByTestId(`public-restroom-card-${TARGET_RESTROOM_ID}`);
  await cardLocator.waitFor({ state: "visible", timeout: 10000 });
  const cardText = await cardLocator.innerText();
  assert(cardText.includes(expectedDb.restroom.name), `[${roleLabel}] Card missing restroom name`);
  assert(cardText.includes(expectedDb.restroom.road_address), `[${roleLabel}] Card missing address`);
  assert(cardText.includes("1,000원"), `[${roleLabel}] Card missing 1,000원 policy`);

  if (roleLabel === "guest") {
    await page.screenshot({
      path: path.join(process.cwd(), "tests/e2e/screenshots/partner_discovery_guest_map.png"),
    });
  }

  // 5. 상세 페이지 정상 접근
  await page.getByTestId(`detail-link-${TARGET_RESTROOM_ID}`).click();
  await page.waitForURL((url) => url.pathname === `/restrooms/${TARGET_RESTROOM_ID}`, {
    timeout: 15000,
  });
  await page.getByTestId("public-restroom-detail-view").waitFor({ state: "visible", timeout: 15000 });
  await checkNoOverflow(page, `${roleLabel}:/restrooms/${TARGET_RESTROOM_ID}`);

  const detailText = await page.getByTestId("public-restroom-detail-view").innerText();
  assert(detailText.includes("안심 제휴 화장실"), `[${roleLabel}] Missing partner badge`);
  assert(detailText.includes(expectedDb.restroom.name), `[${roleLabel}] Detail missing restroom name`);
  assert(detailText.includes(expectedDb.restroom.road_address), `[${roleLabel}] Detail missing address`);
  assert(detailText.includes(expectedDb.business.name), `[${roleLabel}] Detail missing business name`);
  assert(detailText.includes("1,000원"), `[${roleLabel}] Detail missing 1,000원 policy`);
  assert(!detailText.includes("registration_number"), `[${roleLabel}] Sensitive key leaked`);

  if (roleLabel === "customer") {
    await page.screenshot({
      path: path.join(process.cwd(), "tests/e2e/screenshots/partner_discovery_customer_detail.png"),
    });
  }

  // 공공화장실 필터 정상 작동 확인
  await page.goto(`${BASE_URL}/map`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="filter-chip-public"]', { timeout: 15000 });
  const publicApiPromise = page.waitForResponse(
    (res) =>
      res.url().includes("/api/v1/restrooms") &&
      res.url().includes("type=public") &&
      res.status() === 200,
    { timeout: 15000 }
  );
  await page.getByTestId("filter-chip-public").click();
  const publicRes = await publicApiPromise;
  const publicJson = await publicRes.json();
  assert(publicJson.data.total > 0, `[${roleLabel}] Public restroom count should be > 0`);
}

async function run() {
  const env = loadEnvLocal();
  const customer = loadCustomerAccount();

  const adminSb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anonSb = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  // Read baseline DB state
  const { data: initialFlag } = await adminSb
    .from("feature_flags")
    .select("key,enabled")
    .eq("key", "partner_restroom_discovery")
    .single();
  assert(initialFlag?.enabled === false, `Expected initial flag false, got ${initialFlag?.enabled}`);

  const { data: dbBusiness } = await adminSb
    .from("businesses")
    .select("id,name,category,road_address,registration_status,latitude,longitude")
    .eq("id", TARGET_BUSINESS_ID)
    .single();
  assert(dbBusiness?.registration_status === "approved", "Target business must be approved");

  const { data: dbRestroom } = await adminSb
    .from("restrooms")
    .select("id,type,name,road_address,latitude,longitude,publication_status,business_id,access_method")
    .eq("id", TARGET_RESTROOM_ID)
    .single();
  assert(dbRestroom?.publication_status === "published", "Target restroom must be published");
  assert(dbRestroom?.latitude === 37.2835 && dbRestroom?.longitude === 127.0158, "Target coords mismatch");

  const { data: dbPolicy } = await adminSb
    .from("restroom_access_policies")
    .select("access_mode,deposit_amount_krw,is_active")
    .eq("restroom_id", TARGET_RESTROOM_ID)
    .eq("is_active", true)
    .single();
  assert(dbPolicy?.access_mode === "test_deposit" && dbPolicy?.deposit_amount_krw === 1000, "Target policy mismatch");

  const { data: publicCountsBefore } = await adminSb
    .from("restrooms")
    .select("id,publication_status")
    .eq("type", "public");
  assert(publicCountsBefore?.length === 586, `Expected 586 public restrooms, got ${publicCountsBefore?.length}`);

  const { server, reused } = await ensureServer();
  let browser;

  try {
    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
    });

    // === Phase A: Feature Flag = false verification ===
    {
      const partnerOffRes = await fetch(
        `${BASE_URL}/api/v1/restrooms?bbox=${encodeURIComponent(SUWON_BBOX)}&type=partner`
      );
      const partnerOffJson = await partnerOffRes.json();
      assert(partnerOffRes.status === 200 && partnerOffJson.data.total === 0 && partnerOffJson.data.items.length === 0,
        "Flag=false must return 0 partner restrooms");

      const detailOffRes = await fetch(`${BASE_URL}/api/v1/restrooms/${TARGET_RESTROOM_ID}`);
      assert(detailOffRes.status === 404, `Flag=false detail API must return 404, got ${detailOffRes.status}`);

      const publicOffRes = await fetch(
        `${BASE_URL}/api/v1/restrooms?bbox=${encodeURIComponent(SUWON_BBOX)}&type=public`
      );
      const publicOffJson = await publicOffRes.json();
      assert(publicOffRes.status === 200 && publicOffJson.data.total > 0, "Flag=false must keep public restrooms active");

      const ctxOff = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
      const pageOff = await ctxOff.newPage();
      const offInitApi = pageOff.waitForResponse(
        (res) => res.url().includes("/api/v1/restrooms") && res.status() === 200,
        { timeout: 20000 }
      );
      await pageOff.goto(`${BASE_URL}/map`, { waitUntil: "domcontentloaded" });
      await offInitApi;
      await pageOff.waitForSelector('[data-testid="filter-chip-partner"]', { timeout: 15000 });
      const offPartnerApi = pageOff.waitForResponse(
        (res) => res.url().includes("/api/v1/restrooms") && res.url().includes("type=partner") && res.status() === 200,
        { timeout: 15000 }
      );
      await pageOff.getByTestId("filter-chip-partner").click();
      await offPartnerApi;
      await pageOff.getByTestId("bottom-sheet-toggle-btn").click();
      await pageOff.getByTestId("bottom-sheet-empty-state").waitFor({ state: "visible", timeout: 10000 });
      await pageOff.goto(`${BASE_URL}/restrooms/${TARGET_RESTROOM_ID}`, { waitUntil: "networkidle" });
      const bodyTextOff = await pageOff.locator("body").innerText();
      assert(
        bodyTextOff.includes("화장실을 찾을 수 없습니다"),
        `Flag=false detail page must show not-found state, got: ${bodyTextOff.slice(0, 300)}`
      );
      await ctxOff.close();
      console.log("✓ [Phase A] Feature flag = false: partner hidden, public restrooms unaffected");
    }

    // === Phase B: Temporarily enable partner_restroom_discovery = true ===
    const { error: enableErr } = await adminSb
      .from("feature_flags")
      .update({ enabled: true })
      .eq("key", "partner_restroom_discovery");
    if (enableErr) throw enableErr;

    // 1. DB value comparison via API (guest)
    {
      const listRes = await fetch(
        `${BASE_URL}/api/v1/restrooms?bbox=${encodeURIComponent(SUWON_BBOX)}&type=partner`
      );
      const listJson = await listRes.json();
      assert(listRes.status === 200 && listJson.ok, "Flag=true partner list API failed");
      const item = listJson.data.items.find((x) => x.id === TARGET_RESTROOM_ID);
      assert(Boolean(item), "Target partner restroom missing in list API");
      assert(item.name === dbRestroom.name, "API list name mismatch");
      assert(item.road_address === dbRestroom.road_address, "API list road_address mismatch");
      assert(item.latitude === 37.2835 && item.longitude === 127.0158, "API list coords mismatch");
      assert(item.access_mode === "test_deposit" && item.deposit_amount_krw === 1000, "API list policy mismatch");
      assert(item.business_name === dbBusiness.name, "API list business_name mismatch");

      const detailRes = await fetch(`${BASE_URL}/api/v1/restrooms/${TARGET_RESTROOM_ID}`);
      const detailJson = await detailRes.json();
      assert(detailRes.status === 200 && detailJson.ok, "Flag=true partner detail API failed");
      assert(detailJson.data.name === dbRestroom.name, "API detail name mismatch");
      assert(detailJson.data.road_address === dbRestroom.road_address, "API detail road_address mismatch");
      assert(detailJson.data.latitude === 37.2835 && detailJson.data.longitude === 127.0158, "API detail coords mismatch");
      assert(detailJson.data.active_policy?.access_mode === "test_deposit", "API detail access_mode mismatch");
      assert(detailJson.data.active_policy?.deposit_amount_krw === 1000, "API detail deposit_amount_krw mismatch");
      assert(detailJson.data.business?.name === dbBusiness.name, "API detail business name mismatch");
      assert(detailJson.data.business?.registration_number === undefined, "registration_number must not be exposed");
      assert(detailJson.data.pin === undefined && detailJson.data.encrypted_pin === undefined, "PIN must not be exposed");

      // Draft / unapproved check + anon businesses RLS check
      const draftRes = await fetch(`${BASE_URL}/api/v1/restrooms/${DRAFT_RESTROOM_ID}`);
      assert(draftRes.status === 404, `Draft restroom must return 404, got ${draftRes.status}`);

      const { error: anonBizErr } = await anonSb
        .from("businesses")
        .select("id,name")
        .eq("id", TARGET_BUSINESS_ID);
      assert(anonBizErr?.code === "42501", `Direct anon SELECT on businesses must remain blocked (42501), got ${anonBizErr?.code}`);
      console.log("✓ [API & DB Match] Values match DB 100%, draft blocked (404), anon businesses RLS intact (42501)");
    }

    // 2. Guest Chrome E2E
    {
      const ctxGuest = await browser.newContext({
        viewport: { width: 360, height: 740 },
        isMobile: true,
        hasTouch: true,
      });
      const pageGuest = await ctxGuest.newPage();
      await verifyMapAndDetailFlow(pageGuest, "guest", {
        restroom: dbRestroom,
        business: dbBusiness,
      });

      // Draft restroom UI check
      await pageGuest.goto(`${BASE_URL}/restrooms/${DRAFT_RESTROOM_ID}`, { waitUntil: "networkidle" });
      const draftText = await pageGuest.locator("body").innerText();
      assert(
        draftText.includes("화장실을 찾을 수 없습니다"),
        `Guest draft detail must show blocked UI, got: ${draftText.slice(0, 200)}`
      );
      await ctxGuest.close();
      console.log("✓ [Guest Chrome E2E] Map, filter, marker, list, detail, public filter, draft block PASS");
    }

    // 3. Customer Chrome E2E
    {
      const ctxCustomer = await browser.newContext({
        viewport: { width: 360, height: 740 },
        isMobile: true,
        hasTouch: true,
      });
      const pageCustomer = await ctxCustomer.newPage();

      await pageCustomer.goto(`${BASE_URL}/login`, { waitUntil: "networkidle" });
      await pageCustomer.fill('input[name="email"]', customer.email);
      await pageCustomer.fill('input[name="password"]', customer.password);
      await pageCustomer.click('button[type="submit"]');
      await pageCustomer.waitForURL((url) => url.pathname === "/map", { timeout: 15000 });

      await verifyMapAndDetailFlow(pageCustomer, "customer", {
        restroom: dbRestroom,
        business: dbBusiness,
      });

      // Verify customer direct RLS on businesses still returns empty (no RLS relaxation)
      const custSb = createClient(
        env.NEXT_PUBLIC_SUPABASE_URL,
        env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } }
      );
      await custSb.auth.signInWithPassword({ email: customer.email, password: customer.password });
      const { data: custBizRows } = await custSb
        .from("businesses")
        .select("id")
        .eq("id", TARGET_BUSINESS_ID);
      assert(Array.isArray(custBizRows) && custBizRows.length === 0, "Customer direct RLS on businesses must still return []");
      await ctxCustomer.close();
      console.log("✓ [Customer Chrome E2E] Map, filter, marker, list, detail, public filter, RLS intact PASS");
    }
  } finally {
    // Restore feature flag to false
    await adminSb
      .from("feature_flags")
      .update({ enabled: false })
      .eq("key", "partner_restroom_discovery");

    const { data: restoredFlag } = await adminSb
      .from("feature_flags")
      .select("enabled")
      .eq("key", "partner_restroom_discovery")
      .single();

    const { data: publicCountsAfter } = await adminSb
      .from("restrooms")
      .select("id")
      .eq("type", "public");

    console.log(
      `✓ [Cleanup] partner_restroom_discovery restored=${restoredFlag?.enabled}, public_restrooms=${publicCountsAfter?.length}`
    );

    if (browser) await browser.close();
    if (!reused && server?.pid) {
      killTree(server.pid);
    }
  }
}

run().catch((err) => {
  console.error("E2E FAILED:", err);
  process.exit(1);
});

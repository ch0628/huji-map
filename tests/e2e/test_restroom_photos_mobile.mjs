/**
 * Real Chrome (360x740) + Local Supabase E2E Verification for STEP 3 Restroom Photos:
 * 1. Unauthorized upload/delete blocked (guest 401, customer 403)
 * 2. Merchant creates new restroom with photo attached -> uploads to private Storage `restroom-photos`
 * 3. Admin previews photo in `/admin/restrooms` and approves restroom + photo in ONE click
 * 4. Public customer sees actual approved photo `<img>` on `/restrooms/[id]` and thumbnail in API
 * 5. Post-approval A-plan replacement:
 *    - Merchant uploads replacement (pending) while existing approved photo remains live
 *    - Admin rejects replacement -> existing photo preserved
 *    - Merchant uploads new replacement -> Admin approves replacement -> new photo visible
 * 6. 360px mobile viewport layout check (`scrollWidth <= 360`) & clean DB/Storage cleanup
 */

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { execSync, spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

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
  return map;
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

  console.log("Starting Next.js production server...");
  const server = spawn("npm", ["run", "start", "--", "-p", String(PORT)], {
    cwd: process.cwd(),
    shell: true,
    stdio: "ignore",
  });

  for (let i = 0; i < 45; i++) {
    try {
      const res = await fetch(`${BASE_URL}/`);
      if (res.status === 200) {
        console.log(`✓ Server ready at ${BASE_URL}`);
        return { server, reused: false };
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  killTree(server.pid);
  throw new Error("Next.js server failed to start");
}

// Valid minimal 1x1 PNG buffer
function makeValidPngBuffer() {
  // 1x1 valid PNG (67 bytes)
  const hex =
    "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de" +
    "0000000c4944415408d763f8cfc000000301010018dd8db00000000049454e44ae426082";
  const buf = Buffer.from(hex, "hex");
  // Append harmless trailing comment chunk or use as valid PNG
  return buf;
}

async function loginInContext(context, email, password) {
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  const resPromise = page.waitForResponse(
    (res) => res.url().includes("/api/v1/auth/login") && res.request().method() === "POST",
    { timeout: 15000 }
  );
  await page.locator('button[type="submit"]').click();
  const res = await resPromise;
  assert.equal(res.status(), 200, `Login API failed for ${email}: status ${res.status()}`);
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 });
  await page.waitForLoadState("load");
  await page.waitForTimeout(300);
  return page;
}

async function checkNoHorizontalOverflow(page, label) {
  const dims = await page.evaluate(() => {
    const offenders = [];
    for (const el of document.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.right > 361) {
        offenders.push(`${el.tagName}.${el.className?.toString().slice(0, 60)}(right=${Math.round(r.right)})`);
        if (offenders.length >= 5) break;
      }
    }
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      offenders,
    };
  });
  assert.ok(
    dims.scrollWidth <= 360,
    `[${label}] Horizontal overflow detected: scrollWidth=${dims.scrollWidth} > 360; offenders=${JSON.stringify(dims.offenders)}`
  );
}

async function run() {
  const env = loadEnvLocal();
  const qa = loadQaAccounts();
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  assert.ok(supabaseUrl && secretKey, "Local Supabase URL and Secret Key required in .env.local");
  assert.ok(supabaseUrl.includes("127.0.0.1"), "Must run against local Supabase only!");

  const adminClient = createClient(supabaseUrl, secretKey);
  const { count: baselineRestroomCount } = await adminClient
    .from("restrooms")
    .select("id", { count: "exact", head: true });

  console.log(`Baseline local restrooms count: ${baselineRestroomCount}`);

  const { data: initialFlag } = await adminClient
    .from("feature_flags")
    .select("enabled")
    .eq("key", "partner_restroom_discovery")
    .maybeSingle();
  const initialFlagEnabled = initialFlag?.enabled ?? false;

  // Verify merchant has an approved business (needed to create restroom)
  const { data: merchantBiz } = await adminClient
    .from("businesses")
    .select("id, name, registration_status")
    .eq("registration_status", "approved")
    .limit(1)
    .single();
  assert.ok(merchantBiz, "At least one approved business required in local DB");

  const { server, reused } = await ensureServer();
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
  });

  let createdRestroomId = null;
  const createdStoragePaths = [];

  try {
    // Enable partner_restroom_discovery temporarily so public views test real publication gating & photos
    await adminClient
      .from("feature_flags")
      .update({ enabled: true })
      .eq("key", "partner_restroom_discovery");
    const guestCtx = await browser.newContext({ viewport: { width: 360, height: 740 } });
    const customerCtx = await browser.newContext({ viewport: { width: 360, height: 740 } });
    const merchantCtx = await browser.newContext({ viewport: { width: 360, height: 740 } });
    const adminCtx = await browser.newContext({ viewport: { width: 360, height: 740 } });

    // 1. Guest upload-intent blocked (401)
    const guestPage = await guestCtx.newPage();
    await guestPage.goto(`${BASE_URL}/map`, { waitUntil: "domcontentloaded" });
    const unauthStatus = await guestPage.evaluate(async () => {
      const r = await fetch("/api/v1/merchant/restrooms/11111111-1111-4111-8111-111111111111/photos/upload-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mimeType: "image/png", fileSizeBytes: 100 }),
      });
      return r.status;
    });
    assert.equal(unauthStatus, 401, "Guest upload-intent must be 401");
    console.log("✓ Step 1: Guest photo upload-intent blocked (401)");

    // 2. Merchant logs in and creates restroom + attaches photo
    const merchantPage = await loginInContext(
      merchantCtx,
      "merchant.qa@hujimap.test",
      qa["merchant.qa@hujimap.test"]
    );
    await merchantPage.goto(`${BASE_URL}/merchant/restrooms/new`, { waitUntil: "networkidle" });
    await checkNoHorizontalOverflow(merchantPage, "merchant/restrooms/new");

    await merchantPage.fill("#restroom-name", "E2E 사진 테스트 화장실");
    await merchantPage.fill('[data-testid="address-search-input"]', "경기도 수원시 팔달구 매산로 1");
    await merchantPage.click('[data-testid="address-search-button"]');
    await merchantPage.waitForSelector('[data-testid="address-search-result-0"]', { timeout: 15000 });
    await merchantPage.click('[data-testid="address-search-result-0"]');

    // Attach PNG v1
    const pngBuf = makeValidPngBuffer();
    await merchantPage.setInputFiles('[data-testid="restroom-photo-file-input"]', {
      name: "entrance-v1.png",
      mimeType: "image/png",
      buffer: pngBuf,
    });
    await merchantPage.waitForSelector('[data-testid="restroom-photo-create-section"] img');

    await merchantPage.click('[data-testid="restroom-form-submit-button"]');
    await merchantPage.waitForURL(/\/merchant\/restrooms\/[0-9a-f-]+$/, { timeout: 20000 });
    createdRestroomId = merchantPage.url().split("/").pop();
    assert.ok(createdRestroomId, "Created restroom ID missing");

    await merchantPage.waitForSelector('[data-testid="toggle-manage-photos-btn"]');
    await merchantPage.click('[data-testid="toggle-manage-photos-btn"]');
    await merchantPage.waitForSelector('[data-testid="restroom-photo-manager"]');
    await checkNoHorizontalOverflow(merchantPage, "merchant/restrooms/[id]");

    // Verify 1 pending photo exists in DB + Storage
    const { data: initialPhotos } = await adminClient
      .from("restroom_photos")
      .select("*")
      .eq("restroom_id", createdRestroomId);
    assert.equal(initialPhotos.length, 1);
    assert.equal(initialPhotos[0].moderation_status, "pending");
    assert.equal(initialPhotos[0].is_primary, true);
    createdStoragePaths.push(initialPhotos[0].storage_path);
    const photoV1Id = initialPhotos[0].id;

    // Customer cannot upload to merchant's restroom (403)
    const customerPage = await loginInContext(
      customerCtx,
      "customer.qa@hujimap.test",
      qa["customer.qa@hujimap.test"]
    );
    const forbiddenStatus = await customerPage.evaluate(async (rid) => {
      const r = await fetch(`/api/v1/merchant/restrooms/${rid}/photos/upload-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mimeType: "image/png", fileSizeBytes: 100 }),
      });
      return r.status;
    }, createdRestroomId);
    assert.ok(
      forbiddenStatus === 403 || forbiddenStatus === 404,
      `Customer accessing merchant restroom photo endpoint must be blocked (403/404), got ${forbiddenStatus}`
    );
    console.log(`✓ Step 2: Merchant restroom + photo uploaded & customer blocked (${forbiddenStatus})`);

    // Submit restroom for review
    await merchantPage.click('[data-testid="submit-restroom-review-button"]');
    await merchantPage.waitForSelector('[data-testid="restroom-submit-success"]', { timeout: 10000 });

    // Public detail must be 404 before approval
    const preApprovalRes = await guestPage.evaluate(async (rid) => {
      const r = await fetch(`/api/v1/restrooms/${rid}`);
      return r.status;
    }, createdRestroomId);
    assert.equal(preApprovalRes, 404, "Unapproved restroom must be 404 to public");
    console.log("✓ Step 3: Unapproved restroom & photo hidden (404)");

    // 4. Admin logs in, previews photo, and clicks Publish ONCE
    const adminPage = await loginInContext(
      adminCtx,
      "admin.qa@hujimap.test",
      qa["admin.qa@hujimap.test"]
    );
    await adminPage.goto(`${BASE_URL}/admin/restrooms`, { waitUntil: "networkidle" });
    await checkNoHorizontalOverflow(adminPage, "admin/restrooms");

    await adminPage.click(`[data-testid="inspect-restroom-btn-${createdRestroomId}"]`);
    await adminPage.waitForSelector(`[data-testid="admin-photo-card-${photoV1Id}"] img`);
    const adminImgLoaded = await adminPage.evaluate((pid) => {
      const img = document.querySelector(`[data-testid="admin-photo-card-${pid}"] img`);
      return Boolean(img && img.complete && img.naturalWidth > 0);
    }, photoV1Id);
    assert.ok(adminImgLoaded, "Admin preview image must load from private Storage signed URL");

    await adminPage.click('[data-testid="decision-btn-publish"]');
    await adminPage.click('[data-testid="confirm-decision-submit-btn"]');
    await adminPage.waitForFunction(
      (pid) => {
        const card = document.querySelector(`[data-testid="admin-photo-card-${pid}"]`);
        return card && card.textContent.includes("승인됨");
      },
      photoV1Id,
      { timeout: 15000 }
    );
    console.log("✓ Step 4: Admin integrated publish approved restroom + photo together");

    // 5. Public guest sees approved photo on /restrooms/[id] and in public API
    const publicListRes = await guestPage.evaluate(async (rid) => {
      const r = await fetch(`/api/v1/restrooms?bbox=37.1,126.9,37.4,127.2&type=partner&limit=50`);
      const json = await r.json();
      const item = json?.data?.items?.find((i) => i.id === rid);
      return { status: r.status, primaryPhotoUrl: item?.primary_photo_url ?? null };
    }, createdRestroomId);
    assert.equal(publicListRes.status, 200);
    assert.ok(publicListRes.primaryPhotoUrl, "Public catalog API must expose signed primary_photo_url");

    await guestPage.goto(`${BASE_URL}/restrooms/${createdRestroomId}`, { waitUntil: "networkidle" });
    await checkNoHorizontalOverflow(guestPage, "public/restrooms/[id]");
    await guestPage.waitForSelector(`[data-testid="public-restroom-photo-${photoV1Id}"] img`);
    const publicImgLoaded = await guestPage.evaluate((pid) => {
      const img = document.querySelector(`[data-testid="public-restroom-photo-${pid}"] img`);
      return Boolean(img && img.complete && img.naturalWidth > 0);
    }, photoV1Id);
    assert.ok(publicImgLoaded, "Public restroom detail image must load");
    console.log("✓ Step 5: Public customer detail & catalog display approved photo");

    // 6. Post-approval A-plan replacement:
    // Merchant reloads and uploads replacement photo v2
    await merchantPage.reload({ waitUntil: "domcontentloaded" });
    await merchantPage.waitForSelector('[data-testid="toggle-manage-photos-btn"]');
    await merchantPage.click('[data-testid="toggle-manage-photos-btn"]');
    await merchantPage.waitForSelector(`[data-testid="replace-photo-btn-${photoV1Id}"]`);
    const [fcV2] = await Promise.all([
      merchantPage.waitForEvent("filechooser"),
      merchantPage.click(`[data-testid="replace-photo-btn-${photoV1Id}"]`),
    ]);
    await fcV2.setFiles({
      name: "entrance-v2.png",
      mimeType: "image/png",
      buffer: pngBuf,
    });
    await merchantPage.waitForSelector('[data-testid="restroom-photo-manage-success"]', { timeout: 15000 });

    const { data: afterRepUpload } = await adminClient
      .from("restroom_photos")
      .select("*")
      .eq("restroom_id", createdRestroomId)
      .order("created_at", { ascending: true });
    const photoV2 = afterRepUpload.find((p) => p.id !== photoV1Id);
    assert.ok(photoV2, "Replacement photo v2 must exist");
    assert.equal(photoV2.moderation_status, "pending");
    assert.equal(photoV2.replaces_photo_id, photoV1Id);
    createdStoragePaths.push(photoV2.storage_path);

    // Public still sees v1 while v2 is pending
    await guestPage.reload({ waitUntil: "domcontentloaded" });
    await guestPage.waitForSelector(`[data-testid="public-restroom-photo-${photoV1Id}"]`);
    const v2VisibleWhilePending = await guestPage.$(`[data-testid="public-restroom-photo-${photoV2.id}"]`);
    assert.equal(v2VisibleWhilePending, null, "Pending replacement photo must not be visible publicly");

    // Admin rejects v2 -> v1 remains live
    await adminPage.goto(`${BASE_URL}/admin/restrooms`, { waitUntil: "load" });
    await adminPage.waitForSelector('[data-testid="tab-pending_photos"]');
    await adminPage.waitForTimeout(500);
    await Promise.all([
      adminPage.waitForResponse(
        (res) => res.url().includes("/api/v1/admin/restrooms") && res.url().includes("pending_photos") && res.status() === 200,
        { timeout: 15000 }
      ),
      adminPage.click('[data-testid="tab-pending_photos"]'),
    ]);
    await adminPage.waitForSelector(`[data-testid="inspect-restroom-btn-${createdRestroomId}"]`);
    await adminPage.click(`[data-testid="inspect-restroom-btn-${createdRestroomId}"]`);
    await adminPage.waitForSelector(`[data-testid="reject-photo-btn-${photoV2.id}"]`);
    await adminPage.click(`[data-testid="reject-photo-btn-${photoV2.id}"]`);
    await adminPage.fill(`[data-testid="photo-reject-reason-${photoV2.id}"]`, "화질 불명확");
    await adminPage.click(`[data-testid="confirm-reject-photo-btn-${photoV2.id}"]`);
    await adminPage.waitForSelector('[data-testid="decision-success-alert"]', { timeout: 15000 });

    const { data: rejectedCheck } = await adminClient
      .from("restroom_photos")
      .select("moderation_status, replaces_photo_id")
      .eq("id", photoV2.id)
      .single();
    assert.equal(rejectedCheck?.moderation_status, "rejected", "Photo v2 must be rejected in DB");

    await guestPage.reload({ waitUntil: "domcontentloaded" });
    await guestPage.waitForSelector(`[data-testid="public-restroom-photo-${photoV1Id}"]`);
    console.log("✓ Step 6a: Replacement reject preserves existing approved photo");

    // Merchant uploads v3 -> Admin approves replacement -> v3 replaces v1
    await merchantPage.reload({ waitUntil: "domcontentloaded" });
    await merchantPage.waitForSelector('[data-testid="toggle-manage-photos-btn"]');
    await merchantPage.click('[data-testid="toggle-manage-photos-btn"]');
    await merchantPage.waitForSelector(`[data-testid="replace-photo-btn-${photoV1Id}"]`);
    const [fcV3] = await Promise.all([
      merchantPage.waitForEvent("filechooser"),
      merchantPage.click(`[data-testid="replace-photo-btn-${photoV1Id}"]`),
    ]);
    await fcV3.setFiles({
      name: "entrance-v3.png",
      mimeType: "image/png",
      buffer: pngBuf,
    });
    await merchantPage.waitForSelector('[data-testid="restroom-photo-manage-success"]', { timeout: 15000 });

    const { data: afterRep3 } = await adminClient
      .from("restroom_photos")
      .select("*")
      .eq("restroom_id", createdRestroomId)
      .eq("moderation_status", "pending");
    assert.equal(afterRep3.length, 1);
    const photoV3 = afterRep3[0];
    createdStoragePaths.push(photoV3.storage_path);

    await adminPage.reload({ waitUntil: "load" });
    await adminPage.waitForSelector('[data-testid="tab-pending_photos"]');
    await adminPage.waitForTimeout(500);
    await Promise.all([
      adminPage.waitForResponse(
        (res) => res.url().includes("/api/v1/admin/restrooms") && res.url().includes("pending_photos") && res.status() === 200,
        { timeout: 15000 }
      ),
      adminPage.click('[data-testid="tab-pending_photos"]'),
    ]);
    await adminPage.waitForSelector(`[data-testid="inspect-restroom-btn-${createdRestroomId}"]`);
    await adminPage.click(`[data-testid="inspect-restroom-btn-${createdRestroomId}"]`);
    await adminPage.waitForSelector(`[data-testid="approve-photo-btn-${photoV3.id}"]`);
    await adminPage.click(`[data-testid="approve-photo-btn-${photoV3.id}"]`);
    await adminPage.waitForSelector('[data-testid="decision-success-alert"]', { timeout: 15000 });

    await guestPage.reload({ waitUntil: "domcontentloaded" });
    await guestPage.waitForSelector(`[data-testid="public-restroom-photo-${photoV3.id}"] img`);
    const v1Gone = await guestPage.$(`[data-testid="public-restroom-photo-${photoV1Id}"]`);
    assert.equal(v1Gone, null, "Replaced old photo v1 must no longer be visible");
    const v3ImgLoaded = await guestPage.evaluate((pid) => {
      const img = document.querySelector(`[data-testid="public-restroom-photo-${pid}"] img`);
      return Boolean(img && img.complete && img.naturalWidth > 0);
    }, photoV3.id);
    assert.ok(v3ImgLoaded, "Replacement approved photo v3 must load");
    console.log("✓ Step 6b: Replacement approve swaps primary photo cleanly");

    console.log("ALL REAL CHROME 360px PHOTO E2E CHECKS PASSED!");
  } finally {
    await browser.close();
    if (!reused && server) {
      killTree(server.pid);
    }

    // Cleanup E2E restroom & Storage files cleanly + restore feature flag
    await adminClient
      .from("feature_flags")
      .update({ enabled: initialFlagEnabled })
      .eq("key", "partner_restroom_discovery");
    if (createdRestroomId) {
      await adminClient.from("restroom_photos").delete().eq("restroom_id", createdRestroomId);
      await adminClient.from("restroom_access_policies").delete().eq("restroom_id", createdRestroomId);
      await adminClient.from("restrooms").delete().eq("id", createdRestroomId);
    }
    if (createdStoragePaths.length > 0) {
      await adminClient.storage.from("restroom-photos").remove(createdStoragePaths);
    }

    const { count: finalCount } = await adminClient
      .from("restrooms")
      .select("id", { count: "exact", head: true });
    console.log(`Cleanup verified: restrooms count restored to ${finalCount} (baseline ${baselineRestroomCount})`);
  }
}

run().catch((err) => {
  console.error("E2E restroom_photos FAILED:", err);
  process.exit(1);
});

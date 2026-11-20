import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

async function run() {
  const db = new PGlite();

  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE IF NOT EXISTS auth.users (
      id uuid PRIMARY KEY,
      email text UNIQUE,
      raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
      SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), current_setting('role', true), 'anon');
    $$;

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin; END IF;
    END $$;

    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;

    CREATE SCHEMA IF NOT EXISTS supabase_migrations;
    CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
      version text PRIMARY KEY,
      statements text[],
      name text
    );
  `);

  const migrationFiles = fs
    .readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of migrationFiles) {
    const ver = file.split("_")[0];
    const sql = fs.readFileSync(path.join(ROOT, "supabase/migrations", file), "utf8");
    await db.exec(sql);
    await db.query(
      `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ($1, $2)`,
      [ver, file]
    );
  }

  console.log(`Applied ${migrationFiles.length} migrations in PGlite.`);

  const adminId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ownerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const strangerId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const bizId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  // Seed admin, owner, stranger
  await db.exec(`
    INSERT INTO auth.users (id, email) VALUES
      ('${adminId}', 'admin@test.local'),
      ('${ownerId}', 'owner@test.local'),
      ('${strangerId}', 'stranger@test.local');
    INSERT INTO public.user_roles (user_id, role) VALUES ('${adminId}', 'admin');
  `);

  // Create & approve business
  await db.exec(`
    INSERT INTO public.businesses (
      id, name, category, road_address, latitude, longitude, registration_status, created_by, approved_by, approved_at
    ) VALUES (
      '${bizId}', 'DEMO 사진 테스트 카페', '카페', '경기도 수원시 팔달구 매산로 1', 37.2659, 127.0001,
      'approved', '${ownerId}', '${adminId}', now()
    );
    INSERT INTO public.business_members (business_id, user_id, role, membership_status)
    VALUES ('${bizId}', '${ownerId}', 'owner', 'active');
  `);

  // 1. Merchant creates draft restroom
  await db.exec(`
    BEGIN;
    SET LOCAL ROLE authenticated;
    SELECT set_config('request.jwt.claim.sub', '${ownerId}', true);
  `);
  const createRes = await db.query(`
    SELECT (public.create_merchant_restroom(
      '${bizId}'::uuid,
      '1층 제휴 화장실',
      '설명',
      '경기도 수원시 팔달구 매산로 1',
      null,
      37.2659,
      127.0001,
      '1층',
      null,
      'separate',
      true,
      false,
      false,
      'ask_staff',
      'free',
      0,
      false,
      null,
      0
    )).id AS restroom_id;
  `);
  const restroomId = createRes.rows[0].restroom_id;
  await db.exec(`COMMIT;`);

  // 2. Stranger cannot register photo (403)
  const strangerAttempt = await db.query(`
    SELECT public.register_merchant_restroom_photo(
      '${restroomId}'::uuid,
      '${strangerId}'::uuid,
      'restrooms/${restroomId}/stranger.jpg',
      'entrance',
      true,
      null
    ) AS res;
  `);
  assert.equal(strangerAttempt.rows[0].res.ok, false);
  assert.equal(strangerAttempt.rows[0].res.status, 403);

  // 3. Owner attaches 3 pending photos (max 3), 4th blocked
  const p1 = (
    await db.query(`
      SELECT public.register_merchant_restroom_photo(
        '${restroomId}'::uuid, '${ownerId}'::uuid,
        'restrooms/${restroomId}/p1.jpg', 'exterior', true, null
      ) AS res;
    `)
  ).rows[0].res;
  assert.equal(p1.ok, true);
  assert.equal(p1.photo.is_primary, true);
  assert.equal(p1.photo.moderation_status, "pending");

  const p2 = (
    await db.query(`
      SELECT public.register_merchant_restroom_photo(
        '${restroomId}'::uuid, '${ownerId}'::uuid,
        'restrooms/${restroomId}/p2.jpg', 'entrance', false, null
      ) AS res;
    `)
  ).rows[0].res;
  assert.equal(p2.ok, true);

  const p3 = (
    await db.query(`
      SELECT public.register_merchant_restroom_photo(
        '${restroomId}'::uuid, '${ownerId}'::uuid,
        'restrooms/${restroomId}/p3.jpg', 'interior', false, null
      ) AS res;
    `)
  ).rows[0].res;
  assert.equal(p3.ok, true);

  const p4 = (
    await db.query(`
      SELECT public.register_merchant_restroom_photo(
        '${restroomId}'::uuid, '${ownerId}'::uuid,
        'restrooms/${restroomId}/p4.jpg', 'signage', false, null
      ) AS res;
    `)
  ).rows[0].res;
  assert.equal(p4.ok, false);
  assert.equal(p4.error_code, "PHOTO_LIMIT_EXCEEDED");

  // Delete p3 while pending, then re-add p3b
  const delP3 = (
    await db.query(`
      SELECT public.delete_merchant_restroom_photo('${restroomId}'::uuid, '${p3.photo.id}'::uuid, '${ownerId}'::uuid) AS res;
    `)
  ).rows[0].res;
  assert.equal(delP3.ok, true);

  const p3b = (
    await db.query(`
      SELECT public.register_merchant_restroom_photo(
        '${restroomId}'::uuid, '${ownerId}'::uuid,
        'restrooms/${restroomId}/p3b.jpg', 'interior', false, null
      ) AS res;
    `)
  ).rows[0].res;
  assert.equal(p3b.ok, true);

  // Before approval, anon cannot see pending photos
  await db.exec(`BEGIN; SET LOCAL ROLE anon;`);
  const anonVisibleBefore = await db.query(
    `SELECT count(*)::int AS cnt FROM public.restroom_photos WHERE restroom_id = '${restroomId}';`
  );
  await db.exec(`COMMIT;`);
  assert.equal(anonVisibleBefore.rows[0].cnt, 0);

  // 4. Owner submits restroom for review -> admin clicks publish ONCE -> restroom + all 3 photos approved atomically!
  await db.exec(`
    BEGIN;
    SET LOCAL ROLE authenticated;
    SELECT set_config('request.jwt.claim.sub', '${ownerId}', true);
    SELECT public.submit_merchant_restroom_for_review('${restroomId}'::uuid);
    COMMIT;
  `);

  await db.exec(`
    BEGIN;
    SET LOCAL ROLE authenticated;
    SELECT set_config('request.jwt.claim.sub', '${adminId}', true);
    SELECT public.decide_restroom_review('${restroomId}'::uuid, 'publish', null, '통합 승인 테스트');
    COMMIT;
  `);

  const approvedAfterPublish = await db.query(
    `SELECT id, is_primary, moderation_status FROM public.restroom_photos WHERE restroom_id = '${restroomId}' ORDER BY created_at ASC;`
  );
  assert.equal(approvedAfterPublish.rows.length, 3);
  assert.ok(approvedAfterPublish.rows.every((r) => r.moderation_status === "approved"));
  assert.equal(approvedAfterPublish.rows.filter((r) => r.is_primary).length, 1);

  // 5. Post-approval photo replacement (A-plan):
  // Owner uploads replacement for primary photo p1 -> saved as pending, is_primary=false, p1 stays approved+primary!
  const rep1 = (
    await db.query(`
      SELECT public.register_merchant_restroom_photo(
        '${restroomId}'::uuid, '${ownerId}'::uuid,
        'restrooms/${restroomId}/p1_new.jpg', 'exterior', false, '${p1.photo.id}'::uuid
      ) AS res;
    `)
  ).rows[0].res;
  assert.equal(rep1.ok, true);
  assert.equal(rep1.photo.moderation_status, "pending");
  assert.equal(rep1.photo.is_primary, false);
  assert.equal(rep1.photo.replaces_photo_id, p1.photo.id);

  // Anon still sees p1 as approved primary (3 approved total, 0 pending exposed)
  await db.exec(`BEGIN; SET LOCAL ROLE anon;`);
  const anonDuringPending = await db.query(
    `SELECT id, is_primary FROM public.restroom_photos WHERE restroom_id = '${restroomId}';`
  );
  await db.exec(`COMMIT;`);
  assert.equal(anonDuringPending.rows.length, 3);
  assert.equal(anonDuringPending.rows.find((r) => r.id === p1.photo.id)?.is_primary, true);

  // 6. Admin rejects rep1 -> p1 stays approved + primary!
  await db.exec(`
    BEGIN;
    SET LOCAL ROLE authenticated;
    SELECT set_config('request.jwt.claim.sub', '${adminId}', true);
    SELECT public.decide_restroom_photo_replacement('${rep1.photo.id}'::uuid, 'reject', '사진이 흐립니다');
    COMMIT;
  `);

  const afterReject = await db.query(
    `SELECT id, is_primary, moderation_status FROM public.restroom_photos WHERE id IN ('${p1.photo.id}', '${rep1.photo.id}');`
  );
  const oldAfterReject = afterReject.rows.find((r) => r.id === p1.photo.id);
  const newAfterReject = afterReject.rows.find((r) => r.id === rep1.photo.id);
  assert.equal(oldAfterReject.moderation_status, "approved");
  assert.equal(oldAfterReject.is_primary, true);
  assert.equal(newAfterReject.moderation_status, "rejected");

  // 7. Owner uploads rep2 -> Admin approves replacement -> p1 retired(rejected, is_primary=false), rep2 becomes approved + primary!
  const rep2 = (
    await db.query(`
      SELECT public.register_merchant_restroom_photo(
        '${restroomId}'::uuid, '${ownerId}'::uuid,
        'restrooms/${restroomId}/p1_new2.jpg', 'exterior', false, '${p1.photo.id}'::uuid
      ) AS res;
    `)
  ).rows[0].res;
  assert.equal(rep2.ok, true);

  await db.exec(`
    BEGIN;
    SET LOCAL ROLE authenticated;
    SELECT set_config('request.jwt.claim.sub', '${adminId}', true);
    SELECT public.decide_restroom_photo_replacement('${rep2.photo.id}'::uuid, 'approve', '선명한 외관 확인');
    COMMIT;
  `);

  const afterApprove = await db.query(
    `SELECT id, is_primary, moderation_status, replaces_photo_id FROM public.restroom_photos WHERE id IN ('${p1.photo.id}', '${rep2.photo.id}');`
  );
  const oldAfterApprove = afterApprove.rows.find((r) => r.id === p1.photo.id);
  const newAfterApprove = afterApprove.rows.find((r) => r.id === rep2.photo.id);
  assert.equal(oldAfterApprove.moderation_status, "rejected");
  assert.equal(oldAfterApprove.is_primary, false);
  assert.equal(newAfterApprove.moderation_status, "approved");
  assert.equal(newAfterApprove.is_primary, true);
  assert.equal(newAfterApprove.replaces_photo_id, null);

  // Verify audit logs recorded
  const audits = await db.query(
    `SELECT action, count(*)::int AS cnt FROM public.audit_logs GROUP BY action ORDER BY action;`
  );
  const auditMap = Object.fromEntries(audits.rows.map((r) => [r.action, r.cnt]));
  assert.equal(auditMap.restroom_published, 1);
  assert.equal(auditMap.photo_approved, 3);
  assert.equal(auditMap.photo_rejected, 1);
  assert.equal(auditMap.photo_replaced_out, 1);
  assert.equal(auditMap.photo_replacement_approved, 1);

  console.log("ALL PGlite restroom_photos integration checks PASSED!");
}

run().catch((err) => {
  console.error("PGlite restroom_photos integration test FAILED:", err);
  process.exit(1);
});

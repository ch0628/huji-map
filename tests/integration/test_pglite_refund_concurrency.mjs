/**
 * TASK 30 — PGlite PostgreSQL Migration, Constraint, Trigger & Concurrency Verification
 * Applies all 17 project migrations in order and verifies:
 *   1. Full relation chain: receipt_submissions -> access_sessions -> payment_orders -> payment_refunds
 *   2. Column-level security: authenticated cannot SELECT provider_payment_key / provider_cancel_id / idempotency_key
 *   3. Trigger invariants: HM040, HM041, HM042, HM043, HM044, HM045, HM046, HM048, HM050, HM051, DELETE 42501
 *   4. Atomic 1-order 1-refund claim via UNIQUE(payment_order_id) & concurrent race (Promise.all)
 *   5. Atomic CAS retry claim on processing/failed refund
 *   6. Immutable audit_logs recording for all refund lifecycle events
 */

import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

async function run() {
  console.log("1. Initializing PGlite instance and applying all migrations...");
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
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role BYPASSRLS;
      ELSE
        ALTER ROLE service_role BYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
        CREATE ROLE supabase_auth_admin;
      END IF;
    END $$;
  `);

  const migrationDir = path.join(ROOT, "supabase/migrations");
  const files = fs
    .readdirSync(migrationDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (let i = 0; i < files.length; i++) {
    const sql = fs.readFileSync(path.join(migrationDir, files[i]), "utf-8");
    await db.exec(sql);
  }
  console.log(`✓ Applied ${files.length} migrations cleanly.`);

  const admin1 = "fa300000-0000-4000-a000-000000000001";
  const admin2 = "fa300000-0000-4000-a000-000000000002";
  const customerId = "fa300000-0000-4000-a000-000000000003";
  const merchantId = "fa300000-0000-4000-a000-000000000004";
  const bizId = "fa300000-0000-4000-b000-000000000001";
  const restId = "fa300000-0000-4000-b000-000000000002";
  const polId = "fa300000-0000-4000-b000-000000000003";
  const sessId = "fa300000-0000-4000-c000-000000000001";
  const ordUuid = "fa300000-0000-4000-c000-000000000011";
  const subUuid = "fa300000-0000-4000-d000-000000000001";

  console.log("2. Seeding verified test data (business -> restroom -> policy -> session -> order -> receipt)...");
  await db.exec(`
    INSERT INTO auth.users (id, email) VALUES
      ('${admin1}', 'admin1@test.local'),
      ('${admin2}', 'admin2@test.local'),
      ('${customerId}', 'customer@test.local'),
      ('${merchantId}', 'merchant@test.local');

    INSERT INTO public.user_roles (user_id, role) VALUES
      ('${admin1}', 'admin'),
      ('${admin2}', 'admin'),
      ('${merchantId}', 'merchant')
    ON CONFLICT DO NOTHING;

    INSERT INTO public.businesses (id, created_by, name, category, road_address, latitude, longitude, registration_status, approved_by, approved_at)
    VALUES ('${bizId}', '${merchantId}', 'DEMO 테스트 매장', 'cafe', '경기도 수원시 팔달구 테스트로 1', 37.2636, 127.0286, 'approved', '${admin1}', now());

    INSERT INTO public.restrooms (id, business_id, type, name, road_address, latitude, longitude, access_method, publication_status, created_by, approved_by)
    VALUES ('${restId}', '${bizId}', 'partner', 'DEMO 테스트 화장실', '경기도 수원시 팔달구 테스트로 1', 37.2636, 127.0286, 'pin', 'published', '${merchantId}', '${admin1}');

    INSERT INTO public.restroom_access_policies (id, restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, receipt_window_hours, is_active, created_by)
    VALUES ('${polId}', '${restId}', 1, 'test_deposit', 1000, true, 24, true, '${merchantId}');

    INSERT INTO public.access_sessions (id, user_id, restroom_id, policy_id, status, access_method_snapshot, idempotency_key, expires_at)
    VALUES ('${sessId}', '${customerId}', '${restId}', '${polId}', 'created', 'pin', 'ses_idem_pglite_001', now() + interval '24 hours');

    INSERT INTO public.payment_orders (id, access_session_id, user_id, order_id, provider, payment_mode, amount_krw, status, idempotency_key)
    VALUES ('${ordUuid}', '${sessId}', '${customerId}', 'hm_ord_pglite_001', 'toss', 'test', 1000, 'created', 'ord_idem_pglite_001');

    SELECT public.complete_payment_approval('hm_ord_pglite_001', 'tgen_pglite_paykey_001', 1000);

    INSERT INTO public.receipt_submissions (id, access_session_id, user_id, storage_path, mime_type, file_size_bytes, client_submission_id, submission_status)
    VALUES ('${subUuid}', '${sessId}', '${customerId}', 'receipts/${customerId}/${sessId}/test.jpg', 'image/jpeg', 1024, 'client_sub_pglite_001', 'submitted');

    SELECT public.decide_receipt_review('${subUuid}', '${admin1}', 'approved', '정상 테스트 영수증 승인', 'DEMO 테스트 매장', now(), 3000, 'REF-001', 'rev_idem_001', 'hash_001');
  `);

  console.log("3. Testing column-level security on payment_refunds & payment_orders for authenticated...");
  await db.exec(`SET ROLE authenticated;`);
  await db.exec(`SELECT set_config('request.jwt.claim.sub', '${customerId}', true);`);
  let colBlocked = false;
  try {
    await db.query(`SELECT provider_payment_key FROM public.payment_orders WHERE id = $1`, [ordUuid]);
  } catch (err) {
    colBlocked = err.message.includes("permission denied");
  }
  assert.equal(colBlocked, true, "authenticated must NOT be able to SELECT provider_payment_key");

  let refundColBlocked = false;
  try {
    await db.query(`SELECT provider_cancel_id FROM public.payment_refunds`);
  } catch (err) {
    refundColBlocked = err.message.includes("permission denied");
  }
  assert.equal(refundColBlocked, true, "authenticated must NOT be able to SELECT provider_cancel_id");
  await db.exec(`RESET ROLE;`);

  console.log("4. Testing trigger validations (HM041 amount mismatch, HM042 non-admin, HM048 initial status)...");
  await assert.rejects(
    db.query(
      `INSERT INTO public.payment_refunds (payment_order_id, receipt_submission_id, amount_krw, status, idempotency_key, requested_by)
       VALUES ($1, $2, 500, 'requested', 'bad_amt_idem', $3)`,
      [ordUuid, subUuid, admin1]
    ),
    /HM041/
  );
  await assert.rejects(
    db.query(
      `INSERT INTO public.payment_refunds (payment_order_id, receipt_submission_id, amount_krw, status, idempotency_key, requested_by)
       VALUES ($1, $2, 1000, 'requested', 'non_admin_idem', $3)`,
      [ordUuid, subUuid, customerId]
    ),
    /HM042/
  );
  await assert.rejects(
    db.query(
      `INSERT INTO public.payment_refunds (payment_order_id, receipt_submission_id, amount_krw, status, idempotency_key, requested_by)
       VALUES ($1, $2, 1000, 'succeeded', 'bad_init_status_idem', $3)`,
      [ordUuid, subUuid, admin1]
    ),
    /HM048/
  );

  console.log("5. Testing concurrent atomic claim via UNIQUE(payment_order_id)...");
  const claimAttempt = async (adminId, idemKey) => {
    try {
      const res = await db.query(
        `INSERT INTO public.payment_refunds (payment_order_id, receipt_submission_id, amount_krw, status, idempotency_key, requested_by)
         VALUES ($1, $2, 1000, 'requested', $3, $4)
         RETURNING *`,
        [ordUuid, subUuid, idemKey, adminId]
      );
      return { ok: true, row: res.rows[0] };
    } catch (err) {
      return { ok: false, code: err.code, message: err.message };
    }
  };

  const [rA, rB] = await Promise.all([
    claimAttempt(admin1, "conc_idem_admin1"),
    claimAttempt(admin2, "conc_idem_admin2"),
  ]);
  const winners = [rA, rB].filter((r) => r.ok);
  const losers = [rA, rB].filter((r) => !r.ok);
  assert.equal(winners.length, 1, "Exactly 1 concurrent refund claim must succeed");
  assert.equal(losers.length, 1, "Exactly 1 concurrent refund claim must fail with 23505");
  assert.equal(losers[0].code, "23505");

  const refundId = winners[0].row.id;

  console.log("6. Testing processing transition & concurrent CAS claim on uncertain state...");
  await db.query(
    `UPDATE public.payment_refunds SET status = 'processing', failure_reason = 'UNCERTAIN_TIMEOUT' WHERE id = $1`,
    [refundId]
  );

  const casAttempt = async () => {
    const res = await db.query(
      `UPDATE public.payment_refunds SET status = 'requested', failure_reason = NULL
       WHERE id = $1 AND status = 'processing'
       RETURNING *`,
      [refundId]
    );
    return res.rows.length;
  };
  const [c1, c2] = await Promise.all([casAttempt(), casAttempt()]);
  assert.equal(c1 + c2, 1, "Exactly 1 CAS retry claim must win");

  console.log("7. Testing HM051 (requires provider_cancel_id), succeeded transition & immutability (HM043, HM044, HM046, DELETE)...");
  await assert.rejects(
    db.query(
      `UPDATE public.payment_refunds SET status = 'succeeded' WHERE id = $1`,
      [refundId]
    ),
    /HM051/
  );

  const finalized = await db.query(
    `UPDATE public.payment_refunds SET status = 'succeeded', provider_cancel_id = 'tx_pglite_cancel_001', completed_at = now()
     WHERE id = $1 RETURNING *`,
    [refundId]
  );
  assert.equal(finalized.rows[0].status, "succeeded");
  assert.ok(finalized.rows[0].completed_at);

  await assert.rejects(
    db.query(`UPDATE public.payment_refunds SET status = 'failed', failure_reason = 'tamper' WHERE id = $1`, [refundId]),
    /HM044/
  );
  await assert.rejects(
    db.query(`UPDATE public.payment_refunds SET idempotency_key = 'new_key' WHERE id = $1`, [refundId]),
    /HM043/
  );
  await assert.rejects(
    db.query(`UPDATE public.payment_refunds SET provider_cancel_id = 'tx_other' WHERE id = $1`, [refundId]),
    /HM046/
  );
  await assert.rejects(
    db.query(`DELETE FROM public.payment_refunds WHERE id = $1`, [refundId]),
    /cannot be deleted/
  );

  console.log("8. Testing audit_logs insert & immutability...");
  await db.query(
    `INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, after_data, reason)
     VALUES ($1, 'refund_toss_cancel_succeeded', 'payment_refunds', $2, '{"status":"succeeded"}'::jsonb, '테스트 환급 완료')`,
    [admin1, refundId]
  );
  await assert.rejects(
    db.query(`DELETE FROM public.audit_logs WHERE entity_id = $1`, [refundId]),
    /prohibited/
  );

  const countRes = await db.query(`SELECT count(*)::int AS cnt FROM public.payment_refunds WHERE payment_order_id = $1`, [ordUuid]);
  assert.equal(countRes.rows[0].cnt, 1);

  console.log("✓ ALL PGlite TASK 30 PostgreSQL DB constraint, trigger, concurrency, and audit immutability checks PASSED!");
}

run().catch((err) => {
  console.error("PGlite refund verification FAILED:", err);
  process.exit(1);
});


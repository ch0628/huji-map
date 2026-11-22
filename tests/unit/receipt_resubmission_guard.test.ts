import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

describe("TASK-02 B — Receipt State Transitions & Resubmission Guard (PGlite)", () => {
  let db: PGlite;

  const custId = "f3600000-0000-4000-8000-000000000001";
  const merchId = "f3600000-0000-4000-8000-000000000002";
  const adminId = "f3600000-0000-4000-8000-000000000003";
  const bizId = "f3600000-0000-4000-8000-000000000010";
  const restId = "f3600000-0000-4000-8000-000000000020";
  const polId = "f3600000-0000-4000-8000-000000000030";
  const sessResubmitId = "f3600000-0000-4000-8000-000000000041";
  const sessRejectId = "f3600000-0000-4000-8000-000000000042";
  const ord1Id = "f3600000-0000-4000-8000-000000000051";
  const ord2Id = "f3600000-0000-4000-8000-000000000052";

  beforeAll(async () => {
    db = new PGlite();

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
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role BYPASSRLS; ELSE ALTER ROLE service_role BYPASSRLS; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin; END IF;
      END $$;
    `);

    const migrationDir = path.join(process.cwd(), "supabase/migrations");
    const files = fs
      .readdirSync(migrationDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationDir, file), "utf-8");
      await db.exec(sql);
    }

    await db.exec(`
      INSERT INTO auth.users (id, email, raw_user_meta_data)
      VALUES
        ('${custId}', 'cust_guard@test.local', '{"display_name":"고객"}'::jsonb),
        ('${merchId}', 'merch_guard@test.local', '{"display_name":"점주"}'::jsonb),
        ('${adminId}', 'admin_guard@test.local', '{"display_name":"관리자"}'::jsonb);

      INSERT INTO public.user_roles (user_id, role)
      VALUES
        ('${merchId}', 'merchant'),
        ('${adminId}', 'admin')
      ON CONFLICT DO NOTHING;

      INSERT INTO public.businesses (
        id, name, category, road_address, latitude, longitude,
        registration_status, created_by, approved_at
      ) VALUES (
        '${bizId}', '가드테스트카페', '카페', '경기 수원시 팔달구 매산로 1',
        37.2661, 127.0011, 'approved', '${merchId}', now()
      );

      INSERT INTO public.business_members (business_id, user_id, role, membership_status)
      VALUES ('${bizId}', '${merchId}', 'owner', 'active');

      INSERT INTO public.restrooms (
        id, business_id, name, type, access_method,
        road_address, latitude, longitude, publication_status
      ) VALUES (
        '${restId}', '${bizId}', '가드화장실', 'partner', 'pin',
        '경기 수원시 팔달구 매산로 1', 37.2661, 127.0011, 'published'
      );

      INSERT INTO public.restroom_access_policies (
        id, restroom_id, version, access_mode, deposit_amount_krw,
        refund_eligible, receipt_window_hours, is_active, effective_from, created_by
      ) VALUES (
        '${polId}', '${restId}', 1, 'test_deposit', 1000,
        true, 24, true, now() - interval '1 hour', '${merchId}'
      );

      -- Session 1 (for resubmission_requested -> new submit -> approved)
      INSERT INTO public.access_sessions (
        id, user_id, restroom_id, policy_id, status, access_method_snapshot,
        idempotency_key, expires_at
      ) VALUES (
        '${sessResubmitId}', '${custId}', '${restId}', '${polId}', 'created', 'pin',
        'idem_guard_s1', now() + interval '1 hour'
      );
      INSERT INTO public.payment_orders (
        id, access_session_id, user_id, order_id, provider, payment_mode,
        amount_krw, status, idempotency_key
      ) VALUES (
        '${ord1Id}', '${sessResubmitId}', '${custId}', 'ord_guard_1', 'toss', 'test',
        1000, 'created', 'idem_guard_o1'
      );
      UPDATE public.payment_orders
      SET status = 'approved', provider_payment_key = 'pk_guard_1', approved_at = now() - interval '10 minutes'
      WHERE id = '${ord1Id}';
      UPDATE public.access_sessions
      SET status = 'authorized', authorized_at = now() - interval '10 minutes'
      WHERE id = '${sessResubmitId}';

      -- Session 2 (for rejected -> permanently blocked)
      INSERT INTO public.access_sessions (
        id, user_id, restroom_id, policy_id, status, access_method_snapshot,
        idempotency_key, expires_at
      ) VALUES (
        '${sessRejectId}', '${custId}', '${restId}', '${polId}', 'created', 'pin',
        'idem_guard_s2', now() + interval '1 hour'
      );
      INSERT INTO public.payment_orders (
        id, access_session_id, user_id, order_id, provider, payment_mode,
        amount_krw, status, idempotency_key
      ) VALUES (
        '${ord2Id}', '${sessRejectId}', '${custId}', 'ord_guard_2', 'toss', 'test',
        1000, 'created', 'idem_guard_o2'
      );
      UPDATE public.payment_orders
      SET status = 'approved', provider_payment_key = 'pk_guard_2', approved_at = now() - interval '10 minutes'
      WHERE id = '${ord2Id}';
      UPDATE public.access_sessions
      SET status = 'authorized', authorized_at = now() - interval '10 minutes'
      WHERE id = '${sessRejectId}';
    `);
  }, 30000);

  afterAll(async () => {
    if (db) await db.close();
  });

  it("blocks duplicate submission while under review, allows only after resubmission_requested, blocks after approved, and preserves history", async () => {
    // 1. Submit initial receipt -> submitted
    const sub1Res: any = await db.query(
      `SELECT public.submit_customer_receipt($1, $2, $3, 'image/jpeg', 1024, 'r1.jpg', 'client_sub_001') AS res`,
      [sessResubmitId, custId, `receipts/${custId}/${sessResubmitId}/1.jpg`]
    );
    const sub1 = sub1Res.rows[0].res;
    expect(sub1.ok).toBe(true);
    expect(sub1.receipt.submission_status).toBe("submitted");

    // 2. Concurrent/duplicate submission while 'submitted' -> blocked 409 RECEIPT_UNDER_REVIEW
    const dupIntentRes: any = await db.query(
      `SELECT public.validate_receipt_upload_intent($1, $2, 1024, 'image/jpeg') AS res`,
      [sessResubmitId, custId]
    );
    expect(dupIntentRes.rows[0].res.ok).toBe(false);
    expect(dupIntentRes.rows[0].res.error_code).toBe("RECEIPT_UNDER_REVIEW");
    expect(dupIntentRes.rows[0].res.status).toBe(409);

    const dupSubmitRes: any = await db.query(
      `SELECT public.submit_customer_receipt($1, $2, $3, 'image/jpeg', 1024, 'r2.jpg', 'client_sub_002') AS res`,
      [sessResubmitId, custId, `receipts/${custId}/${sessResubmitId}/2.jpg`]
    );
    expect(dupSubmitRes.rows[0].res.ok).toBe(false);
    expect(dupSubmitRes.rows[0].res.error_code).toBe("RECEIPT_UNDER_REVIEW");

    // 3. Admin marks resubmission_requested
    const reviewRes: any = await db.query(
      `SELECT public.decide_receipt_review($1::uuid, $2::uuid, 'resubmission_requested', '금액이 흐립니다', NULL, NULL, NULL, NULL, 'idem-rev-1', 'hash-rev-1') AS res`,
      [sub1.receipt.id, adminId]
    );
    expect(reviewRes.rows[0].res.ok).toBe(true);

    // 4. Now resubmission intent & submit succeed
    const resubmitIntent: any = await db.query(
      `SELECT public.validate_receipt_upload_intent($1, $2, 2048, 'image/png') AS res`,
      [sessResubmitId, custId]
    );
    expect(resubmitIntent.rows[0].res.ok).toBe(true);

    const sub2Res: any = await db.query(
      `SELECT public.submit_customer_receipt($1, $2, $3, 'image/png', 2048, 'r3.png', 'client_sub_003') AS res`,
      [sessResubmitId, custId, `receipts/${custId}/${sessResubmitId}/3.png`]
    );
    const sub2 = sub2Res.rows[0].res;
    expect(sub2.ok).toBe(true);
    expect(sub2.receipt.submission_status).toBe("submitted");

    // 5. While sub2 is under review, duplicate attempt is blocked again
    const underReviewAgain: any = await db.query(
      `SELECT public.validate_receipt_upload_intent($1, $2, 2048, 'image/png') AS res`,
      [sessResubmitId, custId]
    );
    expect(underReviewAgain.rows[0].res.ok).toBe(false);
    expect(underReviewAgain.rows[0].res.error_code).toBe("RECEIPT_UNDER_REVIEW");

    // 6. Admin approves sub2 -> future uploads blocked with RECEIPT_ALREADY_APPROVED
    await db.query(
      `SELECT public.decide_receipt_review($1::uuid, $2::uuid, 'approved', '정상 확인 완료', NULL, NULL, NULL, NULL, 'idem-rev-2', 'hash-rev-2') AS res`,
      [sub2.receipt.id, adminId]
    );
    const afterApproveIntent: any = await db.query(
      `SELECT public.validate_receipt_upload_intent($1, $2, 1024, 'image/jpeg') AS res`,
      [sessResubmitId, custId]
    );
    expect(afterApproveIntent.rows[0].res.ok).toBe(false);
    expect(afterApproveIntent.rows[0].res.error_code).toBe("RECEIPT_ALREADY_APPROVED");

    // 7. Existing submissions & review audits are preserved (not deleted)
    const countRes: any = await db.query(
      `SELECT count(*)::int AS cnt FROM public.receipt_submissions WHERE access_session_id = $1`,
      [sessResubmitId]
    );
    expect(countRes.rows[0].cnt).toBe(2);
    const auditCount: any = await db.query(
      `SELECT count(*)::int AS cnt FROM public.receipt_review_audits WHERE submission_id IN ($1, $2)`,
      [sub1.receipt.id, sub2.receipt.id]
    );
    expect(auditCount.rows[0].cnt).toBe(2);
  });

  it("blocks upload intent and submission once the latest receipt has been rejected", async () => {
    const subRes: any = await db.query(
      `SELECT public.submit_customer_receipt($1, $2, $3, 'image/jpeg', 1024, 'rej.jpg', 'client_sub_rej_001') AS res`,
      [sessRejectId, custId, `receipts/${custId}/${sessRejectId}/1.jpg`]
    );
    const sub = subRes.rows[0].res;
    expect(sub.ok).toBe(true);

    await db.query(
      `SELECT public.decide_receipt_review($1::uuid, $2::uuid, 'rejected', '타 매장 영수증입니다', NULL, NULL, NULL, NULL, 'idem-rev-3', 'hash-rev-3') AS res`,
      [sub.receipt.id, adminId]
    );

    const intentAfterReject: any = await db.query(
      `SELECT public.validate_receipt_upload_intent($1, $2, 1024, 'image/jpeg') AS res`,
      [sessRejectId, custId]
    );
    expect(intentAfterReject.rows[0].res.ok).toBe(false);
    expect(intentAfterReject.rows[0].res.error_code).toBe("RECEIPT_REJECTED");
    expect(intentAfterReject.rows[0].res.status).toBe(409);

    const submitAfterReject: any = await db.query(
      `SELECT public.submit_customer_receipt($1, $2, $3, 'image/jpeg', 1024, 'rej2.jpg', 'client_sub_rej_002') AS res`,
      [sessRejectId, custId, `receipts/${custId}/${sessRejectId}/2.jpg`]
    );
    expect(submitAfterReject.rows[0].res.ok).toBe(false);
    expect(submitAfterReject.rows[0].res.error_code).toBe("RECEIPT_REJECTED");
  });
});

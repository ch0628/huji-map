/**
 * TASK 28 — Real PostgreSQL 17.11 Multi-Connection Concurrency, Idempotency & Security Verification
 * for Administrator Receipt Review Backend API & RPC `decide_receipt_review`
 *
 * Verifies Scenarios 1 ~ 5 on Local PostgreSQL 17.11 (127.0.0.1:54322) across 2 independent TCP connections:
 *   - Scenario 1: Same receipt concurrent approval across Conn-A & Conn-B
 *                 -> Exactly 1 succeeds, 1 rejected with 409 HM002, exactly 1 audit record.
 *   - Scenario 2: Same receipt concurrent approval vs rejection across Conn-A & Conn-B
 *                 -> Exactly 1 succeeds, 1 rejected with 409 conflict, exactly 1 audit record.
 *   - Scenario 3: Same receipt concurrent requests with same idempotency key across Conn-A & Conn-B
 *                 -> 1 creates (reused: false), 1 replays (reused: true), exactly 1 audit record;
 *                    conflicting payload hash fails with 23505 HM094.
 *   - Scenario 4: Different receipts independent reviews across Conn-A & Conn-B
 *                 -> Both succeed independently with isolated audit records and states.
 *   - Scenario 5: Review failure rollback verification
 *                 -> Status remains 'submitted', 0 residual audit rows, 0 payment_refunds.
 *   - Cleanup & Residual Check: 0 residual test rows across all affected tables.
 */

import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

class PgWireClient {
  constructor({
    host = "127.0.0.1",
    port = 54322,
    user = "postgres",
    password = "postgres",
    database = "postgres",
    name = "pg",
  } = {}) {
    this.host = host;
    this.port = port;
    this.user = user;
    this.password = password;
    this.database = database;
    this.name = name;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.connected = false;
    this.scramState = null;
    this.currentAction = null;
    this.notices = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(
        { host: this.host, port: this.port },
        () => {
          this._sendStartupMessage();
        }
      );

      this.currentAction = {
        type: "connect",
        resolve: () => {
          this.connected = true;
          resolve();
        },
        reject,
      };

      this.socket.on("data", (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this._processBuffer();
      });

      this.socket.on("error", (err) => {
        if (this.currentAction) {
          const action = this.currentAction;
          this.currentAction = null;
          action.reject(err);
        }
      });

      this.socket.on("close", () => {
        this.connected = false;
        if (this.currentAction) {
          const action = this.currentAction;
          this.currentAction = null;
          action.reject(
            new Error(`[${this.name}] Connection closed unexpectedly`)
          );
        }
      });
    });
  }

  _sendStartupMessage() {
    const params = [
      "user",
      this.user,
      "database",
      this.database,
      "client_encoding",
      "UTF8",
    ];
    let len = 4 + 4; // length + protocol version (3.0)
    for (const p of params) {
      len += Buffer.byteLength(p, "utf8") + 1;
    }
    len += 1; // terminating null byte

    const buf = Buffer.alloc(len);
    buf.writeInt32BE(len, 0);
    buf.writeInt32BE(196608, 4); // 3.0 in high 16 and low 16 bits
    let offset = 8;
    for (const p of params) {
      const written = buf.write(p, offset, "utf8");
      offset += written;
      buf[offset] = 0;
      offset += 1;
    }
    buf[offset] = 0;
    this.socket.write(buf);
  }

  _processBuffer() {
    while (this.buffer.length >= 5) {
      const type = String.fromCharCode(this.buffer[0]);
      const len = this.buffer.readInt32BE(1);
      const totalLen = 1 + len;
      if (this.buffer.length < totalLen) {
        break;
      }
      const payload = this.buffer.subarray(5, totalLen);
      this.buffer = this.buffer.subarray(totalLen);
      this._handlePacket(type, payload);
    }
  }

  _sendPacket(type, payloadBuf = Buffer.alloc(0)) {
    const len = 4 + payloadBuf.length;
    const header = Buffer.alloc(5);
    header.write(type, 0, 1, "ascii");
    header.writeInt32BE(len, 1);
    this.socket.write(Buffer.concat([header, payloadBuf]));
  }

  _handlePacket(type, payload) {
    if (type === "R") {
      const authType = payload.readInt32BE(0);
      if (authType === 0) {
        // Auth OK
      } else if (authType === 3) {
        // Cleartext password
        const pwdBuf = Buffer.from(this.password + "\0", "utf8");
        this._sendPacket("p", pwdBuf);
      } else if (authType === 10) {
        // SASL SCRAM-SHA-256
        this._handleSaslAuth(authType, payload);
      } else if (authType === 11) {
        // SASL Continue
        this._handleSaslAuth(authType, payload);
      } else if (authType === 12) {
        // SASL Final
      }
    } else if (type === "Z") {
      // ReadyForQuery
      if (this.currentAction) {
        const action = this.currentAction;
        this.currentAction = null;
        if (action.type === "connect") {
          action.resolve();
        } else if (action.type === "query") {
          if (action.error) {
            action.reject(action.error);
          } else {
            action.resolve({
              rows: action.rows,
              fields: action.fields,
              commandTags: action.commandTags,
            });
          }
        }
      }
    } else if (type === "T") {
      // RowDescription
      if (this.currentAction && this.currentAction.type === "query") {
        this.currentAction.fields = this._parseRowDescription(payload);
      }
    } else if (type === "D") {
      // DataRow
      if (this.currentAction && this.currentAction.type === "query") {
        const row = this._parseDataRow(payload, this.currentAction.fields);
        this.currentAction.rows.push(row);
      }
    } else if (type === "C") {
      // CommandComplete
      const tag = payload.toString("utf8", 0, payload.length - 1);
      if (this.currentAction && this.currentAction.type === "query") {
        this.currentAction.commandTags.push(tag);
      }
    } else if (type === "E") {
      // ErrorResponse
      const errInfo = this._parseErrorOrNotice(payload);
      const err = new Error(
        `[${this.name}] ${errInfo.message || "Database error"} (code: ${
          errInfo.code
        })`
      );
      err.code = errInfo.code;
      err.detail = errInfo.detail;
      err.info = errInfo;
      if (this.currentAction) {
        this.currentAction.error = err;
      }
    } else if (type === "N") {
      // NoticeResponse
      const noticeInfo = this._parseErrorOrNotice(payload);
      this.notices.push(noticeInfo);
    }
  }

  _handleSaslAuth(authType, payload) {
    if (authType === 10) {
      const clientNonce = crypto.randomBytes(18).toString("base64");
      const clientFirstBare = `n=*,r=${clientNonce}`;
      const clientFirstMsg = `n,,${clientFirstBare}`;
      const mech = "SCRAM-SHA-256";
      const mechBuf = Buffer.from(mech + "\0", "utf8");
      const dataBuf = Buffer.from(clientFirstMsg, "utf8");
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeInt32BE(dataBuf.length, 0);
      this.scramState = { clientNonce, clientFirstBare };
      this._sendPacket("p", Buffer.concat([mechBuf, lenBuf, dataBuf]));
    } else if (authType === 11) {
      const serverFirst = payload.subarray(4).toString("utf8");
      const parts = Object.fromEntries(
        serverFirst.split(",").map((kv) => [kv.slice(0, 1), kv.slice(2)])
      );
      const serverNonce = parts.r;
      const salt = Buffer.from(parts.s, "base64");
      const iterations = parseInt(parts.i, 10);
      const clientFinalWithoutProof = `c=biws,r=${serverNonce}`;
      const saltedPassword = crypto.pbkdf2Sync(
        this.password,
        salt,
        iterations,
        32,
        "sha256"
      );
      const clientKey = crypto
        .createHmac("sha256", saltedPassword)
        .update("Client Key")
        .digest();
      const storedKey = crypto.createHash("sha256").update(clientKey).digest();
      const authMessage = `${this.scramState.clientFirstBare},${serverFirst},${clientFinalWithoutProof}`;
      const clientSignature = crypto
        .createHmac("sha256", storedKey)
        .update(authMessage)
        .digest();
      const clientProof = Buffer.alloc(clientKey.length);
      for (let i = 0; i < clientKey.length; i++) {
        clientProof[i] = clientKey[i] ^ clientSignature[i];
      }
      const clientFinal = `${clientFinalWithoutProof},p=${clientProof.toString(
        "base64"
      )}`;
      this._sendPacket("p", Buffer.from(clientFinal, "utf8"));
    }
  }

  _parseErrorOrNotice(payload) {
    const info = {};
    let offset = 0;
    while (offset < payload.length) {
      const fieldType = payload[offset];
      offset += 1;
      if (fieldType === 0) break;
      const endIdx = payload.indexOf(0, offset);
      const val = payload.toString("utf8", offset, endIdx);
      offset = endIdx + 1;
      if (fieldType === 83) info.severity = val;
      if (fieldType === 67) info.code = val;
      if (fieldType === 77) info.message = val;
      if (fieldType === 68) info.detail = val;
    }
    return info;
  }

  _parseRowDescription(payload) {
    const fieldCount = payload.readInt16BE(0);
    const fields = [];
    let offset = 2;
    for (let i = 0; i < fieldCount; i++) {
      const endIdx = payload.indexOf(0, offset);
      const name = payload.toString("utf8", offset, endIdx);
      offset = endIdx + 1;
      offset += 4 + 2 + 4 + 2 + 4 + 2;
      fields.push(name);
    }
    return fields;
  }

  _parseDataRow(payload, fields) {
    const colCount = payload.readInt16BE(0);
    let offset = 2;
    const row = {};
    for (let i = 0; i < colCount; i++) {
      const len = payload.readInt32BE(offset);
      offset += 4;
      if (len === -1) {
        row[fields[i] || `col_${i}`] = null;
      } else {
        const val = payload.toString("utf8", offset, offset + len);
        offset += len;
        row[fields[i] || `col_${i}`] = val;
      }
    }
    return row;
  }

  query(sql) {
    if (!this.connected) {
      return Promise.reject(new Error(`[${this.name}] Socket not connected`));
    }
    return new Promise((resolve, reject) => {
      this.currentAction = {
        type: "query",
        sql,
        rows: [],
        fields: [],
        commandTags: [],
        error: null,
        resolve,
        reject,
      };
      const sqlBuf = Buffer.from(sql + "\0", "utf8");
      this._sendPacket("Q", sqlBuf);
    });
  }

  close() {
    if (this.socket && !this.socket.destroyed) {
      this.socket.end();
    }
  }
}

function assert(cond, msg) {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
}

async function run() {
  console.log("=================================================================");
  console.log("TASK 28 — Real PostgreSQL 17.11 Receipt Review Concurrency Verification");
  console.log("=================================================================");

  const connAdmin = new PgWireClient({ name: "admin" });
  const connA = new PgWireClient({ name: "connA" });
  const connB = new PgWireClient({ name: "connB" });

  await connAdmin.connect();
  await connA.connect();
  await connB.connect();

  const prefix = "f28c";
  const adminId = `${prefix}0000-0000-4000-8000-000000000001`;
  const custId = `${prefix}0000-0000-4000-8000-000000000002`;
  const merchId = `${prefix}0000-0000-4000-8000-000000000003`;
  const bizId = `${prefix}0000-0000-4000-8000-000000000010`;
  const restId = `${prefix}0000-0000-4000-8000-000000000020`;
  const polId = `${prefix}0000-0000-4000-8000-000000000030`;

  async function cleanupFixtures() {
    await connAdmin.query(`
      ALTER TABLE public.receipt_submissions DISABLE TRIGGER USER;
      ALTER TABLE public.receipt_review_audits DISABLE TRIGGER USER;
      ALTER TABLE public.audit_logs DISABLE TRIGGER USER;
      ALTER TABLE public.payment_refunds DISABLE TRIGGER USER;
      ALTER TABLE public.payment_orders DISABLE TRIGGER USER;
      ALTER TABLE public.access_sessions DISABLE TRIGGER USER;
      ALTER TABLE public.restroom_access_policies DISABLE TRIGGER USER;
      ALTER TABLE public.restrooms DISABLE TRIGGER USER;
      ALTER TABLE public.business_members DISABLE TRIGGER USER;
      ALTER TABLE public.businesses DISABLE TRIGGER USER;
      ALTER TABLE public.user_roles DISABLE TRIGGER USER;
      ALTER TABLE public.profiles DISABLE TRIGGER USER;

      DELETE FROM public.audit_logs WHERE entity_id::text LIKE '${prefix}%' OR actor_user_id::text LIKE '${prefix}%';
      DELETE FROM public.receipt_review_audits WHERE submission_id IN (
        SELECT id FROM public.receipt_submissions WHERE access_session_id::text LIKE '${prefix}%'
      );
      DELETE FROM public.receipt_submissions WHERE access_session_id::text LIKE '${prefix}%' OR user_id::text LIKE '${prefix}%';
      DELETE FROM public.payment_refunds WHERE payment_order_id IN (
        SELECT id FROM public.payment_orders WHERE access_session_id::text LIKE '${prefix}%'
      );
      DELETE FROM public.payment_orders WHERE access_session_id::text LIKE '${prefix}%' OR user_id::text LIKE '${prefix}%';
      DELETE FROM public.access_sessions WHERE id::text LIKE '${prefix}%' OR user_id::text LIKE '${prefix}%';
      DELETE FROM public.restroom_access_policies WHERE id::text LIKE '${prefix}%' OR restroom_id::text LIKE '${prefix}%';
      DELETE FROM public.restrooms WHERE id::text LIKE '${prefix}%' OR business_id::text LIKE '${prefix}%';
      DELETE FROM public.business_members WHERE business_id::text LIKE '${prefix}%' OR user_id::text LIKE '${prefix}%';
      DELETE FROM public.businesses WHERE id::text LIKE '${prefix}%';
      DELETE FROM public.user_roles WHERE user_id::text LIKE '${prefix}%';
      DELETE FROM public.profiles WHERE id::text LIKE '${prefix}%';
      DELETE FROM auth.users WHERE id::text LIKE '${prefix}%';

      ALTER TABLE public.receipt_submissions ENABLE TRIGGER USER;
      ALTER TABLE public.receipt_review_audits ENABLE TRIGGER USER;
      ALTER TABLE public.audit_logs ENABLE TRIGGER USER;
      ALTER TABLE public.payment_refunds ENABLE TRIGGER USER;
      ALTER TABLE public.payment_orders ENABLE TRIGGER USER;
      ALTER TABLE public.access_sessions ENABLE TRIGGER USER;
      ALTER TABLE public.restroom_access_policies ENABLE TRIGGER USER;
      ALTER TABLE public.restrooms ENABLE TRIGGER USER;
      ALTER TABLE public.business_members ENABLE TRIGGER USER;
      ALTER TABLE public.businesses ENABLE TRIGGER USER;
      ALTER TABLE public.user_roles ENABLE TRIGGER USER;
      ALTER TABLE public.profiles ENABLE TRIGGER USER;
    `);
  }

  try {
    // 1. Verify PostgreSQL version and distinct backend PIDs
    const verRes = await connAdmin.query("SELECT version() AS ver");
    const pidARes = await connA.query("SELECT pg_backend_pid() AS pid");
    const pidBRes = await connB.query("SELECT pg_backend_pid() AS pid");
    const pidA = Number(pidARes.rows[0].pid);
    const pidB = Number(pidBRes.rows[0].pid);

    console.log(`[1] PostgreSQL Version: ${verRes.rows[0].ver}`);
    console.log(
      `[1] Independent Backend PIDs: Conn-A=${pidA}, Conn-B=${pidB} (distinct=${
        pidA !== pidB
      })`
    );
    assert(pidA !== pidB, "Conn-A and Conn-B must have distinct backend PIDs");

    // 2. Apply migrations 14, 15, 16, 17 if needed
    for (const migFile of [
      "20261118000000_receipt_backend.sql",
      "20261119000000_receipt_review_decision.sql",
      "20261119010000_receipt_review_idempotency.sql",
      "20261119020000_receipt_review_rpc_hardening.sql",
    ]) {
      const migPath = path.join(ROOT, "supabase/migrations", migFile);
      const migSql = fs.readFileSync(migPath, "utf8");
      await connAdmin.query(migSql);
      console.log(`[2] Applied migration: ${migFile}`);
    }

    // 3. Execute rollback verification SQL
    const verifyPath = path.join(
      ROOT,
      "tests/integration/sql/verify_receipt_review_rollback.sql"
    );
    const verifySql = fs.readFileSync(verifyPath, "utf8");
    const verifyRes = await connAdmin.query(verifySql);
    console.log(
      `[3] Verification SQL passed (tags: ${JSON.stringify(
        verifyRes.commandTags
      )})`
    );

    // 4. Seed test fixtures
    await cleanupFixtures();
    await connAdmin.query(`
      INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
      VALUES
        ('${adminId}', 'f28c_admin@test.local', '{"display_name":"관리자"}'::jsonb, now(), now()),
        ('${custId}', 'f28c_cust@test.local', '{"display_name":"고객"}'::jsonb, now(), now()),
        ('${merchId}', 'f28c_merch@test.local', '{"display_name":"점주"}'::jsonb, now(), now());

      INSERT INTO public.user_roles (user_id, role)
      VALUES
        ('${adminId}', 'admin'),
        ('${merchId}', 'merchant')
      ON CONFLICT DO NOTHING;

      INSERT INTO public.businesses (
        id, name, category, road_address, latitude, longitude,
        registration_status, created_by, approved_at
      ) VALUES (
        '${bizId}', 'DEMO-TASK28카페', '카페', '경기 수원시 팔달구 매산로 10',
        37.2661, 127.0011, 'approved', '${merchId}', now()
      );

      INSERT INTO public.business_members (business_id, user_id, role, membership_status)
      VALUES ('${bizId}', '${merchId}', 'owner', 'active');

      INSERT INTO public.restrooms (
        id, business_id, name, type, access_method,
        road_address, latitude, longitude, publication_status
      ) VALUES (
        '${restId}', '${bizId}', 'DEMO-TASK28화장실', 'partner', 'pin',
        '경기 수원시 팔달구 매산로 10', 37.2661, 127.0011, 'published'
      );

      INSERT INTO public.restroom_access_policies (
        id, restroom_id, version, access_mode, deposit_amount_krw,
        refund_eligible, receipt_window_hours, is_active, effective_from, created_by
      ) VALUES (
        '${polId}', '${restId}', 1, 'test_deposit', 1000,
        true, 24, true, now() - interval '2 hours', '${merchId}'
      );
    `);

    // Helper to create a submitted receipt fixture
    let sessCounter = 1;
    async function createReceiptFixture(subId) {
      const sessId = `${prefix}0000-0000-4000-8000-${String(sessCounter).padStart(12, "0")}`;
      const ordId = `${prefix}0000-0000-4000-9000-${String(sessCounter).padStart(12, "0")}`;
      sessCounter++;

      await connAdmin.query(`
        INSERT INTO public.access_sessions (
          id, user_id, restroom_id, policy_id, status, access_method_snapshot,
          idempotency_key, expires_at
        ) VALUES (
          '${sessId}', '${custId}', '${restId}', '${polId}', 'created', 'pin',
          '${sessId}_idem', now() + interval '1 hour'
        );

        INSERT INTO public.payment_orders (
          id, access_session_id, user_id, order_id, provider, payment_mode,
          amount_krw, status, idempotency_key
        ) VALUES (
          '${ordId}', '${sessId}', '${custId}', 'ord_${ordId}', 'toss', 'test',
          1000, 'created', 'ord_${ordId}_idem'
        );

        UPDATE public.payment_orders
        SET status = 'approved', provider_payment_key = 'pk_${ordId}', approved_at = now() - interval '1 hour'
        WHERE id = '${ordId}';

        UPDATE public.access_sessions
        SET status = 'authorized', authorized_at = now() - interval '1 hour'
        WHERE id = '${sessId}';

        INSERT INTO public.receipt_submissions (
          id, access_session_id, user_id, storage_path, mime_type, file_size_bytes,
          original_filename, client_submission_id, submission_status
        ) VALUES (
          '${subId}', '${sessId}', '${custId}',
          'receipts/${custId}/${sessId}/receipt.jpg', 'image/jpeg', 102400,
          'receipt.jpg', 'client_sub_${subId}', 'submitted'
        );
      `);
      return { sessId, ordId };
    }

    // =========================================================================
    // SCENARIO 1: 동일 영수증 동시 승인 (Conn-A vs Conn-B)
    // =========================================================================
    console.log("\n--- Scenario 1: Same receipt concurrent approval across Conn-A & Conn-B ---");
    const s1_subId = `${prefix}0000-0000-4000-a000-000000000001`;
    await createReceiptFixture(s1_subId);

    const s1_pA = connA.query(`
      SELECT public.decide_receipt_review(
        '${s1_subId}'::uuid,
        '${adminId}'::uuid,
        'approved',
        '동시 승인 Conn-A 심사 사유',
        'DEMO-TASK28카페',
        now() - interval '30 minutes',
        5000,
        'REF-S1-A',
        's1_idem_key_a',
        'hash_s1_a'
      ) as result;
    `);

    const s1_pB = connB.query(`
      SELECT public.decide_receipt_review(
        '${s1_subId}'::uuid,
        '${adminId}'::uuid,
        'approved',
        '동시 승인 Conn-B 심사 사유',
        'DEMO-TASK28카페',
        now() - interval '30 minutes',
        5000,
        'REF-S1-B',
        's1_idem_key_b',
        'hash_s1_b'
      ) as result;
    `);

    const s1_results = await Promise.allSettled([s1_pA, s1_pB]);
    const s1_fulfilled = s1_results.filter((r) => r.status === "fulfilled");
    const s1_rejected = s1_results.filter((r) => r.status === "rejected");

    console.log(`Scenario 1: fulfilled=${s1_fulfilled.length}, rejected=${s1_rejected.length}`);
    assert(s1_fulfilled.length === 1, "Scenario 1: Exactly 1 approval must succeed");
    assert(s1_rejected.length === 1, "Scenario 1: Exactly 1 approval must be rejected with 409 conflict");

    const s1_err = s1_rejected[0].reason.message;
    console.log(`Scenario 1: Conflict error message: ${s1_err}`);
    assert(s1_err.includes("ALREADY_APPROVED") || s1_err.includes("HM002"), "Must fail with ALREADY_APPROVED/HM002");

    // DB state check: status = 'approved', audit records = exactly 1
    const s1_subCheck = await connAdmin.query(`SELECT submission_status FROM public.receipt_submissions WHERE id = '${s1_subId}'`);
    assert(s1_subCheck.rows[0].submission_status === "approved", "Submission must be approved in DB");

    const s1_auditCheck = await connAdmin.query(`SELECT count(*)::int as cnt FROM public.receipt_review_audits WHERE submission_id = '${s1_subId}'`);
    assert(Number(s1_auditCheck.rows[0].cnt) === 1, `Exactly 1 audit row must exist in receipt_review_audits (found: ${s1_auditCheck.rows[0].cnt})`);
    console.log("✓ Scenario 1 PASSED: Exactly 1 approved, 1 conflict, exactly 1 audit record.");

    // =========================================================================
    // SCENARIO 2: 동일 영수증에 승인과 반려 동시 요청 (Conn-A 승인 vs Conn-B 반려)
    // =========================================================================
    console.log("\n--- Scenario 2: Same receipt concurrent approval vs rejection across Conn-A & Conn-B ---");
    const s2_subId = `${prefix}0000-0000-4000-a000-000000000002`;
    await createReceiptFixture(s2_subId);

    const s2_pApprove = connA.query(`
      SELECT public.decide_receipt_review(
        '${s2_subId}'::uuid,
        '${adminId}'::uuid,
        'approved',
        '승인 요청 사유',
        'DEMO-TASK28카페',
        now() - interval '20 minutes',
        6000,
        'REF-S2-APPR',
        's2_idem_appr',
        'hash_s2_appr'
      ) as result;
    `);

    const s2_pReject = connB.query(`
      SELECT public.decide_receipt_review(
        '${s2_subId}'::uuid,
        '${adminId}'::uuid,
        'rejected',
        '반려 요청 사유 (금액 불일치)',
        NULL,
        NULL,
        NULL,
        NULL,
        's2_idem_rej',
        'hash_s2_rej'
      ) as result;
    `);

    const s2_results = await Promise.allSettled([s2_pApprove, s2_pReject]);
    const s2_fulfilled = s2_results.filter((r) => r.status === "fulfilled");
    const s2_rejected = s2_results.filter((r) => r.status === "rejected");

    console.log(`Scenario 2: fulfilled=${s2_fulfilled.length}, rejected=${s2_rejected.length}`);
    assert(s2_fulfilled.length === 1, "Scenario 2: Exactly 1 decision must succeed");
    assert(s2_rejected.length === 1, "Scenario 2: Competing decision must be rejected with conflict");

    const s2_winnerResult = JSON.parse(s2_fulfilled[0].value.rows[0].result);
    const s2_winnerDecision = s2_winnerResult.receipt.submission_status;
    console.log(`Scenario 2: Winner decision: ${s2_winnerDecision}`);

    // DB state check: status matches winner, exactly 1 audit record
    const s2_subCheck = await connAdmin.query(`SELECT submission_status FROM public.receipt_submissions WHERE id = '${s2_subId}'`);
    assert(s2_subCheck.rows[0].submission_status === s2_winnerDecision, `Submission status must match winner (${s2_winnerDecision})`);

    const s2_auditCheck = await connAdmin.query(`SELECT count(*)::int as cnt, decision FROM public.receipt_review_audits WHERE submission_id = '${s2_subId}' GROUP BY decision`);
    assert(Number(s2_auditCheck.rows[0].cnt) === 1, `Exactly 1 audit row must exist in receipt_review_audits (found: ${s2_auditCheck.rows[0].cnt})`);
    assert(s2_auditCheck.rows[0].decision === s2_winnerDecision, "Audit log decision must match winner");
    console.log("✓ Scenario 2 PASSED: Exactly 1 decision won, 1 conflict, exactly 1 audit record.");

    // =========================================================================
    // SCENARIO 3: 동일 멱등키 동시 요청 (Conn-A vs Conn-B)
    // =========================================================================
    console.log("\n--- Scenario 3: Same receipt concurrent requests with same idempotency key ---");
    const s3_subId = `${prefix}0000-0000-4000-a000-000000000003`;
    await createReceiptFixture(s3_subId);

    const s3_idemKey = "s3_shared_idem_key_12345";
    const s3_payloadHash = "hash_s3_identical_payload";

    const s3_pA = connA.query(`
      SELECT public.decide_receipt_review(
        '${s3_subId}'::uuid,
        '${adminId}'::uuid,
        'approved',
        '동일 멱등키 요청 사유',
        'DEMO-TASK28카페',
        now() - interval '10 minutes',
        7000,
        'REF-S3',
        '${s3_idemKey}',
        '${s3_payloadHash}'
      ) as result;
    `);

    const s3_pB = connB.query(`
      SELECT public.decide_receipt_review(
        '${s3_subId}'::uuid,
        '${adminId}'::uuid,
        'approved',
        '동일 멱등키 요청 사유',
        'DEMO-TASK28카페',
        now() - interval '10 minutes',
        7000,
        'REF-S3',
        '${s3_idemKey}',
        '${s3_payloadHash}'
      ) as result;
    `);

    const s3_results = await Promise.allSettled([s3_pA, s3_pB]);
    const s3_fulfilled = s3_results.filter((r) => r.status === "fulfilled");
    const s3_rejected = s3_results.filter((r) => r.status === "rejected");

    console.log(`Scenario 3: fulfilled=${s3_fulfilled.length}, rejected=${s3_rejected.length}`);
    assert(s3_fulfilled.length === 2, "Scenario 3: Both requests must succeed (1 created + 1 replayed)");

    const s3_resA = JSON.parse(s3_fulfilled[0].value.rows[0].result);
    const s3_resB = JSON.parse(s3_fulfilled[1].value.rows[0].result);

    const s3_created = [s3_resA, s3_resB].find((r) => r.reused === false);
    const s3_replayed = [s3_resA, s3_resB].find((r) => r.reused === true);

    assert(Boolean(s3_created), "Scenario 3: Exactly 1 request must have reused: false (creator)");
    assert(Boolean(s3_replayed), "Scenario 3: Exactly 1 request must have reused: true (replayed)");

    // Audit logs must NOT have duplicates: exactly 1 row in receipt_review_audits
    const s3_auditCheck = await connAdmin.query(`SELECT count(*)::int as cnt, idempotency_key, payload_hash FROM public.receipt_review_audits WHERE submission_id = '${s3_subId}' GROUP BY idempotency_key, payload_hash`);
    assert(Number(s3_auditCheck.rows[0].cnt) === 1, `Exactly 1 audit row must exist in receipt_review_audits after replay (found: ${s3_auditCheck.rows[0].cnt})`);
    assert(s3_auditCheck.rows[0].idempotency_key === s3_idemKey, "Audit row must persist idempotency key");
    assert(s3_auditCheck.rows[0].payload_hash === s3_payloadHash, "Audit row must persist payload hash");

    // Conflicting request with same idempotency key but DIFFERENT payload hash must fail with 23505 HM094
    let s3_conflictCaught = false;
    try {
      await connA.query(`
        SELECT public.decide_receipt_review(
          '${s3_subId}'::uuid,
          '${adminId}'::uuid,
          'approved',
          '완전히 다른 변경된 사유',
          'DEMO-TASK28카페',
          now() - interval '10 minutes',
          7000,
          'REF-S3',
          '${s3_idemKey}',
          'hash_DIFFERENT_PAYLOAD'
        ) as result;
      `);
    } catch (err) {
      if (err.message.includes("HM094") || err.message.includes("23505") || err.code === "23505") {
        s3_conflictCaught = true;
        console.log(`Scenario 3: Conflict with different payload hash correctly caught: ${err.message}`);
      } else {
        throw err;
      }
    }
    assert(s3_conflictCaught, "Scenario 3: Replay with different payload hash must be rejected with 409 HM094 / 23505");
    console.log("✓ Scenario 3 PASSED: 1 created, 1 replayed (reused: true), 0 duplicate audit rows, payload conflict blocked.");

    // =========================================================================
    // SCENARIO 4: 서로 다른 영수증의 독립 심사 (Conn-A vs Conn-B)
    // =========================================================================
    console.log("\n--- Scenario 4: Different receipts independent reviews across Conn-A & Conn-B ---");
    const s4_subA = `${prefix}0000-0000-4000-a000-000000000004`;
    const s4_subB = `${prefix}0000-0000-4000-a000-000000000005`;
    await createReceiptFixture(s4_subA);
    await createReceiptFixture(s4_subB);

    const s4_pA = connA.query(`
      SELECT public.decide_receipt_review(
        '${s4_subA}'::uuid,
        '${adminId}'::uuid,
        'approved',
        '영수증 A 승인 사유',
        'DEMO-TASK28카페',
        now() - interval '5 minutes',
        8000,
        'REF-S4-A',
        's4_idem_a',
        'hash_s4_a'
      ) as result;
    `);

    const s4_pB = connB.query(`
      SELECT public.decide_receipt_review(
        '${s4_subB}'::uuid,
        '${adminId}'::uuid,
        'resubmission_requested',
        '영수증 B 사진 흐림으로 재제출 요청',
        NULL,
        NULL,
        NULL,
        NULL,
        's4_idem_b',
        'hash_s4_b'
      ) as result;
    `);

    const s4_results = await Promise.allSettled([s4_pA, s4_pB]);
    const s4_fulfilled = s4_results.filter((r) => r.status === "fulfilled");
    assert(s4_fulfilled.length === 2, "Scenario 4: Both independent reviews must succeed simultaneously");

    const s4_checkA = await connAdmin.query(`SELECT submission_status FROM public.receipt_submissions WHERE id = '${s4_subA}'`);
    const s4_checkB = await connAdmin.query(`SELECT submission_status FROM public.receipt_submissions WHERE id = '${s4_subB}'`);
    assert(s4_checkA.rows[0].submission_status === "approved", "Receipt A must be approved");
    assert(s4_checkB.rows[0].submission_status === "resubmission_requested", "Receipt B must be resubmission_requested");

    const s4_audits = await connAdmin.query(`SELECT submission_id, decision FROM public.receipt_review_audits WHERE submission_id IN ('${s4_subA}', '${s4_subB}') ORDER BY submission_id`);
    assert(s4_audits.rows.length === 2, "Scenario 4: Exactly 2 audit records must exist");
    console.log("✓ Scenario 4 PASSED: Both independent reviews completed in parallel with distinct final states.");

    // =========================================================================
    // SCENARIO 5: 심사 실패 시 상태 변경 및 감사로그 롤백
    // =========================================================================
    console.log("\n--- Scenario 5: Review failure rollback verification ---");
    const s5_subId = `${prefix}0000-0000-4000-a000-000000000006`;
    await createReceiptFixture(s5_subId);

    // Run within a transaction that raises an exception after calling decide_receipt_review
    let s5_errorCaught = false;
    try {
      await connA.query(`
        DO $$
        BEGIN
          PERFORM public.decide_receipt_review(
            '${s5_subId}'::uuid,
            '${adminId}'::uuid,
            'approved',
            '롤백 테스트 승인 시도',
            'DEMO-TASK28카페',
            now(),
            5000,
            'REF-S5',
            's5_idem_key',
            'hash_s5'
          );
          -- Force intentional failure to trigger transaction rollback
          RAISE EXCEPTION 'INTENTIONAL_ERROR_FOR_ROLLBACK' USING ERRCODE = 'P0001';
        END $$;
      `);
    } catch (err) {
      if (err.message.includes("INTENTIONAL_ERROR_FOR_ROLLBACK") || err.code === "P0001") {
        s5_errorCaught = true;
        console.log(`Scenario 5: Intentional error caught: ${err.message}`);
      } else {
        throw err;
      }
    }
    assert(s5_errorCaught, "Scenario 5: Intentional transaction error must occur");

    // Verify DB state: submission_status must remain 'submitted'
    const s5_subCheck = await connAdmin.query(`SELECT submission_status, reviewed_by, reviewed_at FROM public.receipt_submissions WHERE id = '${s5_subId}'`);
    assert(s5_subCheck.rows[0].submission_status === "submitted", `Scenario 5: submission_status must remain 'submitted' (found: ${s5_subCheck.rows[0].submission_status})`);
    assert(s5_subCheck.rows[0].reviewed_by === null, "Scenario 5: reviewed_by must be null after rollback");
    assert(s5_subCheck.rows[0].reviewed_at === null, "Scenario 5: reviewed_at must be null after rollback");

    // Verify 0 audit records in receipt_review_audits and audit_logs
    const s5_auditCheck = await connAdmin.query(`SELECT count(*)::int as cnt FROM public.receipt_review_audits WHERE submission_id = '${s5_subId}'`);
    assert(Number(s5_auditCheck.rows[0].cnt) === 0, `Scenario 5: receipt_review_audits must have 0 records (found: ${s5_auditCheck.rows[0].cnt})`);

    const s5_auditLogsCheck = await connAdmin.query(`SELECT count(*)::int as cnt FROM public.audit_logs WHERE entity_id = '${s5_subId}'`);
    assert(Number(s5_auditLogsCheck.rows[0].cnt) === 0, `Scenario 5: audit_logs must have 0 records (found: ${s5_auditLogsCheck.rows[0].cnt})`);

    // Invariant check: Verify NO payment_refunds were created across any scenario
    const refundCheck = await connAdmin.query(`
      SELECT count(*)::int as cnt FROM public.payment_refunds
      WHERE payment_order_id IN (
        SELECT id FROM public.payment_orders WHERE access_session_id::text LIKE '${prefix}%'
      )
    `);
    assert(Number(refundCheck.rows[0].cnt) === 0, "INVARIANT VIOLATION: payment_refunds must NOT be generated during review");

    console.log("✓ Scenario 5 PASSED: Transaction rollback maintained state integrity (0 residual audits, status=submitted, 0 refunds).");

    // =========================================================================
    // CLEANUP & FINAL RESIDUAL VERIFICATION
    // =========================================================================
    console.log("\n--- Cleanup and Final Residual Verification ---");
    await cleanupFixtures();

    const resCheck = await connAdmin.query(`
      SELECT
        (SELECT count(*) FROM public.receipt_submissions WHERE access_session_id::text LIKE '${prefix}%')::int as sub_cnt,
        (SELECT count(*) FROM public.receipt_review_audits WHERE submission_id IN (SELECT id FROM public.receipt_submissions WHERE access_session_id::text LIKE '${prefix}%'))::int as audit_cnt,
        (SELECT count(*) FROM public.payment_orders WHERE access_session_id::text LIKE '${prefix}%')::int as ord_cnt,
        (SELECT count(*) FROM public.access_sessions WHERE id::text LIKE '${prefix}%')::int as sess_cnt
    `);
    const { sub_cnt, audit_cnt, ord_cnt, sess_cnt } = resCheck.rows[0];
    console.log(`Residual records: submissions=${sub_cnt}, audits=${audit_cnt}, orders=${ord_cnt}, sessions=${sess_cnt}`);
    assert(
      Number(sub_cnt) === 0 &&
      Number(audit_cnt) === 0 &&
      Number(ord_cnt) === 0 &&
      Number(sess_cnt) === 0,
      "All test fixtures must be completely cleaned up with 0 residuals"
    );

    console.log("\n=================================================================");
    console.log("TASK 28 — ALL 5 CONCURRENCY & IDEMPOTENCY SCENARIOS PASSED ON REAL PG 17.11!");
    console.log("=================================================================");
  } finally {
    connAdmin.close();
    connA.close();
    connB.close();
  }
}

run().catch((err) => {
  console.error("FATAL ERROR IN REAL PG CONCURRENCY VERIFICATION:", err);
  process.exit(1);
});

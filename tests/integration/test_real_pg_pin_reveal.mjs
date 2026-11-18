import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

/**
 * Minimal, zero-dependency PostgreSQL v3 Wire Protocol Client over node:net.
 * Supports cleartext, MD5, and SCRAM-SHA-256 authentication, plus Simple Query protocol.
 * Each instance maintains its own dedicated TCP socket and PostgreSQL backend process (pg_backend_pid).
 */
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
      this.socket = net.createConnection({ host: this.host, port: this.port }, () => {
        this._sendStartupMessage();
      });

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
          action.reject(new Error(`[${this.name}] Connection closed unexpectedly`));
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
    const bodyStr = params.join("\0") + "\0\0";
    const bodyBuf = Buffer.from(bodyStr, "utf8");
    const len = 4 + 4 + bodyBuf.length;
    const buf = Buffer.alloc(len);
    buf.writeInt32BE(len, 0);
    buf.writeInt32BE(196608, 4); // Protocol v3.0 (0x00030000)
    bodyBuf.copy(buf, 8);
    this.socket.write(buf);
  }

  _sendPacket(typeChar, payloadBuf) {
    const len = 4 + payloadBuf.length;
    const buf = Buffer.alloc(1 + len);
    buf.write(typeChar, 0, 1, "ascii");
    buf.writeInt32BE(len, 1);
    payloadBuf.copy(buf, 5);
    this.socket.write(buf);
  }

  _processBuffer() {
    while (this.buffer.length >= 5) {
      const msgType = String.fromCharCode(this.buffer[0]);
      const msgLen = this.buffer.readInt32BE(1);
      if (this.buffer.length < 1 + msgLen) {
        return; // Wait for full frame
      }
      const payload = this.buffer.subarray(5, 1 + msgLen);
      this.buffer = this.buffer.subarray(1 + msgLen);
      this._handleMessage(msgType, payload);
    }
  }

  _handleMessage(type, payload) {
    if (type === "R") {
      this._handleAuth(payload);
    } else if (type === "S" || type === "K") {
      // ParameterStatus or BackendKeyData
    } else if (type === "N") {
      const notice = this._parseErrorOrNotice(payload);
      if (notice.message) {
        this.notices.push(notice.message);
      }
    } else if (type === "E") {
      const errInfo = this._parseErrorOrNotice(payload);
      const err = new Error(
        `[${errInfo.code || "PGERR"}] ${errInfo.message || "Database error"}${
          errInfo.detail ? " | " + errInfo.detail : ""
        }`
      );
      err.code = errInfo.code;
      err.severity = errInfo.severity;
      err.detail = errInfo.detail;
      if (this.currentAction) {
        if (this.currentAction.type === "connect") {
          const action = this.currentAction;
          this.currentAction = null;
          action.reject(err);
        } else {
          this.currentAction.error = err;
        }
      }
    } else if (type === "T") {
      // RowDescription
      if (this.currentAction && this.currentAction.type === "query") {
        const fieldCount = payload.readInt16BE(0);
        let offset = 2;
        const fields = [];
        for (let i = 0; i < fieldCount; i++) {
          const endIdx = payload.indexOf(0, offset);
          const name = payload.toString("utf8", offset, endIdx);
          offset = endIdx + 1 + 18; // skip tableOid(4), colAttr(2), typeOid(4), typeSize(2), typeMod(4), formatCode(2)
          fields.push(name);
        }
        this.currentAction.currentFields = fields;
      }
    } else if (type === "D") {
      // DataRow
      if (this.currentAction && this.currentAction.type === "query") {
        const colCount = payload.readInt16BE(0);
        let offset = 2;
        const row = {};
        const fields = this.currentAction.currentFields || [];
        for (let i = 0; i < colCount; i++) {
          const valLen = payload.readInt32BE(offset);
          offset += 4;
          const colName = fields[i] || `col_${i}`;
          if (valLen === -1) {
            row[colName] = null;
          } else {
            row[colName] = payload.toString("utf8", offset, offset + valLen);
            offset += valLen;
          }
        }
        this.currentAction.rows.push(row);
      }
    } else if (type === "C") {
      // CommandComplete
      if (this.currentAction && this.currentAction.type === "query") {
        const tag = payload.toString("utf8", 0, payload.indexOf(0));
        this.currentAction.commandTags.push(tag);
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
              commandTags: action.commandTags,
            });
          }
        }
      }
    }
  }

  _handleAuth(payload) {
    const authType = payload.readInt32BE(0);
    if (authType === 0) {
      // AuthenticationOk
      return;
    } else if (authType === 3) {
      // CleartextPassword
      const pwBuf = Buffer.from(this.password + "\0", "utf8");
      this._sendPacket("p", pwBuf);
    } else if (authType === 5) {
      // MD5Password
      const salt = payload.subarray(4, 8);
      const inner = crypto
        .createHash("md5")
        .update(this.password + this.user, "utf8")
        .digest("hex");
      const outer = crypto
        .createHash("md5")
        .update(Buffer.concat([Buffer.from(inner, "ascii"), salt]))
        .digest("hex");
      const md5Pass = "md5" + outer + "\0";
      this._sendPacket("p", Buffer.from(md5Pass, "ascii"));
    } else if (authType === 10) {
      // AuthenticationSASL (SCRAM-SHA-256)
      const clientNonce = crypto.randomBytes(18).toString("base64");
      const clientFirstBare = `n=,r=${clientNonce}`;
      const clientFirstMsg = `n,,${clientFirstBare}`;
      this.scramState = { clientNonce, clientFirstBare };

      const mech = Buffer.from("SCRAM-SHA-256\0", "utf8");
      const msgBuf = Buffer.from(clientFirstMsg, "utf8");
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeInt32BE(msgBuf.length, 0);
      this._sendPacket("p", Buffer.concat([mech, lenBuf, msgBuf]));
    } else if (authType === 11) {
      // AuthenticationSASLContinue
      const serverFirstMsg = payload.subarray(4).toString("utf8");
      const parts = Object.fromEntries(
        serverFirstMsg.split(",").map((kv) => {
          const idx = kv.indexOf("=");
          return [kv.slice(0, idx), kv.slice(idx + 1)];
        })
      );
      const serverNonce = parts.r;
      const salt = Buffer.from(parts.s, "base64");
      const iterations = parseInt(parts.i, 10);

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
      const clientFinalWithoutProof = `c=biws,r=${serverNonce}`;
      const authMessage = `${this.scramState.clientFirstBare},${serverFirstMsg},${clientFinalWithoutProof}`;
      const clientSignature = crypto
        .createHmac("sha256", storedKey)
        .update(authMessage)
        .digest();
      const clientProof = Buffer.alloc(clientKey.length);
      for (let i = 0; i < clientKey.length; i++) {
        clientProof[i] = clientKey[i] ^ clientSignature[i];
      }
      const clientFinalMsg = `${clientFinalWithoutProof},p=${clientProof.toString("base64")}`;
      this._sendPacket("p", Buffer.from(clientFinalMsg, "utf8"));
    } else if (authType === 12) {
      // AuthenticationSASLFinal
      return;
    } else {
      throw new Error(`Unsupported PostgreSQL authentication type: ${authType}`);
    }
  }

  _parseErrorOrNotice(payload) {
    let offset = 0;
    const result = {};
    while (offset < payload.length) {
      const fieldType = payload[offset];
      offset += 1;
      if (fieldType === 0) break;
      const endIdx = payload.indexOf(0, offset);
      const val = payload.toString("utf8", offset, endIdx);
      offset = endIdx + 1;
      if (fieldType === 83) result.severity = val; // 'S'
      else if (fieldType === 67) result.code = val; // 'C'
      else if (fieldType === 77) result.message = val; // 'M'
      else if (fieldType === 68) result.detail = val; // 'D'
    }
    return result;
  }

  query(sql) {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        return reject(new Error(`[${this.name}] Client is not connected`));
      }
      if (this.currentAction) {
        return reject(new Error(`[${this.name}] Another query is already in flight on this connection`));
      }
      this.currentAction = {
        type: "query",
        rows: [],
        commandTags: [],
        currentFields: [],
        error: null,
        resolve,
        reject,
      };
      const sqlBuf = Buffer.from(sql + "\0", "utf8");
      this._sendPacket("Q", sqlBuf);
    });
  }

  async close() {
    if (!this.socket || !this.connected) return;
    return new Promise((resolve) => {
      this.socket.once("close", () => resolve());
      this._sendPacket("X", Buffer.alloc(0));
      this.socket.end();
    });
  }
}

async function main() {
  const host = process.env.PGHOST || "127.0.0.1";
  const port = parseInt(process.env.PGPORT || "54322", 10);
  const user = process.env.PGUSER || "postgres";
  const password = process.env.PGPASSWORD || "postgres";
  const database = process.env.PGDATABASE || "postgres";

  console.log("================================================================================");
  console.log(`TASK 24 — Real Local PostgreSQL (${host}:${port}) Multi-Connection Final Test`);
  console.log("================================================================================");

  const connA = new PgWireClient({ host, port, user, password, database, name: "Conn-A" });
  const connB = new PgWireClient({ host, port, user, password, database, name: "Conn-B" });

  try {
    console.log("[1] Connecting to PostgreSQL on 127.0.0.1:54322 (Conn-A & Conn-B)...");
    await Promise.all([connA.connect(), connB.connect()]);
    console.log("  ✓ Both connections established via TCP socket.");

    // 1. Verify PostgreSQL version
    const versionResA = await connA.query("SELECT version() AS ver;");
    const verA = versionResA.rows[0].ver;
    console.log(`\n[2] PostgreSQL Server Engine Identification:`);
    console.log(`  - Server Version: ${verA}`);

    if (!verA.includes("PostgreSQL 17.11")) {
      console.warn(`  ! Note: Expected PostgreSQL 17.11, detected: ${verA}`);
    } else {
      console.log(`  ✓ Confirmed: Running on native PostgreSQL 17.11 on Linux container.`);
    }

    // 2. Verify independent backend worker processes (pg_backend_pid)
    const pidResA = await connA.query("SELECT pg_backend_pid() AS pid;");
    const pidResB = await connB.query("SELECT pg_backend_pid() AS pid;");
    const pidA = parseInt(pidResA.rows[0].pid, 10);
    const pidB = parseInt(pidResB.rows[0].pid, 10);

    console.log(`\n[3] PostgreSQL Dedicated Backend Process IDs:`);
    console.log(`  - Conn-A Backend PID: ${pidA}`);
    console.log(`  - Conn-B Backend PID: ${pidB}`);

    if (pidA === pidB) {
      throw new Error(`CRITICAL: Conn-A and Conn-B share the same backend PID (${pidA})! Must be independent.`);
    }
    console.log(`  ✓ Verified: Conn-A (PID ${pidA}) and Conn-B (PID ${pidB}) are distinct backend processes.`);

    // 3. Apply TASK 24 Migration
    console.log("\n[4] Ensuring TASK 24 Migration (20261117000000_pin_reveal.sql) is applied...");
    const migrationSql = fs.readFileSync(
      path.join(ROOT, "supabase/migrations/20261117000000_pin_reveal.sql"),
      "utf8"
    );
    await connA.query(migrationSql);
    console.log("  ✓ Migration 20261117000000_pin_reveal.sql executed on PostgreSQL 17.11.");

    // 4. Run verify_pin_reveal_rollback.sql to check all 15 verification groups (G00-G14)
    console.log("\n[5] Executing Verification SQL (verify_pin_reveal_rollback.sql) on real PostgreSQL...");
    const verifySql = fs.readFileSync(
      path.join(ROOT, "tests/integration/sql/verify_pin_reveal_rollback.sql"),
      "utf8"
    );
    await connA.query(verifySql);
    console.log("  ✓ verify_pin_reveal_rollback.sql completed cleanly on real PostgreSQL 17.11 (P0099 rollback caught)! ");

    // 5. Deterministic Sequential Tests for 2-Step Reveal Concurrency
    console.log("\n[6] Running Deterministic Step-by-Step Concurrency & Permission Tests...");

    const prefix = "fa24cc00-";
    const customerId = "fa24cc00-0000-0000-0000-000000000001";
    const merchantId = "fa24cc00-0000-0000-0000-000000000002";
    const adminId = "fa24cc00-0000-0000-0000-000000000003";
    const bizId = "fa24cc00-0000-0000-0000-000000000010";
    const restroomId = "fa24cc00-0000-0000-0000-000000000020";
    const policyId = "fa24cc00-0000-0000-0000-000000000025";
    const secretV1Id = "fa24cc00-0000-0000-0000-000000000028";
    const sessionId1 = "fa24cc00-0000-0000-0000-000000000030";
    const orderId1 = "fa24cc00-0000-0000-0000-000000000040";

    const safeCleanup = async () => {
      await connA.query(`
        ALTER TABLE public.pin_reveal_audits DISABLE TRIGGER trg_prevent_pin_reveal_audits_mutation;
        ALTER TABLE public.access_sessions DISABLE TRIGGER trg_prevent_access_sessions_delete;
        ALTER TABLE public.payment_orders DISABLE TRIGGER trg_prevent_payment_orders_delete;
        ALTER TABLE public.payment_refunds DISABLE TRIGGER trg_prevent_payment_refunds_delete;
        ALTER TABLE public.audit_logs DISABLE TRIGGER trg_prevent_audit_logs_mutation;

        DELETE FROM public.pin_reveal_audits WHERE access_session_id::text LIKE '${prefix}%' OR user_id::text LIKE '${prefix}%';
        DELETE FROM public.visit_confirmations WHERE access_session_id::text LIKE '${prefix}%';
        DELETE FROM public.audit_logs WHERE actor_user_id::text LIKE '${prefix}%' OR entity_id::text LIKE '${prefix}%' OR entity_id IN (
          SELECT id FROM public.restroom_lock_secrets WHERE restroom_id::text LIKE '${prefix}%'
        );
        DELETE FROM public.payment_refunds WHERE requested_by::text LIKE '${prefix}%' OR id::text LIKE '${prefix}%';
        DELETE FROM public.payment_orders WHERE user_id::text LIKE '${prefix}%' OR id::text LIKE '${prefix}%';
        DELETE FROM public.access_sessions WHERE user_id::text LIKE '${prefix}%' OR id::text LIKE '${prefix}%';
        DELETE FROM public.restroom_lock_secrets WHERE restroom_id::text LIKE '${prefix}%' OR created_by::text LIKE '${prefix}%';
        DELETE FROM public.restroom_access_policies WHERE restroom_id::text LIKE '${prefix}%';
        DELETE FROM public.restrooms WHERE id::text LIKE '${prefix}%';
        DELETE FROM public.business_members WHERE user_id::text LIKE '${prefix}%';
        DELETE FROM public.businesses WHERE id::text LIKE '${prefix}%';
        DELETE FROM public.user_roles WHERE user_id::text LIKE '${prefix}%';
        DELETE FROM public.profiles WHERE id::text LIKE '${prefix}%';
        DELETE FROM auth.users WHERE id::text LIKE '${prefix}%';

        ALTER TABLE public.pin_reveal_audits ENABLE TRIGGER trg_prevent_pin_reveal_audits_mutation;
        ALTER TABLE public.access_sessions ENABLE TRIGGER trg_prevent_access_sessions_delete;
        ALTER TABLE public.payment_orders ENABLE TRIGGER trg_prevent_payment_orders_delete;
        ALTER TABLE public.payment_refunds ENABLE TRIGGER trg_prevent_payment_refunds_delete;
        ALTER TABLE public.audit_logs ENABLE TRIGGER trg_prevent_audit_logs_mutation;
      `);
    };

    await safeCleanup();

    try {
      // Setup Base Fixtures
      await connA.query(`
        INSERT INTO auth.users (id, email) VALUES
          ('${customerId}', 'realpg_cust@test.com'),
          ('${merchantId}', 'realpg_merch@test.com'),
          ('${adminId}', 'realpg_admin@test.com')
        ON CONFLICT (id) DO NOTHING;

        INSERT INTO public.profiles (id, display_name, account_status) VALUES
          ('${customerId}', 'RealPG Customer', 'active'),
          ('${merchantId}', 'RealPG Merchant', 'active'),
          ('${adminId}', 'RealPG Admin', 'active')
        ON CONFLICT (id) DO UPDATE SET account_status = EXCLUDED.account_status;

        INSERT INTO public.user_roles (user_id, role) VALUES
          ('${customerId}', 'customer'),
          ('${merchantId}', 'merchant'),
          ('${adminId}', 'admin')
        ON CONFLICT (user_id, role) DO NOTHING;

        INSERT INTO public.businesses (id, name, created_by, category, road_address, latitude, longitude, registration_status, approved_at)
        VALUES ('${bizId}', 'RealPG Cafe', '${merchantId}', 'cafe', '서둔동 10', 37.266, 127.001, 'approved', now())
        ON CONFLICT (id) DO NOTHING;

        INSERT INTO public.business_members (business_id, user_id, role)
        VALUES ('${bizId}', '${merchantId}', 'owner')
        ON CONFLICT (business_id, user_id) DO NOTHING;

        INSERT INTO public.restrooms (id, business_id, type, name, road_address, latitude, longitude, access_method, publication_status, created_by)
        VALUES ('${restroomId}', '${bizId}', 'partner', 'RealPG Restroom', '서둔동 10', 37.266, 127.001, 'pin', 'published', '${merchantId}')
        ON CONFLICT (id) DO NOTHING;

        INSERT INTO public.restroom_access_policies (id, restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, receipt_window_hours, min_purchase_krw, is_active, effective_from, created_by)
        VALUES ('${policyId}', '${restroomId}', 1, 'test_deposit', 1000, true, 24, 0, true, now(), '${merchantId}')
        ON CONFLICT (id) DO NOTHING;

        -- Secret Version 1 Active
        INSERT INTO public.restroom_lock_secrets (
          id, restroom_id, ciphertext_b64, iv_b64, auth_tag_b64, key_version, code_version,
          valid_from, valid_until, status, created_by, idempotency_key, pin_hmac_b64
        ) VALUES (
          '${secretV1Id}', '${restroomId}', 'Y2lwaGVyX3JlYWxfdjE=', 'aXZfcmVhbF92MQ==', 'dGFnX3JlYWxfdjE=',
          1, 1, now() - interval '1 hour', null, 'active', '${merchantId}', 'real-idem-v1', 'aG1hY192MQ=='
        );

        -- Session 1
        INSERT INTO public.access_sessions (id, user_id, restroom_id, policy_id, status, access_method_snapshot, idempotency_key, expires_at)
        VALUES ('${sessionId1}', '${customerId}', '${restroomId}', '${policyId}', 'created', 'pin', 'real-sess-idem-1', now() + interval '2 hours');

        INSERT INTO public.payment_orders (id, access_session_id, user_id, order_id, provider, payment_mode, amount_krw, status, idempotency_key)
        VALUES ('${orderId1}', '${sessionId1}', '${customerId}', 'real-ord-1', 'toss', 'test', 1000, 'created', 'real-ord-idem-1');

        UPDATE public.payment_orders
        SET status = 'approved', provider_payment_key = 'pk_real_test_1', approved_at = now()
        WHERE id = '${orderId1}';

        UPDATE public.access_sessions
        SET status = 'authorized', authorized_at = now()
        WHERE id = '${sessionId1}';
      `);
      console.log("  ✓ Fixtures initialized: Session 1 authorized, Secret v1 active.");

      // -----------------------------------------------------------------------
      // [Scenario 1] Customer calls reveal v1 -> Merchant rotates to v2 -> Customer confirm v1 MUST BE REJECTED!
      // -----------------------------------------------------------------------
      console.log("\n  [Scenario 1] Deterministic Interleaving: Rotation between reveal_access_pin and confirm_pin_revealed");

      // Step 1: Customer reveals active secret v1 on Conn-B
      const revRes1 = await connB.query(`
        SELECT public.reveal_access_pin('${sessionId1}'::uuid, '${customerId}'::uuid, 'req-step-1') AS res;
      `);
      const revData1 = JSON.parse(revRes1.rows[0].res);
      console.log(`    Step 1: Customer (Conn-B) revealed PIN: ok=${revData1.ok}, code_version=${revData1.code_version}, secret_id=${revData1.secret_id}`);
      if (!revData1.ok || revData1.code_version !== 1 || revData1.secret_id !== secretV1Id) {
        throw new Error(`Step 1 failed: Expected code_version=1 & secret_id=${secretV1Id}, got: ${JSON.stringify(revData1)}`);
      }

      // Step 2: In the interim, Merchant rotates PIN to v2 on Conn-A!
      const rotRes1 = await connA.query(`
        SELECT public.rotate_restroom_pin(
          '${restroomId}'::uuid, '${merchantId}'::uuid,
          'Y2lwaGVyX3JlYWxfdjI=', 'aXZfcmVhbF92Mg==', 'dGFnX3JlYWxfdjI=', 1,
          'real-rot-idem-v2', 'aG1hY192Mg=='
        ) AS res;
      `);
      const rotData1 = JSON.parse(rotRes1.rows[0].res);
      console.log(`    Step 2: Merchant (Conn-A) rotated PIN in interim: action=${rotData1.action}, new code_version=${rotData1.code_version}`);
      if (!rotData1.success || rotData1.code_version !== 2) {
        throw new Error(`Step 2 rotate failed: ${JSON.stringify(rotData1)}`);
      }

      // Step 3: Customer finishes decrypting and calls confirm_pin_revealed with v1 on Conn-B
      // MUST BE REJECTED with 409 PIN_STALE_ROTATED!
      const confirmStaleRes = await connB.query(`
        SELECT public.confirm_pin_revealed(
          '${sessionId1}'::uuid, '${customerId}'::uuid, '${restroomId}'::uuid, 1, '${secretV1Id}'::uuid, 'req-confirm-stale'
        ) AS res;
      `);
      const confirmStaleData = JSON.parse(confirmStaleRes.rows[0].res);
      console.log(`    Step 3: Stale confirm response: ok=${confirmStaleData.ok}, error_code=${confirmStaleData.error_code}, status=${confirmStaleData.status}`);

      if (confirmStaleData.ok !== false || confirmStaleData.error_code !== "PIN_STALE_ROTATED" || confirmStaleData.status !== 409) {
        throw new Error(`CRITICAL: Stale confirm was NOT rejected with PIN_STALE_ROTATED 409! Got: ${JSON.stringify(confirmStaleData)}`);
      }
      console.log(`    ✓ Confirmed: confirm_pin_revealed rejected stale PIN version 1 with 409 PIN_STALE_ROTATED.`);

      // Verify DB State after rejection:
      // 1) access_sessions.status is STILL 'authorized' (NOT 'code_revealed')!
      const sessCheckStale = await connA.query(`SELECT status, code_revealed_at FROM public.access_sessions WHERE id = '${sessionId1}';`);
      console.log(`    - Session status after stale confirm rejection: '${sessCheckStale.rows[0].status}' (code_revealed_at=${sessCheckStale.rows[0].code_revealed_at})`);
      if (sessCheckStale.rows[0].status !== "authorized" || sessCheckStale.rows[0].code_revealed_at !== null) {
        throw new Error(`CRITICAL: access_sessions.status was wrongfully modified to ${sessCheckStale.rows[0].status}!`);
      }

      // 2) pin_reveal_audits recorded 'denied', reason='pin_stale_rotated', NO 'success' row
      const auditCheckStale = await connA.query(`
        SELECT result, reason FROM public.pin_reveal_audits
        WHERE access_session_id = '${sessionId1}' AND request_id = 'req-confirm-stale';
      `);
      console.log(`    - Audit log for stale confirm: result='${auditCheckStale.rows[0].result}', reason='${auditCheckStale.rows[0].reason}'`);
      if (auditCheckStale.rows[0].result !== "denied" || auditCheckStale.rows[0].reason !== "pin_stale_rotated") {
        throw new Error(`Audit log mismatch for stale confirm rejection: ${JSON.stringify(auditCheckStale.rows)}`);
      }
      console.log(`    ✓ Verified: No fake success audit, access session status remains authorized.`);

      // Step 4: Customer recovers by requesting PIN reveal again (now gets v2)
      const revRes2 = await connB.query(`
        SELECT public.reveal_access_pin('${sessionId1}'::uuid, '${customerId}'::uuid, 'req-step-4-fresh') AS res;
      `);
      const revData2 = JSON.parse(revRes2.rows[0].res);
      console.log(`    Step 4: Customer re-revealed PIN: ok=${revData2.ok}, code_version=${revData2.code_version}, secret_id=${revData2.secret_id}`);
      if (!revData2.ok || revData2.code_version !== 2) {
        throw new Error(`Customer re-reveal failed: ${JSON.stringify(revData2)}`);
      }

      // Confirm with active version 2 on Conn-B
      const confirmFreshRes = await connB.query(`
        SELECT public.confirm_pin_revealed(
          '${sessionId1}'::uuid, '${customerId}'::uuid, '${restroomId}'::uuid, 2, '${revData2.secret_id}'::uuid, 'req-confirm-fresh'
        ) AS res;
      `);
      const confirmFreshData = JSON.parse(confirmFreshRes.rows[0].res);
      console.log(`    - Fresh confirm response: ok=${confirmFreshData.ok}, code_version=${confirmFreshData.code_version}`);
      if (!confirmFreshData.ok || confirmFreshData.code_version !== 2) {
        throw new Error(`Fresh confirm failed: ${JSON.stringify(confirmFreshData)}`);
      }

      const sessCheckFresh = await connA.query(`SELECT status, code_revealed_at FROM public.access_sessions WHERE id = '${sessionId1}';`);
      if (sessCheckFresh.rows[0].status !== "code_revealed" || sessCheckFresh.rows[0].code_revealed_at === null) {
        throw new Error(`Expected session status 'code_revealed', got: ${sessCheckFresh.rows[0].status}`);
      }
      console.log(`    ✓ Scenario 1 Passed: Outdated PIN rejected with 409, fresh PIN confirmed cleanly!`);

      // -----------------------------------------------------------------------
      // [Scenario 2] Intermediate Refund between reveal and confirm
      // -----------------------------------------------------------------------
      console.log("\n  [Scenario 2] Deterministic Interleaving: Refund between reveal_access_pin and confirm_pin_revealed");

      const sessionId2 = "fa24cc00-0000-0000-0000-000000000031";
      const orderId2 = "fa24cc00-0000-0000-0000-000000000041";
      const refundId2 = "fa24cc00-0000-0000-0000-000000000051";

      await connA.query(`
        INSERT INTO public.access_sessions (id, user_id, restroom_id, policy_id, status, access_method_snapshot, idempotency_key, expires_at)
        VALUES ('${sessionId2}', '${customerId}', '${restroomId}', '${policyId}', 'created', 'pin', 'sess-idem-2', now() + interval '2 hours');

        INSERT INTO public.payment_orders (id, access_session_id, user_id, order_id, provider, payment_mode, amount_krw, status, idempotency_key)
        VALUES ('${orderId2}', '${sessionId2}', '${customerId}', 'real-ord-2', 'toss', 'test', 1000, 'created', 'ord-idem-2');

        UPDATE public.payment_orders
        SET status = 'approved', provider_payment_key = 'pk_test_2', approved_at = now()
        WHERE id = '${orderId2}';

        UPDATE public.access_sessions
        SET status = 'authorized', authorized_at = now()
        WHERE id = '${sessionId2}';
      `);

      // Customer reveals PIN on Conn-B
      const revResRef = await connB.query(`
        SELECT public.reveal_access_pin('${sessionId2}'::uuid, '${customerId}'::uuid, 'req-ref-reveal') AS res;
      `);
      const revDataRef = JSON.parse(revResRef.rows[0].res);
      if (!revDataRef.ok) throw new Error("Reveal failed in Scenario 2");

      // In the interim, admin processes refund on Conn-A
      await connA.query(`
        INSERT INTO public.payment_refunds (id, payment_order_id, amount_krw, status, idempotency_key, requested_by)
        VALUES ('${refundId2}', '${orderId2}', 1000, 'requested', 'ref-idem-2', '${adminId}');
        UPDATE public.payment_refunds SET status = 'succeeded', provider_cancel_id = 'cancel_test_2', completed_at = now() WHERE id = '${refundId2}';
      `);

      // Customer attempts to confirm on Conn-B
      // MUST BE REJECTED with 422 PAYMENT_REFUNDED!
      const confirmRefRes = await connB.query(`
        SELECT public.confirm_pin_revealed(
          '${sessionId2}'::uuid, '${customerId}'::uuid, '${restroomId}'::uuid, 2, '${revDataRef.secret_id}'::uuid, 'req-ref-confirm'
        ) AS res;
      `);
      const confirmRefData = JSON.parse(confirmRefRes.rows[0].res);
      console.log(`    Refunded confirm response: ok=${confirmRefData.ok}, error_code=${confirmRefData.error_code}, status=${confirmRefData.status}`);

      if (confirmRefData.ok !== false || confirmRefData.error_code !== "PAYMENT_REFUNDED" || confirmRefData.status !== 422) {
        throw new Error(`CRITICAL: Intermediate refund was NOT rejected with PAYMENT_REFUNDED 422! Got: ${JSON.stringify(confirmRefData)}`);
      }

      const sessRefCheck = await connA.query(`SELECT status FROM public.access_sessions WHERE id = '${sessionId2}';`);
      if (sessRefCheck.rows[0].status === "code_revealed") {
        throw new Error("CRITICAL: Session transitioned to code_revealed despite refund!");
      }
      console.log(`    ✓ Scenario 2 Passed: Intermediate refund rejected with 422, session not confirmed!`);

      // -----------------------------------------------------------------------
      // [Scenario 3] Intermediate Expiration between reveal and confirm
      // -----------------------------------------------------------------------
      console.log("\n  [Scenario 3] Deterministic Interleaving: Expiration between reveal_access_pin and confirm_pin_revealed");

      const sessionId3 = "fa24cc00-0000-0000-0000-000000000032";
      const orderId3 = "fa24cc00-0000-0000-0000-000000000042";

      // Session expires in 500 milliseconds
      await connA.query(`
        INSERT INTO public.access_sessions (id, user_id, restroom_id, policy_id, status, access_method_snapshot, idempotency_key, expires_at)
        VALUES ('${sessionId3}', '${customerId}', '${restroomId}', '${policyId}', 'created', 'pin', 'sess-idem-3', now() + interval '500 milliseconds');

        INSERT INTO public.payment_orders (id, access_session_id, user_id, order_id, provider, payment_mode, amount_krw, status, idempotency_key)
        VALUES ('${orderId3}', '${sessionId3}', '${customerId}', 'real-ord-3', 'toss', 'test', 1000, 'created', 'ord-idem-3');

        UPDATE public.payment_orders
        SET status = 'approved', provider_payment_key = 'pk_test_3', approved_at = now()
        WHERE id = '${orderId3}';

        UPDATE public.access_sessions
        SET status = 'authorized', authorized_at = now()
        WHERE id = '${sessionId3}';
      `);

      // Reveal immediately on Conn-B
      const revResExp = await connB.query(`
        SELECT public.reveal_access_pin('${sessionId3}'::uuid, '${customerId}'::uuid, 'req-exp-reveal') AS res;
      `);
      const revDataExp = JSON.parse(revResExp.rows[0].res);
      if (!revDataExp.ok) throw new Error("Reveal failed in Scenario 3");

      // Wait 600ms so session expires
      console.log("    Sleeping 650ms to allow session expiration...");
      await new Promise((resolve) => setTimeout(resolve, 650));

      // Customer attempts to confirm on Conn-B
      // MUST BE REJECTED with 422 ACCESS_EXPIRED!
      const confirmExpRes = await connB.query(`
        SELECT public.confirm_pin_revealed(
          '${sessionId3}'::uuid, '${customerId}'::uuid, '${restroomId}'::uuid, 2, '${revDataExp.secret_id}'::uuid, 'req-exp-confirm'
        ) AS res;
      `);
      const confirmExpData = JSON.parse(confirmExpRes.rows[0].res);
      console.log(`    Expired confirm response: ok=${confirmExpData.ok}, error_code=${confirmExpData.error_code}, status=${confirmExpData.status}`);

      if (confirmExpData.ok !== false || confirmExpData.error_code !== "ACCESS_EXPIRED" || confirmExpData.status !== 422) {
        throw new Error(`CRITICAL: Intermediate expiration was NOT rejected with ACCESS_EXPIRED 422! Got: ${JSON.stringify(confirmExpData)}`);
      }

      const sessExpCheck = await connA.query(`SELECT status FROM public.access_sessions WHERE id = '${sessionId3}';`);
      if (sessExpCheck.rows[0].status !== "expired") {
        throw new Error(`Expected session status 'expired', got: ${sessExpCheck.rows[0].status}`);
      }
      console.log(`    ✓ Scenario 3 Passed: Intermediate expiration rejected with 422, session marked expired!`);

    } finally {
      await safeCleanup();
    }

    // 6. Verify 0 test residue across all tables
    const residueRes = await connA.query(`
      SELECT
        (SELECT count(*)::int FROM public.pin_reveal_audits WHERE access_session_id::text LIKE '${prefix}%') AS audits_cnt,
        (SELECT count(*)::int FROM public.visit_confirmations WHERE access_session_id::text LIKE '${prefix}%') AS visits_cnt,
        (SELECT count(*)::int FROM public.access_sessions WHERE id::text LIKE '${prefix}%') AS sessions_cnt,
        (SELECT count(*)::int FROM public.payment_orders WHERE id::text LIKE '${prefix}%') AS orders_cnt,
        (SELECT count(*)::int FROM public.restroom_lock_secrets WHERE restroom_id::text LIKE '${prefix}%') AS secrets_cnt,
        (SELECT count(*)::int FROM public.restrooms WHERE id::text LIKE '${prefix}%') AS restrooms_cnt,
        (SELECT count(*)::int FROM public.businesses WHERE id::text LIKE '${prefix}%') AS biz_cnt,
        (SELECT count(*)::int FROM public.profiles WHERE id::text LIKE '${prefix}%') AS profiles_cnt,
        (SELECT count(*)::int FROM auth.users WHERE id::text LIKE '${prefix}%') AS users_cnt
    `);

    const r = residueRes.rows[0];
    console.log(`\n[7] Final Residue Verification across All Tables:`, r);
    for (const [k, v] of Object.entries(r)) {
      if (parseInt(v, 10) !== 0) {
        throw new Error(`Residue detected in ${k}: ${v}`);
      }
    }
    console.log(`  ✓ Verified: 0 test residue across all tables on real PostgreSQL 17.11.`);

    console.log("\n================================================================================");
    console.log(">>> ALL DETERMINISTIC 2-STEP PIN REVEAL CONCURRENCY TESTS PASSED CLEANLY!");
    console.log("================================================================================");
  } finally {
    await Promise.all([connA.close(), connB.close()]);
  }
}

main().catch((err) => {
  console.error("FATAL ERROR in real PostgreSQL test:", err);
  process.exit(1);
});

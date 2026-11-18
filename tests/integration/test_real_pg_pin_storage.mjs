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
  console.log(`TASK 23 — Real Local PostgreSQL (${host}:${port}) Multi-Connection Integration Test`);
  console.log("================================================================================");

  // 1. Open TWO distinct TCP connections to local Supabase PostgreSQL
  const connA = new PgWireClient({ host, port, user, password, database, name: "Conn-A" });
  const connB = new PgWireClient({ host, port, user, password, database, name: "Conn-B" });

  await Promise.all([connA.connect(), connB.connect()]);

  try {
    // 2. Verify pg_backend_pid() on both connections while simultaneously active
    const [identA, identB] = await Promise.all([
      connA.query(`
        SELECT
          pg_backend_pid() AS pid,
          version() AS pg_version,
          inet_server_addr()::text AS server_addr,
          inet_server_port() AS server_port,
          current_database() AS db_name
      `),
      connB.query(`
        SELECT
          pg_backend_pid() AS pid,
          version() AS pg_version,
          inet_server_addr()::text AS server_addr,
          inet_server_port() AS server_port,
          current_database() AS db_name
      `),
    ]);

    const pidA = parseInt(identA.rows[0].pid, 10);
    const pidB = parseInt(identB.rows[0].pid, 10);

    console.log(`\n[1] Two Independent PostgreSQL Connections Verified:`);
    console.log(`  - Server Version : ${identA.rows[0].pg_version}`);
    console.log(`  - Connection A   : pg_backend_pid() = ${pidA} (db=${identA.rows[0].db_name}, port=${identA.rows[0].server_port})`);
    console.log(`  - Connection B   : pg_backend_pid() = ${pidB} (db=${identB.rows[0].db_name}, port=${identB.rows[0].server_port})`);

    if (!Number.isInteger(pidA) || !Number.isInteger(pidB) || pidA === pidB) {
      throw new Error(`Expected two distinct pg_backend_pid() values, got ${pidA} and ${pidB}`);
    }
    console.log(`  ✓ Verified: pidA (${pidA}) !== pidB (${pidB})`);

    // 3. Verify applied migrations (without re-applying)
    const migRes = await connA.query(`
      SELECT version, name
      FROM supabase_migrations.schema_migrations
      ORDER BY version ASC
    `);
    console.log(`\n[2] Applied Migrations Check (Count: ${migRes.rows.length}):`);
    for (const row of migRes.rows) {
      console.log(`  - ${row.version}: ${row.name || "(applied)"}`);
    }
    const hasTask23Mig = migRes.rows.some((r) => r.version === "20261116000000");
    if (!hasTask23Mig || migRes.rows.length < 11) {
      throw new Error(
        `Expected 11 applied migrations including 20261116000000, found ${migRes.rows.length}`
      );
    }
    console.log(`  ✓ Verified: All 11 migrations (including 20261116000000_pin_storage.sql) are already applied.`);

    // 4. Execute verify_pin_storage_rollback.sql (G00~G11) on real PostgreSQL
    console.log(`\n[3] Executing tests/integration/sql/verify_pin_storage_rollback.sql (G00~G11)...`);
    connA.notices = [];
    const rollbackSql = fs.readFileSync(
      path.join(ROOT, "tests/integration/sql/verify_pin_storage_rollback.sql"),
      "utf8"
    );
    const rollbackRes = await connA.query(rollbackSql);
    for (const n of connA.notices) {
      console.log(`  [NOTICE] ${n}`);
    }
    console.log(`  ✓ Command Tags: ${JSON.stringify(rollbackRes.commandTags)}`);

    // 5. Real Role-Switched RLS, RPC Privilege, and Transaction Rollback Verification
    console.log(`\n[4] Verifying Real PostgreSQL Role-Switched RLS, RPC Privileges & Transaction Rollback...`);
    await connA.query("BEGIN");
    try {
      await connA.query("SET LOCAL ROLE anon");
      let anonSelectBlocked = false;
      try {
        await connA.query("SELECT * FROM public.restroom_lock_secrets LIMIT 1");
      } catch (err) {
        if (err.code === "42501") anonSelectBlocked = true;
        else throw err;
      }
      if (!anonSelectBlocked) {
        throw new Error("anon SELECT on restroom_lock_secrets was not blocked with 42501");
      }
    } finally {
      await connA.query("ROLLBACK");
    }

    await connA.query("BEGIN");
    try {
      await connA.query("SET LOCAL ROLE anon");
      let anonRpcBlocked = false;
      try {
        await connA.query(
          "SELECT public.rotate_restroom_pin(gen_random_uuid(), gen_random_uuid(), 'c', 'i', 't', 1)"
        );
      } catch (err) {
        if (err.code === "42501") anonRpcBlocked = true;
        else throw err;
      }
      if (!anonRpcBlocked) {
        throw new Error("anon EXECUTE on rotate_restroom_pin was not blocked with 42501");
      }
    } finally {
      await connA.query("ROLLBACK");
    }

    await connA.query("BEGIN");
    try {
      await connA.query("SET LOCAL ROLE authenticated");
      let authSelectBlocked = false;
      try {
        await connA.query("SELECT * FROM public.restroom_lock_secrets LIMIT 1");
      } catch (err) {
        if (err.code === "42501") authSelectBlocked = true;
        else throw err;
      }
      if (!authSelectBlocked) {
        throw new Error("authenticated SELECT on restroom_lock_secrets was not blocked with 42501");
      }
    } finally {
      await connA.query("ROLLBACK");
    }

    await connA.query("BEGIN");
    try {
      await connA.query("SET LOCAL ROLE authenticated");
      let authRpcBlocked = false;
      try {
        await connA.query(
          "SELECT public.rotate_restroom_pin(gen_random_uuid(), gen_random_uuid(), 'c', 'i', 't', 1)"
        );
      } catch (err) {
        if (err.code === "42501") authRpcBlocked = true;
        else throw err;
      }
      if (!authRpcBlocked) {
        throw new Error("authenticated EXECUTE on rotate_restroom_pin was not blocked with 42501");
      }
    } finally {
      await connA.query("ROLLBACK");
    }
    console.log(`  ✓ Verified: Actual SET LOCAL ROLE anon & authenticated blocked (42501) on table DML/SELECT and rotate_restroom_pin RPC.`);

    // 6. Real Multi-Connection (Conn-A & Conn-B) Concurrency Tests
    console.log(`\n[5] Setting up isolated fixtures for Multi-Connection Concurrency Tests...`);
    const prefix = "fa23c900-";
    const merchantA = "fa23c900-0000-0000-0000-000000000001";
    const merchantB = "fa23c900-0000-0000-0000-000000000002";
    const adminId = "fa23c900-0000-0000-0000-000000000003";
    const bizA = "fa23c900-0000-0000-0000-000000000010";
    const bizB = "fa23c900-0000-0000-0000-000000000011";
    const restroomA = "fa23c900-0000-0000-0000-000000000020";
    const restroomB = "fa23c900-0000-0000-0000-000000000021";

    const cleanupFixtures = async () => {
      await connA.query(`
        ALTER TABLE public.audit_logs DISABLE TRIGGER trg_prevent_audit_logs_mutation;
        DELETE FROM public.audit_logs WHERE actor_user_id::text LIKE '${prefix}%' OR entity_id IN (
          SELECT id FROM public.restroom_lock_secrets WHERE restroom_id::text LIKE '${prefix}%'
        );
        ALTER TABLE public.audit_logs ENABLE TRIGGER trg_prevent_audit_logs_mutation;
        DELETE FROM public.restroom_lock_secrets WHERE restroom_id::text LIKE '${prefix}%';
        DELETE FROM public.restrooms WHERE id::text LIKE '${prefix}%';
        DELETE FROM public.business_members WHERE business_id::text LIKE '${prefix}%';
        DELETE FROM public.businesses WHERE id::text LIKE '${prefix}%';
        DELETE FROM public.user_roles WHERE user_id::text LIKE '${prefix}%';
        DELETE FROM public.profiles WHERE id::text LIKE '${prefix}%';
        DELETE FROM auth.users WHERE id::text LIKE '${prefix}%';
      `);
    };

    await cleanupFixtures();
    await connA.query(`
      INSERT INTO auth.users (id, email) VALUES
        ('${merchantA}', 'fa23c900_merchant_a@test.com'),
        ('${merchantB}', 'fa23c900_merchant_b@test.com'),
        ('${adminId}', 'fa23c900_admin@test.com');

      INSERT INTO public.profiles (id, display_name, account_status) VALUES
        ('${merchantA}', '동시성점주A', 'active'),
        ('${merchantB}', '동시성점주B', 'active'),
        ('${adminId}', '동시성관리자', 'active')
      ON CONFLICT (id) DO UPDATE SET account_status = 'active', display_name = EXCLUDED.display_name;

      INSERT INTO public.user_roles (user_id, role) VALUES
        ('${merchantA}', 'merchant'),
        ('${merchantB}', 'merchant'),
        ('${adminId}', 'admin')
      ON CONFLICT (user_id, role) DO NOTHING;

      INSERT INTO public.businesses (
        id, name, category, road_address, latitude, longitude, registration_status, approved_by, approved_at, created_by
      ) VALUES
        ('${bizA}', 'DEMO-동시성점포A', '카페', '수원시 팔달구 100', 37.28, 127.01, 'approved', '${adminId}', now(), '${merchantA}'),
        ('${bizB}', 'DEMO-동시성점포B', '카페', '수원시 팔달구 101', 37.281, 127.011, 'approved', '${adminId}', now(), '${merchantB}');

      INSERT INTO public.business_members (business_id, user_id, role, membership_status) VALUES
        ('${bizA}', '${merchantA}', 'owner', 'active'),
        ('${bizB}', '${merchantB}', 'owner', 'active');

      INSERT INTO public.restrooms (
        id, business_id, type, name, road_address, access_method, publication_status, latitude, longitude
      ) VALUES
        ('${restroomA}', '${bizA}', 'partner', 'DEMO-동시성화장실A', '수원시 팔달구 100', 'pin', 'published', 37.28, 127.01),
        ('${restroomB}', '${bizB}', 'partner', 'DEMO-동시성화장실B', '수원시 팔달구 101', 'pin', 'published', 37.281, 127.011);
    `);

    try {
      // ----------------------------------------------------------------------
      // CASE 0: SET LOCAL ROLE service_role execution + Transaction ROLLBACK
      // ----------------------------------------------------------------------
      console.log(`\n  [Case 0] SET LOCAL ROLE service_role RPC Execution & Transaction Rollback`);
      await connA.query("BEGIN");
      await connA.query("SET LOCAL ROLE service_role");
      const res0 = await connA.query(`
        SELECT public.rotate_restroom_pin(
          '${restroomA}'::uuid, '${merchantA}'::uuid,
          'Y2lwaGVyX3JvbGxiYWNr', 'aXZfcm9sbGJhY2s=', 'dGFnX3JvbGxiYWNr', 1,
          'fa23c900_idem_rollback_0', 'aG1hY19yb2xsYmFja18w'
        ) AS res
      `);
      const body0 = JSON.parse(res0.rows[0].res);
      if (!body0.success || body0.code_version !== 1 || body0.action !== "register_pin") {
        throw new Error(`Expected service_role RPC success v1, got ${JSON.stringify(body0)}`);
      }
      await connA.query("ROLLBACK");

      const afterRollbackCnt = await connA.query(`
        SELECT count(*)::int AS cnt
        FROM public.restroom_lock_secrets
        WHERE restroom_id = '${restroomA}'
      `);
      if (parseInt(afterRollbackCnt.rows[0].cnt, 10) !== 0) {
        throw new Error(`Expected 0 secrets after transaction ROLLBACK, got ${afterRollbackCnt.rows[0].cnt}`);
      }
      console.log(`    ✓ Case 0 Passed: service_role executed rotate_restroom_pin and ROLLBACK left 0 rows.`);
      // ----------------------------------------------------------------------
      // CASE 1: Concurrent Rotation on Same Restroom across Conn-A & Conn-B
      //         (Lock Contention + Sequential Version [1, 2] + Single Active)
      // ----------------------------------------------------------------------
      console.log(`\n  [Case 1] Concurrent PIN Rotation on Same Restroom (Conn-A PID=${pidA} vs Conn-B PID=${pidB})`);
      await connA.query("BEGIN");
      await connB.query("BEGIN");

      // Conn-A starts rotation first inside transaction (acquires FOR UPDATE lock on restroomA)
      const res1A = await connA.query(`
        SELECT pg_backend_pid() AS pid, public.rotate_restroom_pin(
          '${restroomA}'::uuid, '${merchantA}'::uuid,
          'Y2lwaGVyX2FfcjE=', 'aXZfYV9yMQ==', 'dGFnX2FfcjE=', 1,
          'fa23c900_idem_rot_1', 'aG1hY19hX3Ix'
        ) AS res
      `);

      // Conn-B fires rotation while Conn-A still holds the uncommitted transaction lock,
      // then Conn-A commits after 50ms so Conn-B unblocks and completes!
      const p1B = connB.query(`
        SELECT pg_backend_pid() AS pid, public.rotate_restroom_pin(
          '${restroomA}'::uuid, '${merchantA}'::uuid,
          'Y2lwaGVyX2JfcjI=', 'aXZfYl9yMg==', 'dGFnX2JfcjI=', 1,
          'fa23c900_idem_rot_2', 'aG1hY19iX3Iy'
        ) AS res
      `);

      await new Promise((r) => setTimeout(r, 60));
      await connA.query("COMMIT");
      const res1B = await p1B;
      await connB.query("COMMIT");

      const body1A = JSON.parse(res1A.rows[0].res);
      const body1B = JSON.parse(res1B.rows[0].res);

      console.log(`    - Conn-A (PID ${res1A.rows[0].pid}): action=${body1A.action}, code_version=${body1A.code_version}`);
      console.log(`    - Conn-B (PID ${res1B.rows[0].pid}): action=${body1B.action}, code_version=${body1B.code_version}`);

      if (parseInt(res1A.rows[0].pid, 10) !== pidA || parseInt(res1B.rows[0].pid, 10) !== pidB) {
        throw new Error("PID mismatch during Case 1 execution");
      }
      if (body1A.code_version !== 1 || body1A.action !== "register_pin") {
        throw new Error(`Expected Conn-A to register_pin v1, got ${JSON.stringify(body1A)}`);
      }
      if (body1B.code_version !== 2 || body1B.action !== "rotate_pin") {
        throw new Error(`Expected Conn-B to rotate_pin v2, got ${JSON.stringify(body1B)}`);
      }

      const activeCheck1 = await connA.query(`
        SELECT count(*)::int AS active_cnt
        FROM public.restroom_lock_secrets
        WHERE restroom_id = '${restroomA}' AND status = 'active'
      `);
      if (parseInt(activeCheck1.rows[0].active_cnt, 10) !== 1) {
        throw new Error(`Expected 1 active secret after Case 1, got ${activeCheck1.rows[0].active_cnt}`);
      }
      console.log(`    ✓ Case 1 Passed: Sequential versions [1, 2] and exactly 1 active secret maintained under lock contention.`);

      // ----------------------------------------------------------------------
      // CASE 2: Concurrent Same Idempotency Key + Same HMAC across Conn-A & Conn-B
      //         (1 rotate_pin + 1 replay, identical secret_id & code_version=3)
      // ----------------------------------------------------------------------
      console.log(`\n  [Case 2] Concurrent Same Idempotency Key + Same HMAC (Conn-A PID=${pidA} vs Conn-B PID=${pidB})`);
      const [res2A, res2B] = await Promise.all([
        connA.query(`
          SELECT pg_backend_pid() AS pid, public.rotate_restroom_pin(
            '${restroomA}'::uuid, '${merchantA}'::uuid,
            'Y2lwaGVyX3NhbWVfMw==', 'aXZfc2FtZV8z', 'dGFnX3NhbWVfMw==', 1,
            'fa23c900_idem_same_v3', 'aG1hY19zYW1lX3Yz'
          ) AS res
        `),
        connB.query(`
          SELECT pg_backend_pid() AS pid, public.rotate_restroom_pin(
            '${restroomA}'::uuid, '${merchantA}'::uuid,
            'Y2lwaGVyX3NhbWVfMw==', 'aXZfc2FtZV8z', 'dGFnX3NhbWVfMw==', 1,
            'fa23c900_idem_same_v3', 'aG1hY19zYW1lX3Yz'
          ) AS res
        `),
      ]);

      const body2A = JSON.parse(res2A.rows[0].res);
      const body2B = JSON.parse(res2B.rows[0].res);

      console.log(`    - Conn-A (PID ${res2A.rows[0].pid}): action=${body2A.action}, code_version=${body2A.code_version}, secret_id=${body2A.secret_id}`);
      console.log(`    - Conn-B (PID ${res2B.rows[0].pid}): action=${body2B.action}, code_version=${body2B.code_version}, secret_id=${body2B.secret_id}`);

      const actions2 = [body2A.action, body2B.action].sort();
      if (actions2[0] !== "replay" || actions2[1] !== "rotate_pin") {
        throw new Error(`Expected ['replay', 'rotate_pin'], got ${JSON.stringify(actions2)}`);
      }
      if (body2A.code_version !== 3 || body2B.code_version !== 3) {
        throw new Error(`Expected both to return code_version 3, got ${body2A.code_version} and ${body2B.code_version}`);
      }
      if (body2A.secret_id !== body2B.secret_id) {
        throw new Error(`Expected identical secret_id on replay, got ${body2A.secret_id} vs ${body2B.secret_id}`);
      }

      const idemRowCheck2 = await connA.query(`
        SELECT count(*)::int AS cnt
        FROM public.restroom_lock_secrets
        WHERE idempotency_key = 'fa23c900_idem_same_v3'
      `);
      if (parseInt(idemRowCheck2.rows[0].cnt, 10) !== 1) {
        throw new Error(`Expected 1 row for idempotency_key fa23c900_idem_same_v3, found ${idemRowCheck2.rows[0].cnt}`);
      }
      console.log(`    ✓ Case 2 Passed: 1 rotate_pin + 1 replay, identical secret_id & code_version=3, 1 DB row.`);

      // ----------------------------------------------------------------------
      // CASE 3: Concurrent Same Idempotency Key + Different HMAC across Conn-A & Conn-B
      //         (1 rotate_pin v4 + 1 rejected with HM092 / SQLSTATE 23505)
      // ----------------------------------------------------------------------
      console.log(`\n  [Case 3] Concurrent Same Idempotency Key + Different HMAC Conflict (Conn-A PID=${pidA} vs Conn-B PID=${pidB})`);
      const settled3 = await Promise.allSettled([
        connA.query(`
          SELECT pg_backend_pid() AS pid, public.rotate_restroom_pin(
            '${restroomA}'::uuid, '${merchantA}'::uuid,
            'Y2lwaGVyX2NvbmZfNA==', 'aXZfY29uZl80', 'dGFnX2NvbmZfNA==', 1,
            'fa23c900_idem_conflict_v4', 'aG1hY19wYXlsb2FkX0E='
          ) AS res
        `),
        connB.query(`
          SELECT pg_backend_pid() AS pid, public.rotate_restroom_pin(
            '${restroomA}'::uuid, '${merchantA}'::uuid,
            'Y2lwaGVyX2NvbmZfNF9i', 'aXZfY29uZl80X2I=', 'dGFnX2NvbmZfNF9i', 1,
            'fa23c900_idem_conflict_v4', 'aG1hY19wYXlsb2FkX0I='
          ) AS res
        `),
      ]);

      const fulfilled3 = settled3.filter((r) => r.status === "fulfilled");
      const rejected3 = settled3.filter((r) => r.status === "rejected");

      if (fulfilled3.length !== 1 || rejected3.length !== 1) {
        throw new Error(
          `Expected 1 fulfilled and 1 rejected in Case 3, got ${fulfilled3.length} fulfilled / ${rejected3.length} rejected`
        );
      }

      const winner3 = JSON.parse(fulfilled3[0].value.rows[0].res);
      const loser3Err = rejected3[0].reason;

      console.log(`    - Winner (PID ${fulfilled3[0].value.rows[0].pid}): action=${winner3.action}, code_version=${winner3.code_version}`);
      console.log(`    - Loser  Error: code=${loser3Err.code}, message=${loser3Err.message}`);

      if (winner3.code_version !== 4 || winner3.action !== "rotate_pin") {
        throw new Error(`Expected winner v4 rotate_pin, got ${JSON.stringify(winner3)}`);
      }
      if (loser3Err.code !== "23505" || !loser3Err.message.includes("HM092")) {
        throw new Error(`Expected loser error 23505 / HM092, got ${loser3Err.code}: ${loser3Err.message}`);
      }
      console.log(`    ✓ Case 3 Passed: 1 succeeded (v4) and 1 rejected with SQLSTATE 23505 (HM092).`);

      // ----------------------------------------------------------------------
      // CASE 4: Concurrent Same Idempotency Key across Different Restrooms/Merchants
      //         (1 succeeded + 1 rejected with HM091 / SQLSTATE 23505)
      // ----------------------------------------------------------------------
      console.log(`\n  [Case 4] Concurrent Same Idempotency Key across Different Restrooms/Merchants (Conn-A PID=${pidA} vs Conn-B PID=${pidB})`);
      const settled4 = await Promise.allSettled([
        connA.query(`
          SELECT pg_backend_pid() AS pid, public.rotate_restroom_pin(
            '${restroomA}'::uuid, '${merchantA}'::uuid,
            'Y2lwaGVyX2Nyb3NzX2E=', 'aXZfY3Jvc3NfYQ==', 'dGFnX2Nyb3NzX2E=', 1,
            'fa23c900_idem_cross_tenant', 'aG1hY19jcm9zc19zYW1l'
          ) AS res
        `),
        connB.query(`
          SELECT pg_backend_pid() AS pid, public.rotate_restroom_pin(
            '${restroomB}'::uuid, '${merchantB}'::uuid,
            'Y2lwaGVyX2Nyb3NzX2I=', 'aXZfY3Jvc3NfYg==', 'dGFnX2Nyb3NzX2I=', 1,
            'fa23c900_idem_cross_tenant', 'aG1hY19jcm9zc19zYW1l'
          ) AS res
        `),
      ]);

      const fulfilled4 = settled4.filter((r) => r.status === "fulfilled");
      const rejected4 = settled4.filter((r) => r.status === "rejected");

      if (fulfilled4.length !== 1 || rejected4.length !== 1) {
        throw new Error(
          `Expected 1 fulfilled and 1 rejected in Case 4, got ${fulfilled4.length} fulfilled / ${rejected4.length} rejected`
        );
      }

      const winner4 = JSON.parse(fulfilled4[0].value.rows[0].res);
      const loser4Err = rejected4[0].reason;

      console.log(`    - Winner (PID ${fulfilled4[0].value.rows[0].pid}): restroom=${winner4.restroom_id}, action=${winner4.action}`);
      console.log(`    - Loser  Error: code=${loser4Err.code}, message=${loser4Err.message}`);

      if (loser4Err.code !== "23505" || !loser4Err.message.includes("HM091")) {
        throw new Error(`Expected loser error 23505 / HM091, got ${loser4Err.code}: ${loser4Err.message}`);
      }
      console.log(`    ✓ Case 4 Passed: 1 succeeded and 1 rejected with SQLSTATE 23505 (HM091).`);
    } finally {
      await cleanupFixtures();
    }

    // 7. Verify 0 residue across all tables after cleanup
    const residueRes = await connA.query(`
      SELECT
        (SELECT count(*)::int FROM public.restroom_lock_secrets WHERE restroom_id::text LIKE '${prefix}%' OR id::text LIKE '${prefix}%' OR restroom_id::text LIKE 'fa230000-%') AS secrets_cnt,
        (SELECT count(*)::int FROM public.audit_logs WHERE actor_user_id::text LIKE '${prefix}%' OR entity_id::text LIKE '${prefix}%' OR actor_user_id::text LIKE 'fa230000-%') AS audits_cnt,
        (SELECT count(*)::int FROM public.restrooms WHERE id::text LIKE '${prefix}%' OR id::text LIKE 'fa230000-%') AS restrooms_cnt,
        (SELECT count(*)::int FROM public.businesses WHERE id::text LIKE '${prefix}%' OR id::text LIKE 'fa230000-%') AS biz_cnt,
        (SELECT count(*)::int FROM public.profiles WHERE id::text LIKE '${prefix}%' OR id::text LIKE 'fa230000-%') AS profiles_cnt,
        (SELECT count(*)::int FROM auth.users WHERE id::text LIKE '${prefix}%' OR id::text LIKE 'fa230000-%') AS users_cnt
    `);

    const r = residueRes.rows[0];
    console.log(`\n[6] Final Residue Verification across All Tables:`, r);
    for (const [k, v] of Object.entries(r)) {
      if (parseInt(v, 10) !== 0) {
        throw new Error(`Residue detected in ${k}: ${v}`);
      }
    }
    console.log(`  ✓ Verified: 0 test residue across all tables.`);

    console.log("\n================================================================================");
    console.log(">>> ALL TASK 23 REAL POSTGRESQL MULTI-CONNECTION CHECKS PASSED CLEANLY!");
    console.log("================================================================================");
  } finally {
    await Promise.all([connA.close(), connB.close()]);
  }
}

main().catch((err) => {
  console.error("FATAL ERROR in real PostgreSQL test:", err);
  process.exit(1);
});

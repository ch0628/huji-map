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
      this.socket = net.createConnection({ host: this.host, port: this.port }, () => {
        const params = ["user", this.user, "database", this.database, "client_encoding", "UTF8"];
        const bodyBuf = Buffer.from(params.join("\0") + "\0\0", "utf8");
        const buf = Buffer.alloc(8 + bodyBuf.length);
        buf.writeInt32BE(8 + bodyBuf.length, 0);
        buf.writeInt32BE(196608, 4);
        bodyBuf.copy(buf, 8);
        this.socket.write(buf);
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
    });
  }

  _sendPacket(typeChar, payloadBuf = Buffer.alloc(0)) {
    const buf = Buffer.alloc(5 + payloadBuf.length);
    buf.write(typeChar, 0, 1, "ascii");
    buf.writeInt32BE(4 + payloadBuf.length, 1);
    payloadBuf.copy(buf, 5);
    this.socket.write(buf);
  }

  _processBuffer() {
    while (this.buffer.length >= 5) {
      const type = String.fromCharCode(this.buffer[0]);
      const len = this.buffer.readInt32BE(1);
      const totalLen = 1 + len;
      if (this.buffer.length < totalLen) break;
      const payload = this.buffer.subarray(5, totalLen);
      this.buffer = this.buffer.subarray(totalLen);
      this._handlePacket(type, payload);
    }
  }

  _handlePacket(type, payload) {
    if (type === "R") {
      const authType = payload.readInt32BE(0);
      if (authType === 3) {
        this._sendPacket("p", Buffer.from(this.password + "\0", "utf8"));
      } else if (authType === 10) {
        const clientNonce = crypto.randomBytes(18).toString("base64");
        const clientFirstBare = `n=*,r=${clientNonce}`;
        const mechBuf = Buffer.from("SCRAM-SHA-256\0", "utf8");
        const dataBuf = Buffer.from(`n,,${clientFirstBare}`, "utf8");
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeInt32BE(dataBuf.length, 0);
        this.scramState = { clientNonce, clientFirstBare };
        this._sendPacket("p", Buffer.concat([mechBuf, lenBuf, dataBuf]));
      } else if (authType === 11) {
        const serverFirst = payload.subarray(4).toString("utf8");
        const parts = Object.fromEntries(serverFirst.split(",").map((kv) => [kv.slice(0, 1), kv.slice(2)]));
        const salt = Buffer.from(parts.s, "base64");
        const iter = parseInt(parts.i, 10);
        const clientFinalWithoutProof = `c=biws,r=${parts.r}`;
        const saltedPassword = crypto.pbkdf2Sync(this.password, salt, iter, 32, "sha256");
        const clientKey = crypto.createHmac("sha256", saltedPassword).update("Client Key").digest();
        const storedKey = crypto.createHash("sha256").update(clientKey).digest();
        const authMessage = `${this.scramState.clientFirstBare},${serverFirst},${clientFinalWithoutProof}`;
        const clientSig = crypto.createHmac("sha256", storedKey).update(authMessage).digest();
        const proof = Buffer.alloc(clientKey.length);
        for (let i = 0; i < clientKey.length; i++) proof[i] = clientKey[i] ^ clientSig[i];
        this._sendPacket("p", Buffer.from(`${clientFinalWithoutProof},p=${proof.toString("base64")}`, "utf8"));
      }
    } else if (type === "Z") {
      if (this.currentAction) {
        const action = this.currentAction;
        this.currentAction = null;
        if (action.type === "connect") action.resolve();
        else if (action.error) action.reject(action.error);
        else action.resolve({ rows: action.rows, commandTags: action.commandTags });
      }
    } else if (type === "T" && this.currentAction?.type === "query") {
      const colCount = payload.readInt16BE(0);
      let off = 2;
      const fields = [];
      for (let i = 0; i < colCount; i++) {
        const zero = payload.indexOf(0, off);
        const name = payload.toString("utf8", off, zero);
        off = zero + 1 + 18;
        fields.push(name);
      }
      this.currentAction.fields = fields;
    } else if (type === "D" && this.currentAction?.type === "query") {
      const colCount = payload.readInt16BE(0);
      let off = 2;
      const row = {};
      for (let i = 0; i < colCount; i++) {
        const len = payload.readInt32BE(off);
        off += 4;
        if (len === -1) row[this.currentAction.fields[i]] = null;
        else {
          row[this.currentAction.fields[i]] = payload.toString("utf8", off, off + len);
          off += len;
        }
      }
      this.currentAction.rows.push(row);
    } else if (type === "C" && this.currentAction?.type === "query") {
      this.currentAction.commandTags.push(payload.toString("utf8", 0, payload.length - 1));
    } else if (type === "E") {
      let off = 0;
      const info = {};
      while (off < payload.length && payload[off] !== 0) {
        const ft = String.fromCharCode(payload[off++]);
        const zero = payload.indexOf(0, off);
        info[ft] = payload.toString("utf8", off, zero);
        off = zero + 1;
      }
      const err = new Error(`[${this.name}] ${info.M} (code: ${info.C})`);
      err.code = info.C;
      if (this.currentAction) this.currentAction.error = err;
    } else if (type === "N") {
      let off = 0;
      const info = {};
      while (off < payload.length && payload[off] !== 0) {
        const ft = String.fromCharCode(payload[off++]);
        const zero = payload.indexOf(0, off);
        info[ft] = payload.toString("utf8", off, zero);
        off = zero + 1;
      }
      this.notices.push(info.M);
    }
  }

  query(sql) {
    return new Promise((resolve, reject) => {
      this.currentAction = { type: "query", rows: [], fields: [], commandTags: [], error: null, resolve, reject };
      this._sendPacket("Q", Buffer.from(sql + "\0", "utf8"));
    });
  }

  close() {
    if (this.socket && !this.socket.destroyed) {
      this._sendPacket("X");
      this.socket.end();
    }
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function run() {
  const connA = new PgWireClient({ name: "Conn-A" });
  const connB = new PgWireClient({ name: "Conn-B" });
  const connAdmin = new PgWireClient({ name: "Conn-Admin" });

  await Promise.all([connA.connect(), connB.connect(), connAdmin.connect()]);

  try {
    const pidA = (await connA.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const pidB = (await connB.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    assert(pidA !== pidB, "Expected distinct backend PIDs");
    console.log(`Connected to local PostgreSQL: Conn-A PID=${pidA}, Conn-B PID=${pidB}`);

    // 1. Apply the 2 TASK-06 SQL migrations cleanly onto local PG
    const m1 = fs.readFileSync(
      path.join(ROOT, "supabase/migrations/20261123000000_receipt_reject_resubmission_guard.sql"),
      "utf-8"
    );
    const m2 = fs.readFileSync(
      path.join(ROOT, "supabase/migrations/20261123010000_prevent_duplicate_restroom_policy.sql"),
      "utf-8"
    );
    await connAdmin.query(m1);
    await connAdmin.query(m2);
    console.log("✓ Applied 20261123000000 & 20261123010000 to local PostgreSQL.");

    // 2. Run rollback verification SQL
    const verifySql = fs.readFileSync(
      path.join(ROOT, "tests/integration/sql/verify_task06_migrations_rollback.sql"),
      "utf-8"
    );
    const verifyRes = await connAdmin.query(verifySql);
    assert(verifyRes.commandTags.includes("DO"), "Expected DO command tag");
    console.log("✓ Rollback verification SQL passed on local PostgreSQL (0 residue)!");

    // 3. Multi-connection concurrency test for create_merchant_restroom_policy
    const merchId = "f7000000-0000-4000-8000-000000000001";
    const bizId = "f7000000-0000-4000-8000-000000000010";
    const restId = "f7000000-0000-4000-8000-000000000020";

    const cleanupFixture = async () => {
      await connAdmin.query(`
        DELETE FROM public.restroom_access_policies WHERE restroom_id = '${restId}';
        DELETE FROM public.restrooms WHERE id = '${restId}';
        DELETE FROM public.business_members WHERE business_id = '${bizId}';
        DELETE FROM public.businesses WHERE id = '${bizId}';
        DELETE FROM public.user_roles WHERE user_id = '${merchId}';
        DELETE FROM public.profiles WHERE id = '${merchId}';
        DELETE FROM auth.users WHERE id = '${merchId}';
      `);
    };

    await cleanupFixture();

    await connAdmin.query(`
      INSERT INTO auth.users (id, email, raw_user_meta_data)
      VALUES ('${merchId}', 'task06_conc@test.local', '{"display_name":"동시성점주"}'::jsonb);
      INSERT INTO public.user_roles (user_id, role) VALUES ('${merchId}', 'merchant') ON CONFLICT DO NOTHING;
      INSERT INTO public.businesses (id, name, category, road_address, latitude, longitude, registration_status, created_by, approved_at)
      VALUES ('${bizId}', '동시성정책점포', '카페', '수원시 팔달구', 37.266, 127.001, 'approved', '${merchId}', now());
      INSERT INTO public.business_members (business_id, user_id, role, membership_status)
      VALUES ('${bizId}', '${merchId}', 'owner', 'active');
      INSERT INTO public.restrooms (id, business_id, name, type, access_method, road_address, latitude, longitude, publication_status)
      VALUES ('${restId}', '${bizId}', '동시성정책화장실', 'partner', 'pin', '수원시 팔달구', 37.266, 127.001, 'draft');
      INSERT INTO public.restroom_access_policies (restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, receipt_window_hours, min_purchase_krw, is_active, effective_from, created_by)
      VALUES ('${restId}', 1, 'test_deposit', 1000, true, 24, 0, true, now(), '${merchId}');
    `);

    const callPolicy = async (conn, deposit) => {
      try {
        await conn.query("BEGIN");
        await conn.query(`SELECT set_config('request.jwt.claim.sub', '${merchId}', true), set_config('request.jwt.claim.role', 'authenticated', true)`);
        const res = await conn.query(`SELECT version, deposit_amount_krw FROM public.create_merchant_restroom_policy('${restId}'::uuid, 'test_deposit', ${deposit}, true, 24, 0)`);
        await conn.query("COMMIT");
        return { ok: true, row: res.rows[0] };
      } catch (err) {
        await conn.query("ROLLBACK").catch(() => {});
        return { ok: false, code: err.code, message: err.message };
      }
    };

    try {
      const [rA, rB] = await Promise.all([callPolicy(connA, 2000), callPolicy(connB, 2000)]);
      const successes = [rA, rB].filter((r) => r.ok);
      const unchangedErrors = [rA, rB].filter((r) => !r.ok && r.code === "HM002");

      assert(successes.length === 1, `Expected exactly 1 success, got ${JSON.stringify([rA, rB])}`);
      assert(unchangedErrors.length === 1, `Expected exactly 1 HM002 rejection, got ${JSON.stringify([rA, rB])}`);
      assert(Number(successes[0].row.version) === 2, `Expected version 2, got ${JSON.stringify(successes[0])}`);
      console.log("✓ Concurrent duplicate policy update serialized cleanly: 1 created v2, 1 rejected HM002!");
    } finally {
      await cleanupFixture();
    }

    const resid = await connAdmin.query(`
      SELECT
        (SELECT count(*)::int FROM public.restrooms WHERE id = '${restId}') AS rest_cnt,
        (SELECT count(*)::int FROM auth.users WHERE id = '${merchId}') AS user_cnt;
    `);
    assert(Number(resid.rows[0].rest_cnt) === 0 && Number(resid.rows[0].user_cnt) === 0, "Residual rows found");
    console.log("✓ Cleanup complete: 0 residual rows.");
  } finally {
    connA.close();
    connB.close();
    connAdmin.close();
  }
}

run().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});

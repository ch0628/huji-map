import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Load .env.local
const envFile = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envFile)) {
  const lines = fs.readFileSync(envFile, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [k, ...v] = trimmed.split("=");
    if (k && !process.env[k.trim()]) {
      process.env[k.trim()] = v.join("=").trim();
    }
  }
}

const PORT = 3899;
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function waitForServer(url, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/v1/restrooms?bbox=invalid`);
      if (res.status === 400) {
        return;
      }
    } catch {
      // wait
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

async function main() {
  console.log("=== TASK 10 실제 DB 연결 Smoke Test 시작 ===");
  console.log(`Supabase URL configured: ${Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL)}`);
  console.log(`Supabase Key configured: ${Boolean(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)}`);

  // Start Next.js production server
  const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });

  server.stdout.on("data", () => {
    // Suppress verbose output
  });

  server.stderr.on("data", (data) => {
    const msg = data.toString();
    if (!msg.includes("ExperimentalWarning")) {
      console.error(`[Next.js Server Error]: ${msg.trim()}`);
    }
  });

  try {
    await waitForServer(BASE_URL);
    console.log(`Next.js 서버 기동 완료 (${BASE_URL})`);

    const results = [];

    // Test 1: GET /api/v1/restrooms?bbox=37.28,127.01,37.30,127.03 (유효 bbox)
    {
      const res = await fetch(`${BASE_URL}/api/v1/restrooms?bbox=37.28,127.01,37.30,127.03`);
      const status = res.status;
      const json = await res.json();
      const pass = status === 200 && json.ok === true && Array.isArray(json.data?.items) && typeof json.data?.total === "number";
      results.push({
        test: "GET /api/v1/restrooms (유효 bbox)",
        status,
        expectedStatus: 200,
        pass,
        dataSummary: `items: ${json.data?.items?.length ?? 0}, total: ${json.data?.total ?? 0}`,
        error: json.error,
      });
      console.log(`1. 유효 bbox 조회: status=${status}, pass=${pass}, items=${json.data?.items?.length ?? 0}, total=${json.data?.total ?? 0}`);
    }

    // Test 2: GET /api/v1/restrooms?bbox=invalid (잘못된 bbox)
    {
      const res = await fetch(`${BASE_URL}/api/v1/restrooms?bbox=invalid`);
      const status = res.status;
      const json = await res.json();
      const pass = status === 400 && json.ok === false && json.error?.code === "VALIDATION_ERROR";
      results.push({
        test: "GET /api/v1/restrooms (잘못된 bbox 400)",
        status,
        expectedStatus: 400,
        pass,
        error: json.error,
      });
      console.log(`2. 잘못된 bbox: status=${status}, pass=${pass}, code=${json.error?.code}`);
    }

    // Test 3: GET /api/v1/restrooms/00000000-0000-4000-8000-000000000001 (미존재 UUID 404)
    {
      const fakeUuid = "00000000-0000-4000-8000-000000000001";
      const res = await fetch(`${BASE_URL}/api/v1/restrooms/${fakeUuid}`);
      const status = res.status;
      const json = await res.json();
      const pass = status === 404 && json.ok === false && json.error?.code === "RESTROOM_NOT_FOUND";
      results.push({
        test: "GET /api/v1/restrooms/[id] (미존재 UUID 404)",
        status,
        expectedStatus: 404,
        pass,
        error: json.error,
      });
      console.log(`3. 미존재 화장실 UUID: status=${status}, pass=${pass}, code=${json.error?.code}`);
    }

    // Test 4: GET /api/v1/businesses/00000000-0000-4000-8000-000000000001 (미존재 UUID 404)
    {
      const fakeUuid = "00000000-0000-4000-8000-000000000001";
      const res = await fetch(`${BASE_URL}/api/v1/businesses/${fakeUuid}`);
      const status = res.status;
      const json = await res.json();
      const pass = status === 404 && json.ok === false && json.error?.code === "BUSINESS_NOT_FOUND";
      results.push({
        test: "GET /api/v1/businesses/[id] (미존재 UUID 404)",
        status,
        expectedStatus: 404,
        pass,
        error: json.error,
      });
      console.log(`4. 미존재 가게 UUID: status=${status}, pass=${pass}, code=${json.error?.code}`);
    }

    const allPassed = results.every((r) => r.pass);
    console.log(`=== 검증 결과: ${allPassed ? "전원 PASS" : "일부 FAIL"} ===`);

    if (!allPassed) {
      console.error(JSON.stringify(results, null, 2));
      process.exit(1);
    }
  } finally {
    server.kill();
    // On Windows, child process might need taskkill
    try {
      if (server.pid) {
        spawn("taskkill", ["/pid", String(server.pid), "/f", "/t"], { shell: true });
      }
    } catch {
      // ignore
    }
  }
}

main().catch((err) => {
  console.error("스모크 테스트 실행 중 오류:", err.message);
  process.exit(1);
});

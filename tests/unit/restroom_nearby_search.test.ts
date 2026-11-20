import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { haversineMeters } from "@/lib/maps/geo";
import { catalogQuerySchema, listPublicRestrooms } from "@/lib/restrooms";
import { GET as restroomsGet } from "@/app/api/v1/restrooms/route";
import * as authLib from "@/lib/auth";
import * as serverSupabase from "@/lib/supabase/server";

const CENTER = { lat: 37.2635727, lng: 127.0286009 };
const EARTH_RADIUS_M = 6371000;

/** Move strictly north from CENTER by `meters` using spherical earth radius matching DB/client Haversine */
function pointNorthMeters(meters: number): { lat: number; lng: number } {
  const deltaLatDeg = (meters / EARTH_RADIUS_M) * (180 / Math.PI);
  return {
    lat: CENTER.lat + deltaLatDeg,
    lng: CENTER.lng,
  };
}

/** Move along a given bearing (deg) by `meters` */
function pointAtMetersAndBearing(
  meters: number,
  bearingDeg: number
): { lat: number; lng: number } {
  const rad = (bearingDeg * Math.PI) / 180;
  const dNorth = meters * Math.cos(rad);
  const dEast = meters * Math.sin(rad);
  const lat = CENTER.lat + (dNorth / EARTH_RADIUS_M) * (180 / Math.PI);
  const lng =
    CENTER.lng +
    (dEast / (EARTH_RADIUS_M * Math.cos((CENTER.lat * Math.PI) / 180))) *
      (180 / Math.PI);
  return { lat, lng };
}

function makeUuid(prefixHex: string, index: number): string {
  const tail = index.toString(16).padStart(12, "0");
  return `${prefixHex}-0000-4000-8000-${tail}`;
}

/**
 * Minimal Supabase-compatible wrapper backed by PGlite so `listPublicRestrooms`
 * and `GET /api/v1/restrooms` execute real PostgreSQL queries, RLS, and RPCs.
 */
function createPgliteSupabaseAdapter(
  db: PGlite,
  role: "anon" | "authenticated" | "service_role" = "anon",
  userId?: string
) {
  async function withRole<T>(fn: () => Promise<T>): Promise<T> {
    await db.exec(`RESET ROLE; SET ROLE ${role};`);
    if (role === "authenticated" && userId) {
      await db.exec(
        `SET request.jwt.claim.sub = '${userId}'; SET request.jwt.claim.role = 'authenticated';`
      );
    } else if (role === "service_role") {
      await db.exec(
        `SET request.jwt.claim.sub = ''; SET request.jwt.claim.role = 'service_role';`
      );
    } else {
      await db.exec(
        `SET request.jwt.claim.sub = ''; SET request.jwt.claim.role = 'anon';`
      );
    }
    try {
      return await fn();
    } finally {
      await db.exec(`RESET ROLE;`);
    }
  }

  return {
    rpc: vi.fn(async (fnName: string, params: Record<string, any>) => {
      if (fnName !== "list_nearby_public_restrooms") {
        throw new Error(`Unexpected RPC: ${fnName}`);
      }
      return withRole(async () => {
        try {
          const res = await db.query(
            `SELECT * FROM public.list_nearby_public_restrooms($1::double precision, $2::double precision, $3::integer, $4::text, $5::integer, $6::integer)`,
            [
              params.p_center_lat,
              params.p_center_lng,
              params.p_radius_m,
              params.p_type,
              params.p_limit,
              params.p_offset,
            ]
          );
          return { data: res.rows, error: null };
        } catch (error: any) {
          return { data: null, error };
        }
      });
    }),
    from: vi.fn((table: string) => {
      const filters: Array<{ op: string; col: string; val: any }> = [];
      const chain: any = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn((col: string, val: any) => {
          filters.push({ op: "eq", col, val });
          return chain;
        }),
        in: vi.fn((col: string, val: any[]) => {
          filters.push({ op: "in", col, val });
          return chain;
        }),
        maybeSingle: vi.fn(async () => {
          return withRole(async () => {
            if (table === "feature_flags") {
              const keyFilter = filters.find((f) => f.col === "key")?.val;
              const res = await db.query(
                `SELECT enabled FROM public.feature_flags WHERE key = $1 LIMIT 1`,
                [keyFilter]
              );
              return { data: res.rows[0] ?? null, error: null };
            }
            return { data: null, error: null };
          });
        }),
        then: (resolve: any, reject: any) => {
          return withRole(async () => {
            if (table === "businesses") {
              const ids = filters.find((f) => f.op === "in" && f.col === "id")?.val ?? [];
              if (ids.length === 0) return { data: [], error: null };
              const res = await db.query(
                `SELECT id, name, registration_status FROM public.businesses WHERE id = ANY($1::uuid[]) AND registration_status = 'approved'`,
                [ids]
              );
              return { data: res.rows, error: null };
            }
            if (table === "restroom_access_policies") {
              const ids =
                filters.find((f) => f.op === "in" && f.col === "restroom_id")
                  ?.val ?? [];
              if (ids.length === 0) return { data: [], error: null };
              const res = await db.query(
                `SELECT restroom_id, access_mode, deposit_amount_krw FROM public.restroom_access_policies WHERE restroom_id = ANY($1::uuid[]) AND is_active = true`,
                [ids]
              );
              return { data: res.rows, error: null };
            }
            if (table === "restroom_photos") {
              const ids =
                filters.find((f) => f.op === "in" && f.col === "restroom_id")
                  ?.val ?? [];
              if (ids.length === 0) return { data: [], error: null };
              const res = await db.query(
                `SELECT restroom_id, storage_path FROM public.restroom_photos WHERE restroom_id = ANY($1::uuid[]) AND moderation_status = 'approved' AND is_primary = true`,
                [ids]
              );
              return { data: res.rows, error: null };
            }
            return { data: [], error: null };
          }).then(resolve, reject);
        },
      };
      return chain;
    }),
  } as any;
}

describe("STEP 3 — Nearby 400m Distance-Sorted Restroom Query (PGlite + API)", () => {
  let db: PGlite;

  const sourceId = "10000000-0000-4000-8000-000000000001";
  const adminUid = "20000000-0000-4000-8000-000000000001";
  const customerUid = "20000000-0000-4000-8000-000000000002";
  const approvedBizId = "30000000-0000-4000-8000-000000000001";
  const pendingBizId = "30000000-0000-4000-8000-000000000002";
  const suspendedBizId = "30000000-0000-4000-8000-000000000003";

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
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin; END IF;
      END $$;
      GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;
    `);

    const root = process.cwd();
    const migrations = [
      "20261106000000_auth_schema.sql",
      "20261107000000_lead_tracking.sql",
      "20261108000000_business_backend.sql",
      "20261109000000_audit_and_approval.sql",
      "20261110000000_restroom_schema.sql",
      "20261120000000_restroom_nearby_search_rpc.sql",
    ];
    for (const file of migrations) {
      const sql = fs.readFileSync(
        path.join(root, "supabase/migrations", file),
        "utf8"
      );
      await db.exec(sql);
    }

    // Match Supabase default schema/table privileges for anon & authenticated in PGlite
    await db.exec(`
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      GRANT SELECT ON public.feature_flags TO anon, authenticated, service_role;
    `);

    await db.exec(`
      INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        ('${adminUid}', 'admin@test.local', '{"name":"Admin"}'::jsonb),
        ('${customerUid}', 'customer@test.local', '{"name":"Customer"}'::jsonb);
      INSERT INTO public.user_roles (user_id, role) VALUES ('${adminUid}', 'admin');

      INSERT INTO public.public_data_sources (id, provider_name, dataset_name, source_url)
      VALUES ('${sourceId}', 'DEMO 수원시', 'DEMO 공중화장실', 'https://example.test');

      INSERT INTO public.businesses (id, name, category, registration_status, road_address, latitude, longitude, created_by, approved_by, approved_at)
      VALUES
        ('${approvedBizId}', 'DEMO 승인 카페', '카페', 'approved', '수원시 팔달구 1', ${CENTER.lat}, ${CENTER.lng}, '${adminUid}', '${adminUid}', now()),
        ('${pendingBizId}', 'DEMO 심사중 카페', '카페', 'pending', '수원시 팔달구 2', ${CENTER.lat}, ${CENTER.lng}, '${adminUid}', NULL, NULL),
        ('${suspendedBizId}', 'DEMO 정지 카페', '카페', 'suspended', '수원시 팔달구 3', ${CENTER.lat}, ${CENTER.lng}, '${adminUid}', '${adminUid}', now());
    `);
  }, 30000);

  afterAll(async () => {
    if (db) await db.close();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    // Isolate PGlite tests from .env.local Supabase credentials so resolveBusinessClient
    // never queries a real Supabase instance when isServiceRoleConfigured() is true.
    vi.spyOn(serverSupabase, "createAdminClient").mockImplementation(() =>
      createPgliteSupabaseAdapter(db, "service_role")
    );
    await db.exec(`
      RESET ROLE;
      DELETE FROM public.restrooms;
      UPDATE public.feature_flags
      SET enabled = true
      WHERE key = 'partner_restroom_discovery';
    `);
  });

  async function insertPublicRestroom(opts: {
    id: string;
    name: string;
    lat: number;
    lng: number;
    status?: string;
  }) {
    await db.query(
      `INSERT INTO public.restrooms (
        id, source_id, source_record_id, type, name, road_address, latitude, longitude, publication_status
      ) VALUES ($1, $2, $3, 'public', $4, 'DEMO 도로명주소', $5, $6, $7)`,
      [
        opts.id,
        sourceId,
        `REC-${opts.id}`,
        opts.name,
        opts.lat,
        opts.lng,
        opts.status ?? "published",
      ]
    );
  }

  async function insertPartnerRestroom(opts: {
    id: string;
    businessId: string;
    name: string;
    lat: number;
    lng: number;
    status?: string;
  }) {
    await db.query(
      `INSERT INTO public.restrooms (
        id, business_id, type, name, road_address, latitude, longitude, access_method, publication_status
      ) VALUES ($1, $2, 'partner', $3, 'DEMO 제휴 도로명주소', $4, $5, 'pin', $6)`,
      [
        opts.id,
        opts.businessId,
        opts.name,
        opts.lat,
        opts.lng,
        opts.status ?? "published",
      ]
    );
  }

  it("1. 300m 이내 0건일 때 빈 배열과 total=0을 반환한다", async () => {
    const client = createPgliteSupabaseAdapter(db, "anon");
    const res = await listPublicRestrooms(client, {
      centerLat: CENTER.lat,
      centerLng: CENTER.lng,
      radiusM: 400,
      type: "all",
      limit: 100,
      offset: 0,
    });
    expect(res.items).toEqual([]);
    expect(res.total).toBe(0);
  });

  it("2. 300m 이내 99건만 있으면 99건 전체를 거리 오름차순으로 반환한다", async () => {
    for (let i = 1; i <= 99; i++) {
      const dist = 3 * i; // 3m ~ 297m
      const pt = pointNorthMeters(dist);
      await insertPublicRestroom({
        id: makeUuid("aa000001", 200 - i), // reverse UUID order vs distance
        name: `DEMO 300m-${i}`,
        lat: pt.lat,
        lng: pt.lng,
      });
    }

    const client = createPgliteSupabaseAdapter(db, "anon");
    const res = await listPublicRestrooms(client, {
      centerLat: CENTER.lat,
      centerLng: CENTER.lng,
      radiusM: 400,
      type: "all",
      limit: 100,
      offset: 0,
    });

    expect(res.items).toHaveLength(99);
    expect(res.total).toBe(99);
    for (let i = 1; i < res.items.length; i++) {
      expect(res.items[i].distance_meters!).toBeGreaterThanOrEqual(
        res.items[i - 1].distance_meters!
      );
    }
  });

  it("3. 300m 이내 100건 + 300~400m 추가 화장실이 있으면 300m 이내 100건만 반환한다", async () => {
    for (let i = 1; i <= 100; i++) {
      const pt = pointNorthMeters(2.9 * i); // 2.9m ~ 290m
      await insertPublicRestroom({
        id: makeUuid("aa000002", 500 - i),
        name: `DEMO inside300-${i}`,
        lat: pt.lat,
        lng: pt.lng,
      });
    }
    const pt350 = pointNorthMeters(350);
    const id350 = makeUuid("00000000", 1); // intentionally smallest UUID!
    await insertPublicRestroom({
      id: id350,
      name: "DEMO outside300-inside400",
      lat: pt350.lat,
      lng: pt350.lng,
    });

    const client = createPgliteSupabaseAdapter(db, "anon");
    const res = await listPublicRestrooms(client, {
      centerLat: CENTER.lat,
      centerLng: CENTER.lng,
      radiusM: 400,
      type: "all",
      limit: 100,
      offset: 0,
    });

    expect(res.items).toHaveLength(100);
    expect(res.total).toBe(101);
    expect(res.items.some((x) => x.id === id350)).toBe(false);
    expect(Math.max(...res.items.map((x) => x.distance_meters!))).toBeLessThanOrEqual(300);
  });

  it("4. 300m 이내 101건일 때 가장 가까운 100건만 반환하며 UUID순 누락이 없다", async () => {
    // 101st farthest item (299m) given smallest UUID "00000000-..."
    const farthestId = makeUuid("00000000", 1);
    const pt299 = pointNorthMeters(299);
    await insertPublicRestroom({
      id: farthestId,
      name: "DEMO 299m-farthest",
      lat: pt299.lat,
      lng: pt299.lng,
    });

    // 100 closer items (1m ~ 200m) given largest UUIDs "ffffffff-..."
    const closestId = makeUuid("ffffffff", 999);
    for (let i = 1; i <= 100; i++) {
      const pt = pointNorthMeters(i === 1 ? 1 : 2 * i);
      await insertPublicRestroom({
        id: i === 1 ? closestId : makeUuid("ffffffff", i),
        name: `DEMO closer-${i}`,
        lat: pt.lat,
        lng: pt.lng,
      });
    }

    const client = createPgliteSupabaseAdapter(db, "anon");
    const res = await listPublicRestrooms(client, {
      centerLat: CENTER.lat,
      centerLng: CENTER.lng,
      radiusM: 400,
      type: "all",
      limit: 100,
      offset: 0,
    });

    expect(res.items).toHaveLength(100);
    expect(res.total).toBe(101);
    expect(res.items[0].id).toBe(closestId);
    expect(res.items.some((x) => x.id === farthestId)).toBe(false);
  });

  it("5. 300m 이내 100건 미만이면 300~400m 구간을 거리순으로 추가한다 (총 100건 이상/미만 모두 검증)", async () => {
    // Case A: 50 inside 300m + 70 in 300~400m => 100 returned, total = 120
    for (let i = 1; i <= 50; i++) {
      const pt = pointNorthMeters(5 * i); // 5m ~ 250m
      await insertPublicRestroom({
        id: makeUuid("aa000003", i),
        name: `DEMO 300m-${i}`,
        lat: pt.lat,
        lng: pt.lng,
      });
    }
    for (let i = 1; i <= 70; i++) {
      const pt = pointNorthMeters(305 + i); // 306m ~ 375m
      await insertPublicRestroom({
        id: makeUuid("bb000003", 1000 - i),
        name: `DEMO 300to400-${i}`,
        lat: pt.lat,
        lng: pt.lng,
      });
    }

    const client = createPgliteSupabaseAdapter(db, "anon");
    const resA = await listPublicRestrooms(client, {
      centerLat: CENTER.lat,
      centerLng: CENTER.lng,
      radiusM: 400,
      type: "all",
      limit: 100,
      offset: 0,
    });

    expect(resA.items).toHaveLength(100);
    expect(resA.total).toBe(120);
    expect(resA.items[49].distance_meters!).toBeLessThanOrEqual(300);
    expect(resA.items[50].distance_meters!).toBeGreaterThan(300);
    expect(resA.items[99].distance_meters!).toBeLessThanOrEqual(356);

    // Case B: < 100 total within 400m (e.g. 10 in 300m + 5 in 300~400m => 15 returned)
    await db.exec(`DELETE FROM public.restrooms;`);
    for (let i = 1; i <= 10; i++) {
      const pt = pointNorthMeters(20 * i);
      await insertPublicRestroom({
        id: makeUuid("cc000003", i),
        name: `DEMO small300-${i}`,
        lat: pt.lat,
        lng: pt.lng,
      });
    }
    for (let i = 1; i <= 5; i++) {
      const pt = pointNorthMeters(310 + 15 * i);
      await insertPublicRestroom({
        id: makeUuid("dd000003", i),
        name: `DEMO small400-${i}`,
        lat: pt.lat,
        lng: pt.lng,
      });
    }

    const resB = await listPublicRestrooms(client, {
      centerLat: CENTER.lat,
      centerLng: CENTER.lng,
      radiusM: 400,
      type: "all",
      limit: 100,
      offset: 0,
    });
    expect(resB.items).toHaveLength(15);
    expect(resB.total).toBe(15);
  });

  it("6. 정확히 400m 경계는 포함하고 400m 밖의 화장실은 제외한다", async () => {
    // 399.99m point (strictly inside/at 400m without float overshoot) & 400.1m outside
    const ptExact400 = pointNorthMeters(399.999);
    const actual400Dist = haversineMeters(CENTER, ptExact400);
    expect(actual400Dist).toBeLessThanOrEqual(400);

    const ptOutside401 = pointNorthMeters(400.5);
    const actual401Dist = haversineMeters(CENTER, ptOutside401);
    expect(actual401Dist).toBeGreaterThan(400);

    const ptCornerBBoxOutsideCircle = pointAtMetersAndBearing(420, 45);
    expect(haversineMeters(CENTER, ptCornerBBoxOutsideCircle)).toBeGreaterThan(400);

    const idBoundary = makeUuid("ee000001", 1);
    const idOutside = makeUuid("ee000001", 2);
    const idCornerOutside = makeUuid("ee000001", 3);

    await insertPublicRestroom({
      id: idBoundary,
      name: "DEMO boundary-400m",
      lat: ptExact400.lat,
      lng: ptExact400.lng,
    });
    await insertPublicRestroom({
      id: idOutside,
      name: "DEMO outside-400.5m",
      lat: ptOutside401.lat,
      lng: ptOutside401.lng,
    });
    await insertPublicRestroom({
      id: idCornerOutside,
      name: "DEMO bbox-corner-420m",
      lat: ptCornerBBoxOutsideCircle.lat,
      lng: ptCornerBBoxOutsideCircle.lng,
    });

    const client = createPgliteSupabaseAdapter(db, "anon");
    const res = await listPublicRestrooms(client, {
      centerLat: CENTER.lat,
      centerLng: CENTER.lng,
      radiusM: 400,
      type: "all",
      limit: 100,
      offset: 0,
    });

    expect(res.items.map((x) => x.id)).toEqual([idBoundary]);
    expect(res.total).toBe(1);
  });

  it("7. 미승인/정지 제휴 화장실, 비공개 화장실, 플래그 비활성 시 제휴 화장실을 정렬·LIMIT 전에 제외한다", async () => {
    // Place invalid/unapproved restrooms right at center (0m) so they would steal slots if filtered late
    const unapprovedPartnerId = makeUuid("00000001", 1);
    const suspendedPartnerId = makeUuid("00000001", 2);
    const draftPublicId = makeUuid("00000001", 3);
    const approvedPartnerId = makeUuid("00000001", 4);

    await insertPartnerRestroom({
      id: unapprovedPartnerId,
      businessId: pendingBizId,
      name: "DEMO 미승인 점포 화장실",
      lat: CENTER.lat,
      lng: CENTER.lng,
      status: "published",
    });
    await insertPartnerRestroom({
      id: suspendedPartnerId,
      businessId: suspendedBizId,
      name: "DEMO 정지 점포 화장실",
      lat: CENTER.lat,
      lng: CENTER.lng,
      status: "published",
    });
    await insertPublicRestroom({
      id: draftPublicId,
      name: "DEMO 비공개 공공 화장실",
      lat: CENTER.lat,
      lng: CENTER.lng,
      status: "draft",
    });
    await insertPartnerRestroom({
      id: approvedPartnerId,
      businessId: approvedBizId,
      name: "DEMO 승인 제휴 화장실",
      lat: CENTER.lat,
      lng: CENTER.lng,
      status: "published",
    });

    // Add 100 valid public restrooms at 50m..250m
    for (let i = 1; i <= 100; i++) {
      const pt = pointNorthMeters(50 + i * 2);
      await insertPublicRestroom({
        id: makeUuid("aa000005", i),
        name: `DEMO valid-${i}`,
        lat: pt.lat,
        lng: pt.lng,
      });
    }

    // Even as authenticated user, draft/pending/suspended must be excluded BEFORE LIMIT 100
    const authClient = createPgliteSupabaseAdapter(db, "authenticated", adminUid);
    const bizClient = createPgliteSupabaseAdapter(db, "service_role");
    const resOn = await listPublicRestrooms(
      authClient,
      {
        centerLat: CENTER.lat,
        centerLng: CENTER.lng,
        radiusM: 400,
        type: "all",
        limit: 100,
        offset: 0,
      },
      { businessClient: bizClient }
    );

    expect(resOn.items).toHaveLength(100);
    expect(resOn.total).toBe(101);
    expect(resOn.items[0].id).toBe(approvedPartnerId);
    expect(resOn.items[0].business_name).toBe("DEMO 승인 카페");
    expect(resOn.items.some((x) => x.id === unapprovedPartnerId)).toBe(false);
    expect(resOn.items.some((x) => x.id === suspendedPartnerId)).toBe(false);
    expect(resOn.items.some((x) => x.id === draftPublicId)).toBe(false);

    // When partner_restroom_discovery flag is disabled in DB, partner restroom is excluded too
    await db.exec(
      `UPDATE public.feature_flags SET enabled = false WHERE key = 'partner_restroom_discovery';`
    );
    const anonClient = createPgliteSupabaseAdapter(db, "anon");
    const resOff = await listPublicRestrooms(
      anonClient,
      {
        centerLat: CENTER.lat,
        centerLng: CENTER.lng,
        radiusM: 400,
        type: "all",
        limit: 100,
        offset: 0,
      },
      { businessClient: bizClient }
    );
    expect(resOff.items).toHaveLength(100);
    expect(resOff.total).toBe(100);
    expect(resOff.items.some((x) => x.id === approvedPartnerId)).toBe(false);
  });

  it("8. 동일 거리 결과에 대해 id 오름차순으로 안정적인 2차 정렬을 보장한다", async () => {
    const ptSame = pointNorthMeters(120);
    const idC = "cccccccc-0000-4000-8000-000000000003";
    const idA = "aaaaaaaa-0000-4000-8000-000000000001";
    const idB = "bbbbbbbb-0000-4000-8000-000000000002";

    // Insert out of UUID order
    await insertPublicRestroom({ id: idC, name: "DEMO C", lat: ptSame.lat, lng: ptSame.lng });
    await insertPublicRestroom({ id: idA, name: "DEMO A", lat: ptSame.lat, lng: ptSame.lng });
    await insertPublicRestroom({ id: idB, name: "DEMO B", lat: ptSame.lat, lng: ptSame.lng });

    const client = createPgliteSupabaseAdapter(db, "anon");
    const res1 = await listPublicRestrooms(client, {
      centerLat: CENTER.lat,
      centerLng: CENTER.lng,
      radiusM: 400,
      type: "all",
      limit: 100,
      offset: 0,
    });
    const res2 = await listPublicRestrooms(client, {
      centerLat: CENTER.lat,
      centerLng: CENTER.lng,
      radiusM: 400,
      type: "all",
      limit: 100,
      offset: 0,
    });

    expect(res1.items.map((x) => x.id)).toEqual([idA, idB, idC]);
    expect(res2.items.map((x) => x.id)).toEqual([idA, idB, idC]);
  });

  it("9. GET /api/v1/restrooms 라우트가 centerLat/centerLng 요청과 기존 bbox 계약을 모두 처리한다", async () => {
    vi.spyOn(authLib, "isSupabaseAuthConfigured").mockReturnValue(true);
    vi.spyOn(serverSupabase, "isServiceRoleConfigured").mockReturnValue(false);

    const pt1 = pointNorthMeters(50);
    const id1 = makeUuid("ab000001", 1);
    await insertPublicRestroom({
      id: id1,
      name: "DEMO 라우트 테스트 화장실",
      lat: pt1.lat,
      lng: pt1.lng,
    });

    const adapter = createPgliteSupabaseAdapter(db, "anon");
    vi.spyOn(serverSupabase, "createServerClientInstance").mockResolvedValue(adapter);

    const res = await restroomsGet(
      new Request(
        `http://localhost/api/v1/restrooms?centerLat=${CENTER.lat}&centerLng=${CENTER.lng}&type=all`
      )
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.items).toHaveLength(1);
    expect(json.data.items[0].id).toBe(id1);
    expect(json.data.items[0].distance_meters).toBeGreaterThan(45);
    expect(json.data.items[0].distance_meters).toBeLessThan(55);
    expect(json.data.limit).toBe(100);
    expect(json.data.total).toBe(1);

    // Invalid partial center coordinates -> 400
    const badRes = await restroomsGet(
      new Request(`http://localhost/api/v1/restrooms?centerLat=${CENTER.lat}`)
    );
    expect(badRes.status).toBe(400);
  });

  it("10. EXPLAIN 검증: PGlite 기본 실행계획과 enable_seqscan=off 강제 인덱스 계획을 구분 확인한다", async () => {
    // Seed 300 published rows spread across Suwon area so publication_status='published' has low selectivity
    // while the 400m coordinate BBox has high selectivity.
    for (let i = 1; i <= 300; i++) {
      const lat = 37.20 + (i % 30) * 0.005;
      const lng = 126.92 + Math.floor(i / 30) * 0.02;
      await insertPublicRestroom({
        id: makeUuid("ef000001", i),
        name: `DEMO spread-${i}`,
        lat,
        lng,
      });
    }
    const ptIn = pointNorthMeters(100);
    await insertPublicRestroom({
      id: makeUuid("ef000002", 1),
      name: "DEMO index-target",
      lat: ptIn.lat,
      lng: ptIn.lng,
    });
    await db.exec(`ANALYZE public.restrooms;`);

    const explainSql = `EXPLAIN (FORMAT TEXT)
      SELECT r.id
      FROM public.restrooms r
      WHERE r.publication_status = 'published'
        AND r.latitude IS NOT NULL
        AND r.longitude IS NOT NULL
        AND r.latitude >= $1::double precision
        AND r.latitude <= $2::double precision
        AND r.longitude >= $3::double precision
        AND r.longitude <= $4::double precision`;
    const explainParams = [
      CENTER.lat - 0.004,
      CENTER.lat + 0.004,
      CENTER.lng - 0.005,
      CENTER.lng + 0.005,
    ];

    // 1) Default planner (enable_seqscan = on)
    const defaultExplain: any = await db.query(explainSql, explainParams);
    const defaultPlan = defaultExplain.rows
      .map((r: any) => Object.values(r)[0])
      .join("\n");
    expect(defaultPlan).toContain("idx_restrooms_coords");

    // 2) Forced index plan (enable_seqscan = off)
    await db.exec(`SET enable_seqscan = off;`);
    try {
      const forcedExplain: any = await db.query(explainSql, explainParams);
      const forcedPlan = forcedExplain.rows
        .map((r: any) => Object.values(r)[0])
        .join("\n");
      expect(forcedPlan).toContain("idx_restrooms_coords");
    } finally {
      await db.exec(`SET enable_seqscan = on;`);
    }
  });

  it("11. RPC 다중 페이지 조회 시 미승인 제휴 화장실이 있어도 모든 페이지의 total이 정확히 일치한다", async () => {
    // 3 valid (10m, 20m, 30m) + 2 invalid partner (5m pending, 15m suspended)
    await insertPartnerRestroom({
      id: makeUuid("f1000001", 1),
      businessId: pendingBizId,
      name: "DEMO pending-5m",
      ...pointNorthMeters(5),
    });
    await insertPublicRestroom({
      id: makeUuid("f1000001", 2),
      name: "DEMO public-10m",
      ...pointNorthMeters(10),
    });
    await insertPartnerRestroom({
      id: makeUuid("f1000001", 3),
      businessId: suspendedBizId,
      name: "DEMO suspended-15m",
      ...pointNorthMeters(15),
    });
    await insertPublicRestroom({
      id: makeUuid("f1000001", 4),
      name: "DEMO public-20m",
      ...pointNorthMeters(20),
    });
    await insertPartnerRestroom({
      id: makeUuid("f1000001", 5),
      businessId: approvedBizId,
      name: "DEMO approved-30m",
      ...pointNorthMeters(30),
    });

    const client = createPgliteSupabaseAdapter(db, "anon");
    const bizClient = createPgliteSupabaseAdapter(db, "service_role");
    const page1 = await listPublicRestrooms(
      client,
      {
        centerLat: CENTER.lat,
        centerLng: CENTER.lng,
        radiusM: 400,
        type: "all",
        limit: 2,
        offset: 0,
      },
      { businessClient: bizClient }
    );
    const page2 = await listPublicRestrooms(
      client,
      {
        centerLat: CENTER.lat,
        centerLng: CENTER.lng,
        radiusM: 400,
        type: "all",
        limit: 2,
        offset: 2,
      },
      { businessClient: bizClient }
    );

    expect(page1.items.map((x) => x.name)).toEqual(["DEMO public-10m", "DEMO public-20m"]);
    expect(page1.total).toBe(3);
    expect(page2.items.map((x) => x.name)).toEqual(["DEMO approved-30m"]);
    expect(page2.total).toBe(3);
  });
});

describe("STEP 3 — catalogQuerySchema 중심 좌표 파라미터 검증", () => {
  it("centerLat/centerLng만 전달 시 bbox 없이 통과하고 기본 limit=100, radiusM=400을 적용한다", () => {
    const parsed = catalogQuerySchema.safeParse({
      centerLat: String(CENTER.lat),
      centerLng: String(CENTER.lng),
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.centerLat).toBe(CENTER.lat);
      expect(parsed.data.centerLng).toBe(CENTER.lng);
      expect(parsed.data.radiusM).toBe(400);
      expect(parsed.data.limit).toBe(100);
      expect(parsed.data.offset).toBe(0);
    }
  });

  it("centerLat만 있거나 빈 문자열이면 400 검증 실패한다", () => {
    expect(
      catalogQuerySchema.safeParse({ centerLat: String(CENTER.lat) }).success
    ).toBe(false);
    expect(
      catalogQuerySchema.safeParse({ centerLat: "", centerLng: "127.02" }).success
    ).toBe(false);
    expect(
      catalogQuerySchema.safeParse({
        centerLat: "37.26",
        centerLng: "127.02",
        radiusM: "500",
      }).success
    ).toBe(false);
  });
});

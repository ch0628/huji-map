import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  createRestroomSchema,
  updateRestroomSchema,
  restroomHourSchema,
  restroomHourExceptionSchema,
  restroomAccessPolicySchema,
  restroomPhotoSchema,
} from "@/lib/restrooms";

describe("TASK 09 — Restroom Schema Static Verification", () => {
  const migrationPath = path.resolve(
    process.cwd(),
    "supabase/migrations/20261110000000_restroom_schema.sql"
  );

  it("01. migration file exists and contains expected tables", () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = fs.readFileSync(migrationPath, "utf-8");

    const expectedTables = [
      "public.public_data_sources",
      "public.public_import_runs",
      "public.restrooms",
      "public.restroom_hours",
      "public.restroom_hour_exceptions",
      "public.restroom_access_policies",
      "public.restroom_photos",
    ];

    for (const table of expectedTables) {
      expect(sql).toContain(`create table if not exists ${table}`);
      expect(sql).toContain(`alter table ${table} enable row level security;`);
    }
  });

  it("02. enforces type exclusivity constraint between partner and public restrooms", () => {
    const sql = fs.readFileSync(migrationPath, "utf-8");
    expect(sql).toContain("chk_restrooms_type_references");
    expect(sql).toContain("type = 'partner' and business_id is not null and source_id is null");
    expect(sql).toContain("type = 'public' and business_id is null and source_id is not null");
  });

  it("03. enforces that public restrooms cannot use PIN access method", () => {
    const sql = fs.readFileSync(migrationPath, "utf-8");
    expect(sql).toContain("chk_restrooms_public_no_pin");
    expect(sql).toContain("type <> 'public' or access_method <> 'pin'");
  });

  it("04. enforces single active access policy and single primary photo indexes", () => {
    const sql = fs.readFileSync(migrationPath, "utf-8");
    expect(sql).toContain("idx_restroom_access_policies_single_active");
    expect(sql).toContain("where is_active = true");
    expect(sql).toContain("idx_restroom_photos_single_primary");
    expect(sql).toContain("where is_primary = true");
  });

  it("05. access policy trigger enforces public free mode and prohibits real_deposit", () => {
    const sql = fs.readFileSync(migrationPath, "utf-8");
    expect(sql).toContain("enforce_restroom_access_policy_rules");
    expect(sql).toContain("real_deposit");
    expect(sql).toContain("public restrooms must have free access mode with zero deposit and no refund");
  });

  it("06. enforces partner business approval and visibility helpers with last_verified_at protection", () => {
    const sql = fs.readFileSync(migrationPath, "utf-8");
    expect(sql).toContain("create or replace function public.is_partner_business_approved");
    expect(sql).toContain("create or replace function public.is_restroom_publicly_visible");
    expect(sql).toContain("NEW.last_verified_at is distinct from OLD.last_verified_at");
    expect(sql).toContain("NEW.approved_by is not null or NEW.last_verified_at is not null");
    expect(sql).toContain("public.is_restroom_publicly_visible(type, business_id, publication_status)");
    expect(sql).toContain("NEW.last_verified_at is not null and NEW.last_verified_at > now()");
    expect(sql).toContain("using errcode = '22007'");
  });
});

describe("TASK 09 — Restroom Zod Schemas Validation", () => {
  const sampleBusinessId = "11111111-1111-4111-8111-111111111111";
  const sampleSourceId = "22222222-2222-4222-8222-222222222222";
  const sampleRestroomId = "33333333-3333-4333-8333-333333333333";

  it("06. accepts valid partner restroom with business_id", () => {
    const validPartner = {
      type: "partner" as const,
      business_id: sampleBusinessId,
      name: "행궁동 카페 제휴 화장실",
      road_address: "경기도 수원시 팔달구 신풍로 23",
      latitude: 37.2831,
      longitude: 127.0145,
      access_method: "pin" as const,
      publication_status: "draft" as const,
    };

    const res = createRestroomSchema.safeParse(validPartner);
    expect(res.success).toBe(true);
  });

  it("07. rejects partner restroom without business_id or with source_id", () => {
    const noBusiness = {
      type: "partner" as const,
      name: "제휴 화장실",
      road_address: "도로명주소",
      latitude: 37.28,
      longitude: 127.01,
    };
    expect(createRestroomSchema.safeParse(noBusiness).success).toBe(false);

    const withSource = {
      ...noBusiness,
      business_id: sampleBusinessId,
      source_id: sampleSourceId,
    };
    expect(createRestroomSchema.safeParse(withSource).success).toBe(false);
  });

  it("08. accepts valid public restroom with source_id", () => {
    const validPublic = {
      type: "public" as const,
      source_id: sampleSourceId,
      name: "화홍문 공중화장실",
      road_address: "경기도 수원시 팔달구 수원천로 374",
      latitude: 37.2875,
      longitude: 127.0182,
      access_method: "open" as const,
      publication_status: "published" as const,
    };

    const res = createRestroomSchema.safeParse(validPublic);
    expect(res.success).toBe(true);
  });

  it("09. rejects public restroom with business_id or with PIN access method", () => {
    const publicWithBusiness = {
      type: "public" as const,
      source_id: sampleSourceId,
      business_id: sampleBusinessId,
      name: "공공 화장실",
      road_address: "도로명주소",
      latitude: 37.28,
      longitude: 127.01,
    };
    expect(createRestroomSchema.safeParse(publicWithBusiness).success).toBe(false);

    const publicWithPin = {
      type: "public" as const,
      source_id: sampleSourceId,
      name: "공공 화장실",
      road_address: "도로명주소",
      latitude: 37.28,
      longitude: 127.01,
      access_method: "pin" as const,
    };
    expect(createRestroomSchema.safeParse(publicWithPin).success).toBe(false);
  });

  it("10. validates restroom access policy rules (free vs test_deposit vs real_deposit)", () => {
    const validFree = {
      restroom_id: sampleRestroomId,
      version: 1,
      access_mode: "free" as const,
      deposit_amount_krw: 0,
      refund_eligible: false,
      is_active: true,
      effective_from: new Date().toISOString(),
    };
    expect(restroomAccessPolicySchema.safeParse(validFree).success).toBe(true);

    const invalidFreeWithDeposit = {
      ...validFree,
      deposit_amount_krw: 1000,
    };
    expect(restroomAccessPolicySchema.safeParse(invalidFreeWithDeposit).success).toBe(false);

    const validTestDeposit = {
      restroom_id: sampleRestroomId,
      version: 1,
      access_mode: "test_deposit" as const,
      deposit_amount_krw: 1000,
      refund_eligible: true,
      receipt_window_hours: 24,
      is_active: true,
      effective_from: new Date().toISOString(),
    };
    expect(restroomAccessPolicySchema.safeParse(validTestDeposit).success).toBe(true);

    const invalidTestDepositZero = {
      ...validTestDeposit,
      deposit_amount_krw: 0,
    };
    expect(restroomAccessPolicySchema.safeParse(invalidTestDepositZero).success).toBe(false);

    const prohibitedRealDeposit = {
      ...validTestDeposit,
      access_mode: "real_deposit" as const,
    };
    expect(restroomAccessPolicySchema.safeParse(prohibitedRealDeposit).success).toBe(false);
  });

  it("11. validates restroom hours and exceptions logic", () => {
    const validClosed = {
      restroom_id: sampleRestroomId,
      weekday: 0,
      is_closed: true,
      opens_at: null,
      closes_at: null,
    };
    expect(restroomHourSchema.safeParse(validClosed).success).toBe(true);

    const invalidOpenWithoutTime = {
      restroom_id: sampleRestroomId,
      weekday: 1,
      is_closed: false,
      opens_at: null,
      closes_at: null,
    };
    expect(restroomHourSchema.safeParse(invalidOpenWithoutTime).success).toBe(false);

    const validOpenWithTime = {
      restroom_id: sampleRestroomId,
      weekday: 1,
      is_closed: false,
      opens_at: "09:00:00",
      closes_at: "22:00:00",
    };
    expect(restroomHourSchema.safeParse(validOpenWithTime).success).toBe(true);
  });

  it("12. validates coordinate pair consistency and publication requirement", () => {
    // Draft with null coordinates passes (unverified/quarantine allowed)
    const validDraftNullCoords = {
      type: "partner" as const,
      business_id: sampleBusinessId,
      name: "좌표 미확인 임시 화장실",
      road_address: "주소",
      latitude: null,
      longitude: null,
      publication_status: "draft" as const,
    };
    expect(createRestroomSchema.safeParse(validDraftNullCoords).success).toBe(true);

    // Mismatched coordinates (one null, one provided) fails
    const invalidMismatchedCoords = {
      ...validDraftNullCoords,
      latitude: 37.28,
      longitude: null,
    };
    expect(createRestroomSchema.safeParse(invalidMismatchedCoords).success).toBe(false);

    // Published restroom with null coordinates fails
    const invalidPublishedNullCoords = {
      ...validDraftNullCoords,
      publication_status: "published" as const,
    };
    expect(createRestroomSchema.safeParse(invalidPublishedNullCoords).success).toBe(false);
  });
});


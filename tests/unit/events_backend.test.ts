/**
 * Unit tests for user event ingestion backend, schemas, PMF metrics constraints, and client SDK.
 * Spec: docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/06_EVENTS_AND_PMF.md, docs/08_SECURITY_OPERATIONS.md
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ALLOWED_CLIENT_EVENTS,
  DIRECT_CLIENT_EVENTS,
  SERVER_ONLY_EVENTS,
  clientEventPayloadSchema,
  createVisitorSessionSchema,
  travelAnswerSchema,
  containsForbiddenKeys,
  checkRateLimit,
  resetRateLimits,
  ingestClientEvent,
  createVisitorSession,
  recordTravelAnswer,
  hashToken,
  EventError,
  createClientEventId,
  getOrCreateBrowserId,
  trackEvent,
  initializeVisitorSession,
  submitTravelAnswer,
} from "@/lib/events";

describe("TASK 17: Events Backend Specification & Validation", () => {
  beforeEach(() => {
    resetRateLimits();
    vi.restoreAllMocks();
  });

  describe("1. Client Event Allowlist & Server-Only Event Protection", () => {
    it("accepts all 11 defined direct client events", () => {
      expect(DIRECT_CLIENT_EVENTS).toHaveLength(11);

      for (const eventName of DIRECT_CLIENT_EVENTS) {
        const payload = {
          clientEventId: "11111111-1111-4111-8111-111111111111",
          eventName,
          occurredAt: new Date().toISOString(),
        };
        const result = clientEventPayloadSchema.safeParse(payload);
        expect(result.success, `Event "${eventName}" should be valid`).toBe(true);
      }
    });

    it("strictly rejects all 17 server-only events (including travel_answer_submitted) when attempted from client", () => {
      expect(SERVER_ONLY_EVENTS).toHaveLength(17);

      for (const serverEvent of SERVER_ONLY_EVENTS) {
        const payload = {
          clientEventId: "11111111-1111-4111-8111-111111111111",
          eventName: serverEvent,
          occurredAt: new Date().toISOString(),
        };
        const result = clientEventPayloadSchema.safeParse(payload);
        expect(result.success).toBe(false);
        if (!result.success) {
          const msg = result.error.issues[0].message;
          expect(
            msg.includes("서버 전용 이벤트") ||
            msg.includes("PATCH /api/v1/sessions/:id/travel-answer")
          ).toBe(true);
        }
      }
    });

    it("rejects unknown or unregistered event names", () => {
      const payload = {
        clientEventId: "11111111-1111-4111-8111-111111111111",
        eventName: "fake_payment_success",
        occurredAt: new Date().toISOString(),
      };
      const result = clientEventPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("허용되지 않은 이벤트 이름");
      }
    });
  });

  describe("2. Security: Forbidden PII, Credentials & Continuous GPS Trails", () => {
    it("detects forbidden keys (PIN, password, card, phone, email, continuous lat/lng)", () => {
      expect(containsForbiddenKeys({ pin: "1234" })).toBe(true);
      expect(containsForbiddenKeys({ PIN: "1234" })).toBe(true);
      expect(containsForbiddenKeys({ password: "pass" })).toBe(true);
      expect(containsForbiddenKeys({ token: "jwt..." })).toBe(true);
      expect(containsForbiddenKeys({ payment_key: "toss_pk" })).toBe(true);
      expect(containsForbiddenKeys({ card_number: "1234-5678" })).toBe(true);
      expect(containsForbiddenKeys({ email: "user@test.com" })).toBe(true);
      expect(containsForbiddenKeys({ phone: "010-1234-5678" })).toBe(true);
      expect(containsForbiddenKeys({ latitude: 37.28, longitude: 127.01 })).toBe(true);
      expect(containsForbiddenKeys({ coords: [37.28, 127.01] })).toBe(true);
      expect(containsForbiddenKeys({ gps_trail: [] })).toBe(true);
      expect(containsForbiddenKeys({ nested: { deeper: { pin: "1234" } } })).toBe(true);
      expect(containsForbiddenKeys({ items: [[{ pin: "1234" }]] })).toBe(true);
      expect(containsForbiddenKeys({ data: [[[{ phone: "010-1234-5678" }]]] })).toBe(true);
    });

    it("allows non-sensitive business and UI telemetry properties", () => {
      expect(containsForbiddenKeys({ cardType: "partner", visibilityRuleVersion: "1.0" })).toBe(false);
      expect(containsForbiddenKeys({ service: "kakao", currentZoom: 16 })).toBe(false);
      expect(containsForbiddenKeys({ traveling_now: true })).toBe(false);
      expect(containsForbiddenKeys({ filterSelected: "public" })).toBe(false);
    });

    it("rejects event payload containing forbidden properties", () => {
      const payload = {
        clientEventId: "11111111-1111-4111-8111-111111111111",
        eventName: "directions_clicked",
        properties: {
          service: "kakao",
          pin: "1234",
        },
      };
      const result = clientEventPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("금지된 개인정보");
      }
    });

    it("enforces max property size limit (4KB)", () => {
      const largeData = "x".repeat(5000);
      const payload = {
        clientEventId: "11111111-1111-4111-8111-111111111111",
        eventName: "landing_view",
        properties: { largeData },
      };
      const result = clientEventPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("4KB");
      }
    });
  });

  describe("3. Timestamps & UUID Format Validation", () => {
    it("rejects invalid UUID for clientEventId", () => {
      const payload = {
        clientEventId: "not-a-valid-uuid",
        eventName: "landing_view",
      };
      const result = clientEventPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });

    it("rejects future occurredAt timestamps (>10 minutes into the future)", () => {
      const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const payload = {
        clientEventId: "11111111-1111-4111-8111-111111111111",
        eventName: "landing_view",
        occurredAt: futureDate,
      };
      const result = clientEventPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("미래일 수 없습니다");
      }
    });

    it("accepts valid ISO occurredAt within acceptable range", () => {
      const validDate = new Date(Date.now() - 5000).toISOString();
      const payload = {
        clientEventId: "11111111-1111-4111-8111-111111111111",
        eventName: "landing_view",
        occurredAt: validDate,
      };
      const result = clientEventPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });
  });

  describe("4. Rate Limiting", () => {
    it("allows up to the limit and blocks subsequent requests within the window", () => {
      const key = "test-browser-rate-limit";
      for (let i = 0; i < 5; i++) {
        const res = checkRateLimit(key, 5, 10000);
        expect(res.allowed).toBe(true);
        expect(res.remaining).toBe(4 - i);
      }

      const blockedRes = checkRateLimit(key, 5, 10000);
      expect(blockedRes.allowed).toBe(false);
      expect(blockedRes.remaining).toBe(0);
      expect(blockedRes.resetMs).toBeGreaterThan(0);
    });

    it("resets rate limits cleanly", () => {
      const key = "test-reset";
      for (let i = 0; i < 5; i++) {
        checkRateLimit(key, 5, 10000);
      }
      expect(checkRateLimit(key, 5, 10000).allowed).toBe(false);

      resetRateLimits();
      expect(checkRateLimit(key, 5, 10000).allowed).toBe(true);
    });
  });

  describe("5. Ingestion Service: User ID Authenticity & Idempotency", () => {
    function createMockSupabase(existingEvents: any[] = [], existingSessions: any[] = []) {
      const events = [...existingEvents];
      const sessions = [...existingSessions];

      return {
        from: (table: string) => {
          if (table === "event_logs") {
            return {
              select: () => ({
                eq: (_col: string, val: string) => ({
                  maybeSingle: async () => {
                    const found = events.find((e) => e.client_event_id === val);
                    return { data: found ?? null, error: null };
                  },
                }),
              }),
              insert: (row: any) => ({
                select: () => ({
                  single: async () => {
                    const item = { id: crypto.randomUUID(), ...row };
                    events.push(item);
                    return { data: item, error: null };
                  },
                }),
              }),
            };
          }
          if (table === "visitor_sessions") {
            return {
              select: () => ({
                eq: (_col: string, val: string) => ({
                  maybeSingle: async () => {
                    const found = sessions.find((s) => s.id === val);
                    return { data: found ?? null, error: null };
                  },
                }),
              }),
              insert: (row: any) => ({
                select: () => ({
                  single: async () => {
                    const item = { id: crypto.randomUUID(), ...row };
                    sessions.push(item);
                    return { data: item, error: null };
                  },
                }),
              }),
              update: (patch: any) => ({
                eq: (_col: string, val: string) => {
                  const s = sessions.find((item) => item.id === val);
                  if (s) Object.assign(s, patch);
                  return Promise.resolve({ data: s, error: null });
                },
              }),
            };
          }
          if (table === "consent_records") {
            return {
              insert: async (row: any) => ({ data: row, error: null }),
            };
          }
          return {};
        },
      } as any;
    }

    it("allows anonymous visitor to ingest event without userId", async () => {
      const mockSupabase = createMockSupabase();
      const payload = {
        clientEventId: "11111111-1111-4111-8111-111111111111",
        eventName: "landing_view",
      };

      const result = await ingestClientEvent(mockSupabase, payload, null);
      expect(result.clientEventId).toBe(payload.clientEventId);
      expect(result.deduplicated).toBe(false);
    });

    it("blocks anonymous visitor from attempting to specify a userId", async () => {
      const mockSupabase = createMockSupabase();
      const payload = {
        clientEventId: "11111111-1111-4111-8111-111111111111",
        eventName: "landing_view",
        userId: "22222222-2222-4222-8222-222222222222",
      };

      await expect(ingestClientEvent(mockSupabase, payload, null)).rejects.toThrow(
        "비로그인 상태에서는 user_id를 지정할 수 없습니다."
      );
    });

    it("blocks authenticated user from spoofing another user's userId", async () => {
      const mockSupabase = createMockSupabase();
      const authUserId = "33333333-3333-4333-8333-333333333333";
      const forgedUserId = "44444444-4444-4444-8444-444444444444";

      const payload = {
        clientEventId: "11111111-1111-4111-8111-111111111111",
        eventName: "landing_view",
        userId: forgedUserId,
      };

      await expect(ingestClientEvent(mockSupabase, payload, authUserId)).rejects.toThrow(
        "인증된 사용자와 다른 user_id로 이벤트를 기록할 수 없습니다."
      );
    });

    it("handles duplicate clientEventId idempotently (returns deduplicated: true)", async () => {
      const existing = [
        {
          id: "existing-uuid",
          client_event_id: "11111111-1111-4111-8111-111111111111",
          event_name: "landing_view",
          received_at: "2026-11-11T10:00:00Z",
        },
      ];
      const mockSupabase = createMockSupabase(existing);

      const payload = {
        clientEventId: "11111111-1111-4111-8111-111111111111",
        eventName: "landing_view",
      };

      const result = await ingestClientEvent(mockSupabase, payload, null);
      expect(result.deduplicated).toBe(true);
      expect(result.clientEventId).toBe(payload.clientEventId);
    });

    it("rejects collision when same clientEventId is sent with a differing eventName", async () => {
      const existing = [
        {
          id: "existing-uuid",
          client_event_id: "11111111-1111-4111-8111-111111111111",
          event_name: "landing_view",
          received_at: "2026-11-11T10:00:00Z",
        },
      ];
      const mockSupabase = createMockSupabase(existing);

      const payload = {
        clientEventId: "11111111-1111-4111-8111-111111111111",
        eventName: "map_loaded", // Different event name
      };

      await expect(ingestClientEvent(mockSupabase, payload, null)).rejects.toThrow(
        "동일한 client_event_id로 다른 이벤트 데이터가 이미 등록되어 있습니다."
      );
    });
  });

  describe("6. Visitor Sessions & Travel Answer", () => {
    it("creates visitor session with UTM and records consent", async () => {
      const mockSupabase = {
        from: (table: string) => {
          if (table === "visitor_sessions") {
            return {
              insert: (row: any) => ({
                select: () => ({
                  single: async () => ({
                    data: {
                      id: "session-uuid-1",
                      browser_id: row.browser_id,
                      started_at: row.started_at,
                      is_test: row.is_test,
                    },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === "consent_records") {
            return {
              insert: async (row: any) => ({ data: row, error: null }),
            };
          }
          return {};
        },
      } as any;

      const payload = {
        browserId: "11111111-1111-4111-8111-111111111111",
        landingPath: "/map",
        utmSource: "instagram",
        utmMedium: "cpc",
        consent: {
          analytics: true,
          marketing: false,
        },
      };

      const result = await createVisitorSession(mockSupabase, payload, null);
      expect(result.sessionId).toBe("session-uuid-1");
      expect(result.browserId).toBe(payload.browserId);
      expect(result.isTest).toBe(false);
    });

    it("records travel answer and emits travel_answer_submitted event", async () => {
      const token = "secret_session_token_1234567890";
      const session = {
        id: "22222222-2222-4222-8222-222222222222",
        browser_id: "11111111-1111-4111-8111-111111111111",
        user_id: null,
        session_token_hash: hashToken(token),
        is_test: false,
      };

      let updatedPatch: any = null;
      let insertedEvent: any = null;

      const mockSupabase = {
        from: (table: string) => {
          if (table === "visitor_sessions") {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: session, error: null }),
                }),
              }),
              update: (patch: any) => ({
                eq: () => {
                  updatedPatch = patch;
                  return Promise.resolve({ data: patch, error: null });
                },
              }),
            };
          }
          if (table === "event_logs") {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
              insert: (row: any) => {
                insertedEvent = row;
                return {
                  select: () => ({
                    single: async () => ({ data: { id: "evt-1", ...row }, error: null }),
                  }),
                };
              },
            };
          }
          return {};
        },
      } as any;

      const result = await recordTravelAnswer(mockSupabase, session.id, {
        travelingNow: true,
        browserId: session.browser_id,
        sessionToken: token,
      });

      expect(result.sessionId).toBe(session.id);
      expect(result.travelingNow).toBe(true);
      expect(updatedPatch?.traveling_now).toBe(true);
      expect(insertedEvent?.event_name).toBe("travel_answer_submitted");
      expect(insertedEvent?.properties?.traveling_now).toBe(true);
    });

    it("rejects travel answer modification on legacy anonymous session without token", async () => {
      const legacySession = {
        id: "22222222-2222-4222-8222-222222222222",
        browser_id: "11111111-1111-4111-8111-111111111111",
        user_id: null,
        session_token_hash: null, // Legacy session without token!
        is_test: false,
      };

      const mockSupabase = {
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: legacySession, error: null }),
            }),
          }),
        }),
      } as any;

      await expect(
        recordTravelAnswer(mockSupabase, legacySession.id, {
          travelingNow: true,
          browserId: legacySession.browser_id,
          sessionToken: "some_token",
        })
      ).rejects.toThrow("토큰이 없는 기존 익명 세션은 여행 응답을 수정할 수 없습니다");
    });

    it("rejects travel answer modification when browserId is missing on anonymous session", async () => {
      const session = {
        id: "22222222-2222-4222-8222-222222222222",
        browser_id: "11111111-1111-4111-8111-111111111111",
        user_id: null,
        session_token_hash: hashToken("valid_token"),
        is_test: false,
      };

      const mockSupabase = {
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: session, error: null }),
            }),
          }),
        }),
      } as any;

      await expect(
        recordTravelAnswer(mockSupabase, session.id, {
          travelingNow: true,
          // browserId missing
          sessionToken: "valid_token",
        })
      ).rejects.toThrow("익명 세션 검증에 browserId가 필요하며");
    });

    it("rejects travel answer modification when token does not match anonymous session", async () => {
      const session = {
        id: "22222222-2222-4222-8222-222222222222",
        browser_id: "11111111-1111-4111-8111-111111111111",
        user_id: null,
        session_token_hash: hashToken("correct_token"),
        is_test: false,
      };

      const mockSupabase = {
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: session, error: null }),
            }),
          }),
        }),
      } as any;

      await expect(
        recordTravelAnswer(mockSupabase, session.id, {
          travelingNow: true,
          browserId: session.browser_id,
          sessionToken: "wrong_token",
        })
      ).rejects.toThrow("익명 세션 소유권 증명(토큰) 검증에 실패했습니다");
    });

    it("throws 404 when session is not found for travel answer", async () => {
      const mockSupabase = {
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
      } as any;

      await expect(
        recordTravelAnswer(mockSupabase, "11111111-1111-4111-8111-111111111111", {
          travelingNow: true,
        })
      ).rejects.toThrow("방문 세션을 찾을 수 없습니다.");
    });
  });

  describe("7. Client SDK Helpers", () => {
    it("generates a valid clientEventId UUID", () => {
      const id = createClientEventId();
      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(uuidRegex.test(id)).toBe(true);
    });

    it("creates and retrieves persistent browser ID from localStorage", () => {
      const mockStorage: Record<string, string> = {};
      const fakeWindow = {
        localStorage: {
          getItem: (key: string) => mockStorage[key] || null,
          setItem: (key: string, val: string) => {
            mockStorage[key] = val;
          },
        },
      };

      vi.stubGlobal("window", fakeWindow);

      const id1 = getOrCreateBrowserId();
      expect(id1).toBeDefined();

      const id2 = getOrCreateBrowserId();
      expect(id2).toBe(id1);

      vi.unstubAllGlobals();
    });

    it("trackEvent dispatches POST to /api/v1/events and returns result", async () => {
      const prevEnv = process.env.NEXT_PUBLIC_ANALYTICS_ENABLED;
      process.env.NEXT_PUBLIC_ANALYTICS_ENABLED = "true";
      const mockStorage: Record<string, string> = {
        hm_consent_state: JSON.stringify({ analytics: true }),
      };
      vi.stubGlobal("window", {
        localStorage: {
          getItem: (key: string) => mockStorage[key] ?? null,
          setItem: (key: string, val: string) => {
            mockStorage[key] = val;
          },
          removeItem: (key: string) => {
            delete mockStorage[key];
          },
        },
        dispatchEvent: vi.fn(),
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            clientEventId: "11111111-1111-4111-8111-111111111111",
            receivedAt: "2026-11-11T12:00:00Z",
            deduplicated: false,
          },
        }),
      });

      vi.stubGlobal("fetch", mockFetch);

      const res = await trackEvent({
        clientEventId: "11111111-1111-4111-8111-111111111111",
        eventName: "map_loaded",
        properties: { zoom: 3, restroom_count: 5, filter: "all" },
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("/api/v1/events");
      expect(opts.method).toBe("POST");
      expect(res.clientEventId).toBe("11111111-1111-4111-8111-111111111111");

      if (prevEnv === undefined) {
        delete process.env.NEXT_PUBLIC_ANALYTICS_ENABLED;
      } else {
        process.env.NEXT_PUBLIC_ANALYTICS_ENABLED = prevEnv;
      }
      vi.unstubAllGlobals();
    });
  });
});

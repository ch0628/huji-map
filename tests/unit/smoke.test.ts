import { describe, it, expect } from "vitest";

describe("Smoke Unit Tests", () => {
  it("기본 자바스크립트/테스트 런너 환경이 정상 작동해야 한다", () => {
    expect(1 + 1).toBe(2);
    expect(true).toBe(true);
  });

  it("화장실 보증금 테스트 기본 금액(1,000원) 연산이 정상 동작해야 한다", () => {
    const depositAmount = 1000;
    const formatted = `${depositAmount.toLocaleString("ko-KR")}원`;
    expect(formatted).toBe("1,000원");
  });

  it("PMF 핵심 이벤트 명세(directions_clicked 등) 키가 유효하게 정의되어야 한다", () => {
    const validEvents = ["directions_clicked", "partner_card_view", "deposit_started"];
    expect(validEvents).toContain("directions_clicked");
    expect(validEvents.length).toBe(3);
  });
});


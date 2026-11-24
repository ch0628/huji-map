#!/usr/bin/env node
/**
 * Phase 3-C Canary-10 Human Review Gate & Interactive Local Review Workbench Builder.
 *
 * Reads `seoul_pilot_10_package.json`, `seoul_pilot_10_verification_checklist.csv`,
 * and `seoul_pilot_10_review_decisions.json` (initializing all items as PENDING if absent).
 *
 * Enforces strict zero-auto-PASS:
 * ONLY items where BOTH:
 *   1) buildingLocationResult === "PASS"
 *   2) restroomExistenceOpenResult === "PASS"
 * remain in `seoul_pilot_10_approved_package.json`.
 * All other items (`PENDING`, `FAIL`, `확인 불가`) are held in `seoul_pilot_10_held_items.json`.
 *
 * Usage:
 *   npx tsx scripts/address-db-poc/phase3c-review-gate.ts
 */

import fs from "node:fs";
import path from "node:path";
import { decodeCsvBuffer, parseCsv } from "../../src/lib/imports/parser";
import { isValidSeoulWgs84, type SeoulOaRawRecord } from "./phase3b-lib";
import {
  applyCanaryReviewGate,
  createInitialCanaryReviewDecisions,
  type CanaryReviewDecision,
  type Phase3cLoadPackage,
  type RemoteRestroomRef,
} from "./phase3c-lib";
import { evaluatePhase3dCanaryCandidates } from "./phase3d-lib";

const PHASE3C_DIR = path.resolve(
  process.cwd(),
  "local-data/address-db-poc/phase3c"
);

function escapeHtml(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildReviewHtml(
  pkg: Phase3cLoadPackage,
  checklistRows: Array<Record<string, string | undefined>>,
  decisions: CanaryReviewDecision[]
): string {
  const byId = new Map(checklistRows.map((r) => [r["restroom_id"] || "", r]));
  const decById = new Map(decisions.map((d) => [d.restroomId, d]));

  const itemsPayload = pkg.restrooms.map((r, i) => {
    const chk = byId.get(r.id) || {};
    const dec = decById.get(r.id);
    return {
      idx: i + 1,
      id: r.id,
      name: r.name,
      guName: r.gu_name,
      roadAddress: r.road_address,
      addressDetail: r.address_detail || "",
      latitude: r.latitude,
      longitude: r.longitude,
      sourceRecordId: r.source_record_id,
      coordSourceRecordId: r.coordinate_source_record_id,
      oaCategoryType: r.oa_category_type,
      description: r.description || "",
      openHoursClaimed: chk["open_hours_claimed"] || "",
      toiletInfoClaimed: chk["toilet_info_claimed"] || "",
      wheelchairClaimed: chk["wheelchair_claimed"] || "",
      kakaoUrl: chk["kakao_map_review_url"] || "",
      naverUrl: chk["naver_map_review_url"] || "",
      vworldUrl: chk["vworld_review_url"] || "",
      buildingLocationResult: dec?.buildingLocationResult || "PENDING",
      restroomExistenceOpenResult: dec?.restroomExistenceOpenResult || "PENDING",
      reviewerName: dec?.reviewerName || "",
      reviewedAt: dec?.reviewedAt || "",
      notes: dec?.notes || "",
    };
  });

  const payloadJson = JSON.stringify(itemsPayload).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HUJIMAP Phase 3-C 카나리 10건 배포 전 사람 검수표</title>
  <style>
    :root { --bg:#f8fafc; --card:#fff; --ink:#0f172a; --muted:#475569; --line:#e2e8f0; --pass:#047857; --passBg:#ecfdf5; --fail:#b91c1c; --failBg:#fef2f2; --unk:#b45309; --unkBg:#fffbeb; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--ink); line-height: 1.5; }
    header { position: sticky; top: 0; z-index: 20; background: #fff; border-bottom: 1px solid var(--line); padding: 14px 20px; }
    .wrap { max-width: 1080px; margin: 0 auto; padding: 16px 20px 64px; }
    h1 { margin: 0 0 6px; font-size: 18px; }
    .sub { margin: 0; font-size: 13px; color: var(--muted); }
    .bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 10px; }
    .pill { padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; border: 1px solid var(--line); background: #f1f5f9; }
    .pill.pass { color: var(--pass); background: var(--passBg); border-color: #a7f3d0; }
    .pill.hold { color: var(--unk); background: var(--unkBg); border-color: #fde68a; }
    button.export { margin-left: auto; background: #0f172a; color: #fff; border: 0; padding: 8px 14px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; }
    button.export:hover { background: #1e293b; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 18px; margin-bottom: 16px; }
    .card-head { display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; align-items: baseline; margin-bottom: 10px; }
    .title { font-size: 17px; font-weight: 700; }
    .badge { font-size: 12px; font-weight: 700; padding: 3px 9px; border-radius: 999px; background: #f1f5f9; }
    .badge.READY { color: var(--pass); background: var(--passBg); }
    .badge.HOLD { color: var(--unk); background: var(--unkBg); }
    .badge.REJECT { color: var(--fail); background: var(--failBg); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(270px, 1fr)); gap: 12px; margin-bottom: 12px; font-size: 13px; }
    .box { background: #f8fafc; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
    .box h3 { margin: 0 0 6px; font-size: 12px; color: var(--muted); text-transform: uppercase; }
    .links { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
    .links a { text-decoration: none; font-size: 12px; font-weight: 600; padding: 5px 10px; border-radius: 7px; border: 1px solid #cbd5e1; background: #fff; color: #0f172a; }
    .links a:hover { background: #e2e8f0; }
    .checks { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; border-top: 1px solid var(--line); padding-top: 12px; }
    .check-group { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
    .check-group strong { display: block; font-size: 13px; margin-bottom: 4px; }
    .check-group p { margin: 0 0 8px; font-size: 12px; color: var(--muted); }
    .opts { display: flex; flex-wrap: wrap; gap: 6px; }
    .opts button { border: 1px solid #cbd5e1; background: #fff; border-radius: 7px; padding: 6px 10px; font-size: 12px; font-weight: 600; cursor: pointer; }
    .opts button[data-active="PASS"] { background: var(--passBg); border-color: var(--pass); color: var(--pass); }
    .opts button[data-active="FAIL"] { background: var(--failBg); border-color: var(--fail); color: var(--fail); }
    .opts button[data-active="확인 불가"] { background: var(--unkBg); border-color: var(--unk); color: var(--unk); }
    .opts button[data-active="PENDING"] { background: #e2e8f0; border-color: #64748b; color: #0f172a; }
    .notes-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .notes-row input { padding: 7px 10px; border: 1px solid #cbd5e1; border-radius: 7px; font-size: 13px; }
    .notes-row input.note { flex: 1; min-width: 240px; }
  </style>
</head>
<body>
  <header>
    <div class="wrap" style="padding:0;">
      <h1>Phase 3-C 카나리 10건 배포 전 검수표 (서울 OA-22586)</h1>
      <p class="sub">규칙: ① 건물 실제 위치 확인(PASS) AND ② 공중화장실 존재·개방 여부 확인(PASS) 둘 다 PASS인 건만 적재 후보로 유지됩니다. 미확인·FAIL·확인 불가 건은 자동 보류됩니다.</p>
      <div class="bar">
        <span class="pill pass" id="cnt-approved">적재 유지(PASS+PASS): 0 / 10</span>
        <span class="pill hold" id="cnt-held">보류(미검수/FAIL/확인불가): 10 / 10</span>
        <span class="pill" id="cnt-bpass">건물위치 PASS: 0</span>
        <span class="pill" id="cnt-opass">화장실개방 PASS: 0</span>
        <button class="export" type="button" onclick="downloadJson()">검수 결과 JSON 다운로드 (seoul_pilot_10_review_decisions.json)</button>
      </div>
    </div>
  </header>
  <main class="wrap" id="app"></main>
  <script>
    const INITIAL = ${payloadJson};
    const STORAGE_KEY = "hujimap_phase3c_canary10_decisions_v1";
    let state = INITIAL;
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (Array.isArray(saved) && saved.length === INITIAL.length) {
        state = INITIAL.map((item, idx) => ({ ...item, ...saved[idx] }));
      }
    } catch {}

    const CHOICES = ["PASS", "FAIL", "확인 불가", "PENDING"];
    const CHOICE_LABEL = { "PASS": "PASS", "FAIL": "FAIL", "확인 불가": "확인 불가", "PENDING": "미검수" };

    function save() {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
    }

    function setField(idx, field, value) {
      state[idx][field] = value;
      if (field === "buildingLocationResult" || field === "restroomExistenceOpenResult") {
        state[idx].reviewedAt = new Date().toISOString();
      }
      save();
      render();
    }

    function downloadJson() {
      const out = state.map((s) => ({
        idx: s.idx,
        restroomId: s.id,
        name: s.name,
        guName: s.guName,
        roadAddress: s.roadAddress,
        buildingLocationResult: s.buildingLocationResult,
        restroomExistenceOpenResult: s.restroomExistenceOpenResult,
        reviewerName: s.reviewerName,
        reviewedAt: s.reviewedAt,
        notes: s.notes,
      }));
      const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "seoul_pilot_10_review_decisions.json";
      a.click();
    }

    function esc(s) {
      return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    }

    function render() {
      let approved = 0, bpass = 0, opass = 0;
      state.forEach((s) => {
        if (s.buildingLocationResult === "PASS") bpass++;
        if (s.restroomExistenceOpenResult === "PASS") opass++;
        if (s.buildingLocationResult === "PASS" && s.restroomExistenceOpenResult === "PASS") approved++;
      });
      document.getElementById("cnt-approved").textContent = "적재 유지(PASS+PASS): " + approved + " / " + state.length;
      document.getElementById("cnt-held").textContent = "보류(미검수/FAIL/확인불가): " + (state.length - approved) + " / " + state.length;
      document.getElementById("cnt-bpass").textContent = "건물위치 PASS: " + bpass;
      document.getElementById("cnt-opass").textContent = "화장실개방 PASS: " + opass;

      const root = document.getElementById("app");
      root.innerHTML = state.map((s, i) => {
        const isReady = s.buildingLocationResult === "PASS" && s.restroomExistenceOpenResult === "PASS";
        const isFail = s.buildingLocationResult === "FAIL" || s.restroomExistenceOpenResult === "FAIL";
        const statusClass = isReady ? "READY" : (isFail ? "REJECT" : "HOLD");
        const statusLabel = isReady ? "적재 후보 유지 (PASS)" : (isFail ? "보류 / 제외 (FAIL)" : "보류 (" + s.buildingLocationResult + " / " + s.restroomExistenceOpenResult + ")");
        return \`
          <section class="card">
            <div class="card-head">
              <div class="title">#\${s.idx}. [\${esc(s.guName)}] \${esc(s.name)}</div>
              <span class="badge \${statusClass}">\${esc(statusLabel)}</span>
            </div>
            <div class="grid">
              <div class="box">
                <h3>주소 및 공식 좌표</h3>
                <div><strong>도로명:</strong> \${esc(s.roadAddress)}</div>
                <div><strong>지번:</strong> \${esc(s.addressDetail || "-")}</div>
                <div><strong>공식 위도·경도:</strong> \${s.latitude}, \${s.longitude}</div>
                <div class="links">
                  <a href="\${esc(s.kakaoUrl)}" target="_blank" rel="noopener">카카오맵 확인</a>
                  <a href="\${esc(s.naverUrl)}" target="_blank" rel="noopener">네이버지도/로드뷰 확인</a>
                  <a href="\${esc(s.vworldUrl)}" target="_blank" rel="noopener">브이월드 확인</a>
                </div>
              </div>
              <div class="box">
                <h3>공식 원천 정보 (OA-22586 / 공공누리 제1유형)</h3>
                <div><strong>원천 ID:</strong> \${esc(s.coordSourceRecordId)} / 표준: \${esc(s.sourceRecordId)}</div>
                <div><strong>유형/개방:</strong> \${esc(s.oaCategoryType)} · \${esc(s.openHoursClaimed)}</div>
                <div><strong>현황/장애인:</strong> \${esc(s.toiletInfoClaimed)} / \${esc(s.wheelchairClaimed || "-")}</div>
                <div style="margin-top:4px; color:#475569;">\${esc(s.description)}</div>
              </div>
            </div>
            <div class="checks">
              <div class="check-group">
                <strong>[A] 건물 실제 위치 확인 (지도·로드뷰)</strong>
                <p>표시된 도로명주소(\${esc(s.roadAddress)})와 건물명(\${esc(s.name)})에 핀 좌표(\${s.latitude}, \${s.longitude})가 정확히 위치합니까?</p>
                <div class="opts">
                  \${CHOICES.map((c) => \`<button type="button" data-active="\${s.buildingLocationResult === c ? c : ""}" onclick="setField(\${i}, 'buildingLocationResult', '\${c}')">\${CHOICE_LABEL[c]}</button>\`).join("")}
                </div>
              </div>
              <div class="check-group">
                <strong>[B] 공중화장실 존재·개방 여부 확인</strong>
                <p>개방 안내표지, 로드뷰 출입구, 기관 안내 또는 현장/유선으로 공중개방 화장실 존재·개방(\${esc(s.openHoursClaimed)})이 확인되었습니까? (로드뷰만으로 판단 불가 시 '확인 불가')</p>
                <div class="opts">
                  \${CHOICES.map((c) => \`<button type="button" data-active="\${s.restroomExistenceOpenResult === c ? c : ""}" onclick="setField(\${i}, 'restroomExistenceOpenResult', '\${c}')">\${CHOICE_LABEL[c]}</button>\`).join("")}
                </div>
              </div>
            </div>
            <div class="notes-row">
              <input type="text" placeholder="검수자 이름" value="\${esc(s.reviewerName)}" oninput="state[\${i}].reviewerName = this.value; save();" />
              <input class="note" type="text" placeholder="검수 메모 (예: 건물명 일치, 출입구 표지판 로드뷰 불가 → 유선확인 필요)" value="\${esc(s.notes)}" oninput="state[\${i}].notes = this.value; save();" />
            </div>
          </section>\`;
      }).join("");
    }
    render();
  </script>
</body>
</html>`;
}

function main() {
  const pkgPath = path.join(PHASE3C_DIR, "seoul_pilot_10_package.json");
  const checklistPath = path.join(
    PHASE3C_DIR,
    "seoul_pilot_10_verification_checklist.csv"
  );
  const decisionsPath = path.join(
    PHASE3C_DIR,
    "seoul_pilot_10_review_decisions.json"
  );

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as Phase3cLoadPackage;
  const checklistTxt = fs
    .readFileSync(checklistPath, "utf8")
    .replace(/^\uFEFF/, "");
  const checklistRows = parseCsv(checklistTxt);

  let decisions: CanaryReviewDecision[];
  if (fs.existsSync(decisionsPath)) {
    decisions = JSON.parse(
      fs.readFileSync(decisionsPath, "utf8")
    ) as CanaryReviewDecision[];
  } else {
    decisions = createInitialCanaryReviewDecisions(pkg);
    fs.writeFileSync(
      decisionsPath,
      JSON.stringify(decisions, null, 2),
      "utf8"
    );
  }

  const gated = applyCanaryReviewGate(pkg, decisions);
  fs.writeFileSync(
    path.join(PHASE3C_DIR, "seoul_pilot_10_approved_package.json"),
    JSON.stringify(gated.approvedPackage, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(PHASE3C_DIR, "seoul_pilot_10_held_items.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        summary: gated.summary,
        heldItems: gated.heldItems,
      },
      null,
      2
    ),
    "utf8"
  );
  fs.writeFileSync(
    path.join(PHASE3C_DIR, "canary_10_review_sheet.html"),
    buildReviewHtml(pkg, checklistRows, decisions),
    "utf8"
  );

  // Guard against accidental unused import lint errors on escapeHtml
  void escapeHtml;

  console.log("Phase 3-C Canary-10 strict human review gate summary:", gated.summary);

  // Dual-path Phase 3-D Official-Source Policy Gate (never mutates human review decisions)
  const oaCsvPath = path.resolve(
    process.cwd(),
    "local-data/서울시 공중화장실 위치정보.csv"
  );
  if (fs.existsSync(oaCsvPath)) {
    const oaTxt = decodeCsvBuffer(fs.readFileSync(oaCsvPath), "cp949");
    const oaRaw = parseCsv(oaTxt);
    const oaRecords: SeoulOaRawRecord[] = [];
    for (const r of oaRaw) {
      const lat = Number.parseFloat((r["y 좌표"] || "").trim());
      const lng = Number.parseFloat((r["x 좌표"] || "").trim());
      if (!isValidSeoulWgs84(lat, lng)) continue;
      oaRecords.push({
        seq: (r["연번"] || "").trim(),
        roadAddress: (r["도로명주소"] || "").trim(),
        jibunAddress: (r["지번주소"] || "").trim(),
        lat,
        lng,
        buildingName: (r["건물명"] || "").trim(),
        guName: (r["구 명칭"] || "").trim(),
        phone: (r["전화번호"] || "").trim(),
        categoryType: (r["유형"] || "").trim(),
        openHours: (r["개방시간"] || "").trim(),
        siteUse: (r["소재지 용도"] || "").trim(),
        toiletInfo: (r["화장실 현황"] || "").trim(),
        disabledInfo: (r["장애인화장실 현황"] || "").trim(),
        extraFacilities: (r["편의시설 (기타설비)"] || "").trim(),
        signage: (r["안내표지"] || "").trim(),
        siteType: (r["소재지"] || "").trim(),
        notes: (r["비고"] || "").trim(),
      });
    }

    const suwonExpPath = path.resolve(
      process.cwd(),
      "local-data/suwon_remote_export.json"
    );
    const remoteRows: RemoteRestroomRef[] = fs.existsSync(suwonExpPath)
      ? (JSON.parse(fs.readFileSync(suwonExpPath, "utf8")).restrooms || []).map(
          (r: any) => ({
            id: r.id,
            source_record_id: r.source_record_id ?? null,
            type: r.type,
            name: r.name,
            road_address: r.road_address,
            latitude: r.latitude,
            longitude: r.longitude,
            coordinate_source: r.coordinate_source ?? null,
          })
        )
      : [];

    const officialEval = evaluatePhase3dCanaryCandidates({
      pkg,
      oaRecords,
      remoteRows,
      humanDecisions: decisions,
      sourceVersion: pkg.sourceVersion,
    });
    fs.writeFileSync(
      path.join(PHASE3C_DIR, "seoul_pilot_10_official_source_summary.json"),
      JSON.stringify(officialEval.finalPackage.counts, null, 2),
      "utf8"
    );
    console.log(
      "Phase 3-D official-source dual-path gate summary:",
      officialEval.finalPackage.counts
    );
  }
}

main();

"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import type {
  Restroom,
  GenderType,
  AccessMethod,
  PublicationStatus,
} from "@/lib/restrooms/types";
import {
  createMerchantRestroomSchema,
  updateMerchantRestroomSchema,
} from "@/lib/restrooms/merchant-validation";

interface RestroomFormProps {
  businessId: string;
  businessName?: string;
  initialData?: Partial<Restroom>;
  mode: "create" | "edit";
  publicationStatus?: PublicationStatus;
  onSuccess?: (savedRestroom: any) => void;
  onCancel?: () => void;
}

export default function RestroomForm({
  businessId,
  businessName,
  initialData,
  mode,
  publicationStatus = "draft",
  onSuccess,
  onCancel,
}: RestroomFormProps) {
  const router = useRouter();
  const isEdit = mode === "edit";
  const isPublished = isEdit && publicationStatus === "published";

  // Form State
  const [name, setName] = useState(initialData?.name || "");
  const [description, setDescription] = useState(initialData?.description || "");
  const [roadAddress, setRoadAddress] = useState(initialData?.road_address || "");
  const [addressDetail, setAddressDetail] = useState(initialData?.address_detail || "");
  const [latitude, setLatitude] = useState<string>(
    initialData?.latitude !== undefined && initialData?.latitude !== null
      ? String(initialData.latitude)
      : ""
  );
  const [longitude, setLongitude] = useState<string>(
    initialData?.longitude !== undefined && initialData?.longitude !== null
      ? String(initialData.longitude)
      : ""
  );
  const [floor, setFloor] = useState(initialData?.floor || "");
  const [entranceInstructions, setEntranceInstructions] = useState(
    initialData?.entrance_instructions || ""
  );
  const [genderType, setGenderType] = useState<GenderType>(
    initialData?.gender_type || "separate"
  );
  const [wheelchairAccessible, setWheelchairAccessible] = useState<boolean>(
    Boolean(initialData?.wheelchair_accessible)
  );
  const [babyChangingAvailable, setBabyChangingAvailable] = useState<boolean>(
    Boolean(initialData?.baby_changing_available)
  );
  const [sanitaryProductsAvailable, setSanitaryProductsAvailable] = useState<boolean>(
    Boolean(initialData?.sanitary_products_available)
  );
  const [accessMethod, setAccessMethod] = useState<AccessMethod>(
    initialData?.access_method || "ask_staff"
  );

  // Policy Mode (only for new creation)
  const [policyMode, setPolicyMode] = useState<"free_with_ad" | "deposit_with_ad">(
    "free_with_ad"
  );

  // Status & Validation
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    setFieldErrors({});
    setServerError(null);
    setSuccessMessage(null);

    const parsedLat = parseFloat(latitude);
    const parsedLng = parseFloat(longitude);

    if (isNaN(parsedLat)) {
      setFieldErrors((prev) => ({ ...prev, latitude: "위도를 올바른 숫자로 입력해 주세요." }));
      return;
    }
    if (isNaN(parsedLng)) {
      setFieldErrors((prev) => ({ ...prev, longitude: "경도를 올바른 숫자로 입력해 주세요." }));
      return;
    }

    const idempotencyKey = crypto.randomUUID();

    try {
      setIsSubmitting(true);

      if (mode === "create") {
        const payload = {
          business_id: businessId,
          name: name.trim(),
          description: description.trim() || undefined,
          road_address: roadAddress.trim(),
          address_detail: addressDetail.trim() || undefined,
          latitude: parsedLat,
          longitude: parsedLng,
          floor: floor.trim() || undefined,
          entrance_instructions: entranceInstructions.trim() || undefined,
          gender_type: genderType,
          wheelchair_accessible: wheelchairAccessible,
          baby_changing_available: babyChangingAvailable,
          sanitary_products_available: sanitaryProductsAvailable,
          access_method: accessMethod,
          policy_mode: policyMode,
        };

        const validation = createMerchantRestroomSchema.safeParse(payload);
        if (!validation.success) {
          const errors: Record<string, string> = {};
          validation.error.issues.forEach((issue) => {
            const key = issue.path[0];
            if (key) errors[String(key)] = issue.message;
          });
          setFieldErrors(errors);
          setIsSubmitting(false);
          return;
        }

        const res = await fetch("/api/v1/merchant/restrooms", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-idempotency-key": idempotencyKey,
          },
          body: JSON.stringify(payload),
        });

        const data = await res.json();

        if (!res.ok || !data.ok) {
          throw new Error(data.error?.message || "화장실 등록에 실패했습니다.");
        }

        setSuccessMessage("화장실이 임시저장(draft) 상태로 등록되었습니다.");
        if (onSuccess) {
          onSuccess(data.data);
        } else {
          router.push(`/merchant/restrooms/${data.data.id}`);
        }
      } else {
        // Edit Mode
        const patch: Record<string, any> = {
          name: name.trim(),
          description: description.trim() || null,
          address_detail: addressDetail.trim() || null,
          floor: floor.trim() || null,
          entrance_instructions: entranceInstructions.trim() || null,
          gender_type: genderType,
          wheelchair_accessible: wheelchairAccessible,
          baby_changing_available: babyChangingAvailable,
          sanitary_products_available: sanitaryProductsAvailable,
          access_method: accessMethod,
        };

        // If not published, road_address, lat, lng can be modified
        if (!isPublished) {
          patch.road_address = roadAddress.trim();
          patch.latitude = parsedLat;
          patch.longitude = parsedLng;
        }

        const validation = updateMerchantRestroomSchema.safeParse(patch);
        if (!validation.success) {
          const errors: Record<string, string> = {};
          validation.error.issues.forEach((issue) => {
            const key = issue.path[0];
            if (key) errors[String(key)] = issue.message;
          });
          setFieldErrors(errors);
          setIsSubmitting(false);
          return;
        }

        const restroomId = initialData?.id;
        if (!restroomId) {
          throw new Error("수정할 화장실 식별자(ID)가 없습니다.");
        }

        const res = await fetch(`/api/v1/merchant/restrooms/${restroomId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "x-idempotency-key": idempotencyKey,
          },
          body: JSON.stringify(patch),
        });

        const data = await res.json();

        if (!res.ok || !data.ok) {
          throw new Error(data.error?.message || "화장실 정보 수정에 실패했습니다.");
        }

        setSuccessMessage("화장실 정보가 성공적으로 수정되었습니다.");
        if (onSuccess) {
          onSuccess(data.data);
        }
      }
    } catch (err: unknown) {
      setServerError(err instanceof Error ? err.message : "요청 처리 중 오류가 발생했습니다.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      data-testid="merchant-restroom-form"
      className="flex flex-col gap-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      {/* 가게 정보 표시 */}
      {businessName && (
        <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
          <span className="font-semibold text-slate-900 dark:text-white">등록 가게: </span>
          {businessName}
        </div>
      )}

      {/* 공개 화장실 핵심 위치 수정 잠금 안내 */}
      {isPublished && (
        <div
          role="alert"
          data-testid="restroom-location-locked-alert"
          className="rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <p className="font-bold flex items-center gap-1.5">
            <span>🔒</span> 공개된 화장실 보호 (위치 수정 제한)
          </p>
          <p className="mt-1 leading-relaxed">
            이미 공개 승인된 화장실의 위치 및 도로명주소는 임의로 변경할 수 없습니다. 위치 수정이 필요한 경우 관리자에게 문의해 주세요.
          </p>
        </div>
      )}

      {/* 서버 오류 알림 */}
      {serverError && (
        <div
          role="alert"
          data-testid="restroom-form-error"
          className="rounded-xl border border-rose-300 bg-rose-50 p-3.5 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <p className="font-semibold">⚠️ {serverError}</p>
        </div>
      )}

      {/* 성공 알림 */}
      {successMessage && (
        <div
          role="status"
          data-testid="restroom-form-success"
          className="rounded-xl border border-emerald-300 bg-emerald-50 p-3.5 text-xs text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
        >
          <p className="font-semibold">✓ {successMessage}</p>
        </div>
      )}

      {/* 1. 기본 정보 */}
      <div className="space-y-3">
        <h3 className="text-sm font-bold text-slate-900 dark:text-white">1. 기본 정보</h3>

        {/* 화장실 이름 */}
        <div>
          <label htmlFor="restroom-name" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
            화장실 이름 <span className="text-rose-500">*</span>
          </label>
          <input
            id="restroom-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="예: 1층 고객용 화장실, 매장 전용 화장실"
            maxLength={200}
            required
            className="mt-1 block w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white min-h-[44px]"
          />
          {fieldErrors.name && (
            <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{fieldErrors.name}</p>
          )}
        </div>

        {/* 설명 */}
        <div>
          <label htmlFor="restroom-description" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
            상세 설명 (선택)
          </label>
          <textarea
            id="restroom-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="화장실 이용 관련 안내나 청결 상태, 특이사항을 적어주세요."
            rows={2}
            maxLength={2000}
            className="mt-1 block w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
          />
          {fieldErrors.description && (
            <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{fieldErrors.description}</p>
          )}
        </div>
      </div>

      {/* 2. 위치 및 출입 안내 */}
      <div className="space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
        <h3 className="text-sm font-bold text-slate-900 dark:text-white">2. 위치 및 출입 안내</h3>

        {/* 도로명 주소 */}
        <div>
          <label htmlFor="restroom-road-address" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
            도로명주소 <span className="text-rose-500">*</span>
          </label>
          <input
            id="restroom-road-address"
            type="text"
            value={roadAddress}
            disabled={isPublished}
            onChange={(e) => setRoadAddress(e.target.value)}
            placeholder="예: 경기도 수원시 팔달구 매산로 1"
            maxLength={300}
            required
            className={`mt-1 block w-full rounded-xl border px-3 py-2.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none dark:bg-slate-800 dark:text-white min-h-[44px] ${
              isPublished
                ? "cursor-not-allowed bg-slate-100 border-slate-200 dark:bg-slate-800/40 dark:border-slate-700 text-slate-500"
                : "border-slate-300 bg-white dark:border-slate-700"
            }`}
          />
          {fieldErrors.road_address && (
            <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{fieldErrors.road_address}</p>
          )}
        </div>

        {/* 상세 주소 및 층수 */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="restroom-address-detail" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              상세주소 (선택)
            </label>
            <input
              id="restroom-address-detail"
              type="text"
              value={addressDetail}
              onChange={(e) => setAddressDetail(e.target.value)}
              placeholder="예: 101호 뒤편 복도"
              maxLength={200}
              className="mt-1 block w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white min-h-[44px]"
            />
          </div>

          <div>
            <label htmlFor="restroom-floor" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              층수 (선택)
            </label>
            <input
              id="restroom-floor"
              type="text"
              value={floor}
              onChange={(e) => setFloor(e.target.value)}
              placeholder="예: 1층, 지하 1층"
              maxLength={50}
              className="mt-1 block w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white min-h-[44px]"
            />
          </div>
        </div>

        {/* 좌표 (위도, 경도) - 360px 모바일 1열 스택 */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="restroom-latitude" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              위도 (Latitude) <span className="text-rose-500">*</span>
            </label>
            <input
              id="restroom-latitude"
              type="number"
              step="any"
              value={latitude}
              disabled={isPublished}
              onChange={(e) => setLatitude(e.target.value)}
              placeholder="37.2636"
              required
              className={`mt-1 block w-full rounded-xl border px-3 py-2.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none dark:bg-slate-800 dark:text-white min-h-[44px] ${
                isPublished
                  ? "cursor-not-allowed bg-slate-100 border-slate-200 dark:bg-slate-800/40 dark:border-slate-700 text-slate-500"
                  : "border-slate-300 bg-white dark:border-slate-700"
              }`}
            />
            {fieldErrors.latitude && (
              <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{fieldErrors.latitude}</p>
            )}
          </div>

          <div>
            <label htmlFor="restroom-longitude" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              경도 (Longitude) <span className="text-rose-500">*</span>
            </label>
            <input
              id="restroom-longitude"
              type="number"
              step="any"
              value={longitude}
              disabled={isPublished}
              onChange={(e) => setLongitude(e.target.value)}
              placeholder="127.0286"
              required
              className={`mt-1 block w-full rounded-xl border px-3 py-2.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none dark:bg-slate-800 dark:text-white min-h-[44px] ${
                isPublished
                  ? "cursor-not-allowed bg-slate-100 border-slate-200 dark:bg-slate-800/40 dark:border-slate-700 text-slate-500"
                  : "border-slate-300 bg-white dark:border-slate-700"
              }`}
            />
            {fieldErrors.longitude && (
              <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{fieldErrors.longitude}</p>
            )}
          </div>
        </div>
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          📍 WGS84 소수점 좌표 (예: 수원역 부근 37.2636, 127.0286)
        </p>

        {/* 출입 안내 */}
        <div>
          <label htmlFor="restroom-entrance-instructions" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
            출입 및 진입 경로 안내 (선택)
          </label>
          <textarea
            id="restroom-entrance-instructions"
            value={entranceInstructions}
            onChange={(e) => setEntranceInstructions(e.target.value)}
            placeholder="예: 매장 카운터 우측 복도 끝 문으로 들어가시면 됩니다."
            rows={2}
            maxLength={500}
            className="mt-1 block w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
          />
        </div>
      </div>

      {/* 3. 구분 및 편의시설 */}
      <div className="space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
        <h3 className="text-sm font-bold text-slate-900 dark:text-white">3. 구분 및 편의시설</h3>

        {/* 성별 구분 */}
        <div>
          <label htmlFor="restroom-gender-type" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
            성별 구분
          </label>
          <select
            id="restroom-gender-type"
            value={genderType}
            onChange={(e) => setGenderType(e.target.value as GenderType)}
            className="mt-1 block w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-xs text-slate-900 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white min-h-[44px]"
          >
            <option value="separate">남녀 분리</option>
            <option value="unisex">남녀 공용</option>
            <option value="male">남성 전용</option>
            <option value="female">여성 전용</option>
            <option value="unknown">성별 구분 미확인</option>
          </select>
        </div>

        {/* 편의시설 체크박스 */}
        <fieldset className="space-y-2 pt-1">
          <legend className="text-xs font-semibold text-slate-700 dark:text-slate-300">
            편의시설 지원 여부
          </legend>

          <label className="flex items-center gap-2.5 cursor-pointer text-xs text-slate-800 dark:text-slate-200 min-h-[36px]">
            <input
              type="checkbox"
              checked={wheelchairAccessible}
              onChange={(e) => setWheelchairAccessible(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800"
            />
            <span>♿ 장애인 편의시설 / 휠체어 접근 가능</span>
          </label>

          <label className="flex items-center gap-2.5 cursor-pointer text-xs text-slate-800 dark:text-slate-200 min-h-[36px]">
            <input
              type="checkbox"
              checked={babyChangingAvailable}
              onChange={(e) => setBabyChangingAvailable(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800"
            />
            <span>👶 기저귀 교환대 구비</span>
          </label>

          <label className="flex items-center gap-2.5 cursor-pointer text-xs text-slate-800 dark:text-slate-200 min-h-[36px]">
            <input
              type="checkbox"
              checked={sanitaryProductsAvailable}
              onChange={(e) => setSanitaryProductsAvailable(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800"
            />
            <span>🧴 여성 위생용품 구비</span>
          </label>
        </fieldset>

        {/* 출입 방식 */}
        <div>
          <label htmlFor="restroom-access-method" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
            출입 방식
          </label>
          <select
            id="restroom-access-method"
            value={accessMethod}
            onChange={(e) => setAccessMethod(e.target.value as AccessMethod)}
            className="mt-1 block w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-xs text-slate-900 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white min-h-[44px]"
          >
            <option value="ask_staff">직원 문의 (카운터 문의 후 개방)</option>
            <option value="open">상시 개방 (자유 출입)</option>
            <option value="pin">도어락 비밀번호 잠금</option>
          </select>

          {accessMethod === "pin" && (
            <p className="mt-1.5 rounded-lg bg-blue-50 p-2.5 text-[11px] leading-relaxed text-blue-800 dark:bg-blue-950/40 dark:text-blue-300">
              🔒 <strong>도어락 비밀번호 안내:</strong> 도어락 PIN은 심사 승인 및 안전한 암호화 채널을 통해 등록·관리됩니다. (평문 비밀번호 노출 방지 원칙)
            </p>
          )}
        </div>
      </div>

      {/* 4. 초기 이용 정책 (신규 등록 시에만 노출) */}
      {!isEdit && (
        <div className="space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
          <h3 className="text-sm font-bold text-slate-900 dark:text-white">4. 이용 정책 선택</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            화장실 이용자에게 적용할 기본 정책을 선택해 주세요. 등록 후 상세 페이지에서 언제든지 정책 버전을 변경할 수 있습니다.
          </p>

          <div className="space-y-2">
            <label
              className={`flex items-start gap-3 rounded-xl border p-3 cursor-pointer transition ${
                policyMode === "free_with_ad"
                  ? "border-blue-500 bg-blue-50/50 dark:border-blue-600 dark:bg-blue-950/30"
                  : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
              }`}
            >
              <input
                type="radio"
                name="policy_mode"
                value="free_with_ad"
                checked={policyMode === "free_with_ad"}
                onChange={() => setPolicyMode("free_with_ad")}
                className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500"
              />
              <div className="text-xs">
                <span className="font-bold text-slate-900 dark:text-white">무료 모드 (광고 기반)</span>
                <p className="mt-0.5 text-slate-500 dark:text-slate-400 leading-relaxed">
                  보증금 없이 무료로 이용할 수 있는 화장실입니다. (보증금 0원, 환급 조건 없음)
                </p>
              </div>
            </label>

            <label
              className={`flex items-start gap-3 rounded-xl border p-3 cursor-pointer transition ${
                policyMode === "deposit_with_ad"
                  ? "border-blue-500 bg-blue-50/50 dark:border-blue-600 dark:bg-blue-950/30"
                  : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
              }`}
            >
              <input
                type="radio"
                name="policy_mode"
                value="deposit_with_ad"
                checked={policyMode === "deposit_with_ad"}
                onChange={() => setPolicyMode("deposit_with_ad")}
                className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500"
              />
              <div className="text-xs">
                <span className="font-bold text-slate-900 dark:text-white">테스트 보증금 모드 (환급형)</span>
                <p className="mt-0.5 text-slate-500 dark:text-slate-400 leading-relaxed">
                  테스트 보증금 1,000원이 설정되며, 24시간 이내 영수증 인증 시 전액 환급됩니다.
                </p>
                <span className="mt-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                  ⚠️ 개발 테스트 환경 · 실제 돈 차감 없음
                </span>
              </div>
            </label>
          </div>
        </div>
      )}

      {/* 제출 및 취소 버튼 */}
      <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            className="min-h-[44px] rounded-xl border border-slate-300 px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            취소
          </button>
        )}

        <button
          type="submit"
          disabled={isSubmitting}
          data-testid="restroom-form-submit-button"
          className="min-h-[44px] rounded-xl bg-blue-600 px-5 py-2.5 text-xs font-semibold text-white shadow-sm hover:bg-blue-700 active:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSubmitting
            ? "저장 중..."
            : isEdit
            ? "화장실 정보 수정 완료"
            : "화장실 등록 (임시저장)"}
        </button>
      </div>
    </form>
  );
}


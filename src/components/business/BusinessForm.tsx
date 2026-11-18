"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import type { Business, BusinessRegistrationStatus } from "@/lib/businesses/types";
import { createBusinessSchema } from "@/lib/businesses/validation";

interface BusinessFormProps {
  initialData?: Business | null;
  mode?: "create" | "edit";
  onSuccess?: (business: Business) => void;
}

export default function BusinessForm({
  initialData,
  mode = "create",
  onSuccess,
}: BusinessFormProps) {
  const router = useRouter();
  const isEdit = mode === "edit" && Boolean(initialData);

  const status: BusinessRegistrationStatus =
    initialData?.registration_status ?? "draft";
  const isApproved = status === "approved";
  const isPending = status === "pending";
  const isSuspended = status === "suspended";
  const isReadOnly = isPending || isSuspended;

  // Form states
  const [name, setName] = useState(initialData?.name ?? "");
  const [category, setCategory] = useState(initialData?.category ?? "카페");
  const [description, setDescription] = useState(
    initialData?.description ?? ""
  );
  const [roadAddress, setRoadAddress] = useState(
    initialData?.road_address ?? ""
  );
  const [jibunAddress, setJibunAddress] = useState(
    initialData?.jibun_address ?? ""
  );
  const [addressDetail, setAddressDetail] = useState(
    initialData?.address_detail ?? ""
  );
  const [latitude, setLatitude] = useState<string>(
    initialData?.latitude != null ? String(initialData.latitude) : ""
  );
  const [longitude, setLongitude] = useState<string>(
    initialData?.longitude != null ? String(initialData.longitude) : ""
  );
  const [phone, setPhone] = useState(initialData?.phone ?? "");
  const [websiteUrl, setWebsiteUrl] = useState(
    initialData?.website_url ?? ""
  );
  const [registrationNumber, setRegistrationNumber] = useState("");

  // UI status
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmittingReview, setIsSubmittingReview] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const validateForm = () => {
    setFieldErrors({});
    setErrorBanner(null);

    const latNum = parseFloat(latitude);
    const lngNum = parseFloat(longitude);

    if (mode === "create") {
      const parsed = createBusinessSchema.safeParse({
        name,
        category,
        description: description || null,
        road_address: roadAddress,
        jibun_address: jibunAddress || null,
        address_detail: addressDetail || null,
        latitude: isNaN(latNum) ? -999 : latNum,
        longitude: isNaN(lngNum) ? -999 : lngNum,
        phone: phone || null,
        website_url: websiteUrl || null,
        registration_number: registrationNumber || null,
      });

      const errors: Record<string, string> = {};
      if (isNaN(latNum)) {
        errors.latitude = "유효한 위도 숫자를 입력해 주세요.";
      }
      if (isNaN(lngNum)) {
        errors.longitude = "유효한 경도 숫자를 입력해 주세요.";
      }

      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const path = issue.path[0]?.toString() ?? "general";
          if (!errors[path]) {
            errors[path] = issue.message;
          }
        }
      }

      if (Object.keys(errors).length > 0) {
        setFieldErrors(errors);
        setErrorBanner("입력한 정보에 오류가 있습니다. 확인 후 다시 시도해 주세요.");
        return false;
      }
    } else {
      const errors: Record<string, string> = {};
      if (!isApproved) {
        if (!name.trim()) errors.name = "가게명을 입력해 주세요.";
        if (!category.trim()) errors.category = "업종을 입력해 주세요.";
        if (!roadAddress.trim()) errors.road_address = "도로명주소를 입력해 주세요.";
        if (isNaN(latNum)) errors.latitude = "유효한 위도 숫자를 입력해 주세요.";
        if (isNaN(lngNum)) errors.longitude = "유효한 경도 숫자를 입력해 주세요.";
      }

      if (Object.keys(errors).length > 0) {
        setFieldErrors(errors);
        setErrorBanner("입력한 정보에 오류가 있습니다. 확인 후 다시 시도해 주세요.");
        return false;
      }
    }

    return true;
  };

  // 1. 임시저장 / 정보 수정 (Save Draft / Update)
  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isReadOnly) return;
    if (!validateForm()) return;

    setIsSubmitting(true);
    setErrorBanner(null);
    setSuccessBanner(null);

    try {
      const idempotencyKey = crypto.randomUUID();
      const latNum = parseFloat(latitude);
      const lngNum = parseFloat(longitude);

      if (mode === "create") {
        const res = await fetch("/api/v1/merchant/businesses", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-idempotency-key": idempotencyKey,
          },
          body: JSON.stringify({
            name: name.trim(),
            category: category.trim(),
            description: description.trim() || null,
            road_address: roadAddress.trim(),
            jibun_address: jibunAddress.trim() || null,
            address_detail: addressDetail.trim() || null,
            latitude: latNum,
            longitude: lngNum,
            phone: phone.trim() || null,
            website_url: websiteUrl.trim() || null,
            registration_number: registrationNumber.trim() || null,
          }),
        });

        const data = await res.json();
        if (!res.ok || !data.ok) {
          if (res.status === 401) {
            router.push("/login?returnTo=/merchant/businesses/new&reason=login_required");
            return;
          }
          throw new Error(data.error?.message || "가게 등록에 실패했습니다.");
        }

        setSuccessBanner("가게 등록 신청서(작성 중)가 저장되었습니다.");
        if (onSuccess) {
          onSuccess(data.business);
        } else {
          router.push(`/merchant/businesses/${data.business.id}`);
        }
      } else if (initialData) {
        // Edit mode (PATCH)
        // If approved store: only non-core operational fields can be updated
        const payload: Record<string, unknown> = {
          description: description.trim() || null,
          phone: phone.trim() || null,
          website_url: websiteUrl.trim() || null,
        };

        if (!isApproved) {
          payload.name = name.trim();
          payload.category = category.trim();
          payload.road_address = roadAddress.trim();
          payload.jibun_address = jibunAddress.trim() || null;
          payload.address_detail = addressDetail.trim() || null;
          payload.latitude = latNum;
          payload.longitude = lngNum;
        }

        const res = await fetch(`/api/v1/merchant/businesses/${initialData.id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "x-idempotency-key": idempotencyKey,
          },
          body: JSON.stringify(payload),
        });

        const data = await res.json();
        if (!res.ok || !data.ok) {
          if (res.status === 401) {
            router.push(`/login?returnTo=/merchant/businesses/${initialData.id}&reason=login_required`);
            return;
          }
          throw new Error(data.error?.message || "가게 정보 수정에 실패했습니다.");
        }

        setSuccessBanner("가게 정보가 성공적으로 수정되었습니다.");
        if (onSuccess) {
          onSuccess(data.business);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "저장 중 오류가 발생했습니다.";
      setErrorBanner(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  // 2. 심사 요청하기 (Submit for Review)
  const handleSubmitReview = async () => {
    if (!initialData || isReadOnly || isApproved) return;

    if (!confirm("가게 정보를 검토하고 심사를 요청하시겠습니까? 심사 중에는 정보 수정이 제한됩니다.")) {
      return;
    }

    setIsSubmittingReview(true);
    setErrorBanner(null);
    setSuccessBanner(null);

    try {
      const idempotencyKey = crypto.randomUUID();
      const res = await fetch(`/api/v1/merchant/businesses/${initialData.id}/submit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": idempotencyKey,
        },
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        if (res.status === 401) {
          router.push(`/login?returnTo=/merchant/businesses/${initialData.id}&reason=login_required`);
          return;
        }
        throw new Error(data.error?.message || "심사 요청에 실패했습니다.");
      }

      setSuccessBanner("관리자에게 심사 요청이 제출되었습니다. (심사 대기 중)");
      if (onSuccess) {
        onSuccess(data.business);
      } else {
        router.refresh();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "심사 요청 중 오류가 발생했습니다.";
      setErrorBanner(msg);
    } finally {
      setIsSubmittingReview(false);
    }
  };

  return (
    <form onSubmit={handleSave} noValidate className="flex flex-col gap-5 text-sm" data-testid="business-form">
      {/* 알림 배너 */}
      {errorBanner && (
        <div
          role="alert"
          data-testid="business-form-error"
          className="rounded-xl border border-rose-300 bg-rose-50 p-3 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-200"
        >
          {errorBanner}
        </div>
      )}

      {successBanner && (
        <div
          role="status"
          data-testid="business-form-success"
          className="rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200"
        >
          {successBanner}
        </div>
      )}

      {isApproved && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          ℹ️ 승인된 가게의 상호·업종·주소·위치 등 핵심 정보는 재심사 방지를 위해 직접 수정이 불가하며, 설명·전화·웹사이트 등 일반 운영 정보만 수정할 수 있습니다.
        </div>
      )}

      {isReadOnly && (
        <div className="rounded-xl border border-blue-200 bg-blue-50/70 p-3 text-xs text-blue-900 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-200">
          ℹ️ 현재 가게는 {isPending ? "심사 대기 중" : "운영 정지 상태"}이므로 정보를 수정할 수 없습니다.
        </div>
      )}

      {/* 기본 정보 그룹 */}
      <section className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-4 dark:border-slate-800 dark:bg-slate-900/60">
        <h2 className="text-sm font-bold text-slate-900 dark:text-white">기본 가게 정보</h2>

        {/* 상호명 */}
        <div>
          <label htmlFor="biz-name" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
            상호명 (가게 이름) <span className="text-rose-500">*</span>
          </label>
          <input
            id="biz-name"
            name="name"
            type="text"
            required
            disabled={isReadOnly || isApproved}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="예: 카페 휴지 수원역점"
            maxLength={100}
            className={`mt-1 flex min-h-[44px] w-full rounded-xl border bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-100 disabled:text-slate-500 dark:bg-slate-800 dark:text-white dark:disabled:bg-slate-900 ${
              fieldErrors.name ? "border-rose-400 ring-rose-200" : "border-slate-300 dark:border-slate-700"
            }`}
          />
          {fieldErrors.name && (
            <p className="mt-1 text-xs text-rose-500">{fieldErrors.name}</p>
          )}
        </div>

        {/* 업종 */}
        <div>
          <label htmlFor="biz-category" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
            업종 분류 <span className="text-rose-500">*</span>
          </label>
          <div className="mt-1 flex flex-col gap-2 sm:flex-row">
            <select
              id="biz-category-select"
              aria-label="업종 추천 선택"
              disabled={isReadOnly || isApproved}
              value={["카페", "음식점", "편의점", "서점/문구", "헬스/뷰티", "기타"].includes(category) ? category : "기타"}
              onChange={(e) => {
                if (e.target.value !== "기타") {
                  setCategory(e.target.value);
                }
              }}
              className="flex min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-white dark:disabled:bg-slate-900 sm:w-auto"
            >
              <option value="카페">카페</option>
              <option value="음식점">음식점</option>
              <option value="편의점">편의점</option>
              <option value="서점/문구">서점/문구</option>
              <option value="헬스/뷰티">헬스/뷰티</option>
              <option value="기타">직접 입력 (기타)</option>
            </select>
            <input
              id="biz-category"
              name="category"
              type="text"
              required
              disabled={isReadOnly || isApproved}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="업종 직접 입력 (예: 카페)"
              maxLength={50}
              className={`flex min-h-[44px] w-full min-w-0 flex-1 rounded-xl border bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-100 disabled:text-slate-500 dark:bg-slate-800 dark:text-white dark:disabled:bg-slate-900 ${
                fieldErrors.category ? "border-rose-400" : "border-slate-300 dark:border-slate-700"
              }`}
            />
          </div>
          {fieldErrors.category && (
            <p className="mt-1 text-xs text-rose-500">{fieldErrors.category}</p>
          )}
        </div>

        {/* 가게 설명 */}
        <div>
          <label htmlFor="biz-description" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
            가게 소개 (선택)
          </label>
          <textarea
            id="biz-description"
            name="description"
            disabled={isReadOnly}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="가게 운영 시간, 화장실 위치 안내, 손님을 위한 간단한 소개를 입력해 주세요."
            rows={3}
            maxLength={1000}
            className="mt-1 flex w-full rounded-xl border border-slate-300 bg-white p-3 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-white dark:disabled:bg-slate-900"
          />
        </div>
      </section>

      {/* 위치 및 주소 그룹 */}
      <section className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-4 dark:border-slate-800 dark:bg-slate-900/60">
        <h2 className="text-sm font-bold text-slate-900 dark:text-white">가게 위치 및 주소</h2>

        {/* 도로명주소 */}
        <div>
          <label htmlFor="biz-road-address" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
            도로명주소 <span className="text-rose-500">*</span>
          </label>
          <input
            id="biz-road-address"
            name="road_address"
            type="text"
            required
            disabled={isReadOnly || isApproved}
            value={roadAddress}
            onChange={(e) => setRoadAddress(e.target.value)}
            placeholder="예: 경기도 수원시 팔달구 매산로 1"
            maxLength={200}
            className={`mt-1 flex min-h-[44px] w-full rounded-xl border bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-100 dark:bg-slate-800 dark:text-white dark:disabled:bg-slate-900 ${
              fieldErrors.road_address ? "border-rose-400" : "border-slate-300 dark:border-slate-700"
            }`}
          />
          {fieldErrors.road_address && (
            <p className="mt-1 text-xs text-rose-500">{fieldErrors.road_address}</p>
          )}
        </div>

        {/* 지번주소 / 상세주소 */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="min-w-0">
            <label htmlFor="biz-jibun-address" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              지번주소 (선택)
            </label>
            <input
              id="biz-jibun-address"
              name="jibun_address"
              type="text"
              disabled={isReadOnly || isApproved}
              value={jibunAddress}
              onChange={(e) => setJibunAddress(e.target.value)}
              placeholder="예: 매산로1가 18"
              maxLength={200}
              className="mt-1 flex min-h-[44px] w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-white dark:disabled:bg-slate-900"
            />
          </div>
          <div className="min-w-0">
            <label htmlFor="biz-address-detail" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              상세주소 (선택)
            </label>
            <input
              id="biz-address-detail"
              name="address_detail"
              type="text"
              disabled={isReadOnly || isApproved}
              value={addressDetail}
              onChange={(e) => setAddressDetail(e.target.value)}
              placeholder="예: 1층 101호"
              maxLength={100}
              className="mt-1 flex min-h-[44px] w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-white dark:disabled:bg-slate-900"
            />
          </div>
        </div>

        {/* 좌표 입력 */}
        <div>
          <label htmlFor="biz-latitude" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
            가게 위치 좌표 (WGS84 위도 / 경도) <span className="text-rose-500">*</span>
          </label>
          <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="min-w-0">
              <input
                id="biz-latitude"
                aria-label="위도 (Latitude)"
                name="latitude"
                type="number"
                step="any"
                required
                disabled={isReadOnly || isApproved}
                value={latitude}
                onChange={(e) => setLatitude(e.target.value)}
                placeholder="위도 (예: 37.5401)"
                className={`flex min-h-[44px] w-full min-w-0 rounded-xl border bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-100 dark:bg-slate-800 dark:text-white dark:disabled:bg-slate-900 ${
                  fieldErrors.latitude ? "border-rose-400" : "border-slate-300 dark:border-slate-700"
                }`}
              />
              {fieldErrors.latitude && (
                <p className="mt-1 text-xs text-rose-500">{fieldErrors.latitude}</p>
              )}
            </div>
            <div className="min-w-0">
              <input
                id="biz-longitude"
                aria-label="경도 (Longitude)"
                name="longitude"
                type="number"
                step="any"
                required
                disabled={isReadOnly || isApproved}
                value={longitude}
                onChange={(e) => setLongitude(e.target.value)}
                placeholder="경도 (예: 127.0701)"
                className={`flex min-h-[44px] w-full min-w-0 rounded-xl border bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-100 dark:bg-slate-800 dark:text-white dark:disabled:bg-slate-900 ${
                  fieldErrors.longitude ? "border-rose-400" : "border-slate-300 dark:border-slate-700"
                }`}
              />
              {fieldErrors.longitude && (
                <p className="mt-1 text-xs text-rose-500">{fieldErrors.longitude}</p>
              )}
            </div>
          </div>
          <div className="mt-2 rounded-lg bg-slate-100/80 p-2.5 text-[11px] leading-relaxed text-slate-600 dark:bg-slate-800/60 dark:text-slate-400">
            <p className="font-semibold text-slate-700 dark:text-slate-300">📍 좌표 입력 안내</p>
            <p className="mt-0.5">
              실제 가게 위치의 위도(-90~90)와 경도(-180~180) 소수점 좌표를 직접 입력해 주세요.
            </p>
            <p className="mt-0.5 text-slate-500">
              ※ 주소 기반 자동 지도 핀 선택 기능은 향후 지도 연동(TASK 15)에서 지원될 예정입니다. 임의의 가짜 좌표 등록을 방지하기 위해 실제 위치를 확인 후 입력해 주세요.
            </p>
          </div>
        </div>
      </section>

      {/* 연락처 및 검증 정보 그룹 */}
      <section className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-4 dark:border-slate-800 dark:bg-slate-900/60">
        <h2 className="text-sm font-bold text-slate-900 dark:text-white">연락처 및 사업자 확인</h2>

        {/* 전화번호 */}
        <div>
          <label htmlFor="biz-phone" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
            가게 연락처 (전화번호)
          </label>
          <input
            id="biz-phone"
            name="phone"
            type="tel"
            disabled={isReadOnly}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="예: 031-123-4567"
            maxLength={30}
            className="mt-1 flex min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-white dark:disabled:bg-slate-900"
          />
        </div>

        {/* 웹사이트 URL */}
        <div>
          <label htmlFor="biz-website" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
            웹사이트 / SNS URL
          </label>
          <input
            id="biz-website"
            name="website_url"
            type="url"
            disabled={isReadOnly}
            value={websiteUrl}
            onChange={(e) => setWebsiteUrl(e.target.value)}
            placeholder="예: https://instagram.com/my_cafe"
            maxLength={300}
            className={`mt-1 flex min-h-[44px] w-full rounded-xl border bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-100 dark:bg-slate-800 dark:text-white dark:disabled:bg-slate-900 ${
              fieldErrors.website_url ? "border-rose-400" : "border-slate-300 dark:border-slate-700"
            }`}
          />
          {fieldErrors.website_url && (
            <p className="mt-1 text-xs text-rose-500">{fieldErrors.website_url}</p>
          )}
        </div>

        {/* 사업자등록번호 (신규 등록 시에만 안전하게 입력받음) */}
        {mode === "create" && (
          <div>
            <label htmlFor="biz-reg-number" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              사업자등록번호 (선택)
            </label>
            <input
              id="biz-reg-number"
              name="registration_number"
              type="text"
              value={registrationNumber}
              onChange={(e) => setRegistrationNumber(e.target.value)}
              placeholder="예: 123-45-67890 (숫자 10자리)"
              maxLength={12}
              className={`mt-1 flex min-h-[44px] w-full rounded-xl border bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-slate-800 dark:text-white ${
                fieldErrors.registration_number ? "border-rose-400" : "border-slate-300 dark:border-slate-700"
              }`}
            />
            <p className="mt-1 text-[11px] text-slate-500">
              * 사업자등록번호는 비공개 검증 근거로만 안전하게 저장되며, 일반 사용자 및 화면에 노출되지 않습니다.
            </p>
            {fieldErrors.registration_number && (
              <p className="mt-1 text-xs text-rose-500">{fieldErrors.registration_number}</p>
            )}
          </div>
        )}
      </section>

      {/* 조작 버튼 영역 */}
      <div className="flex flex-col gap-2.5 pt-2">
        {!isReadOnly && (
          <button
            type="submit"
            disabled={isSubmitting || isSubmittingReview}
            data-testid="business-form-submit-button"
            className="flex min-h-[48px] w-full items-center justify-center rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50"
          >
            {isSubmitting
              ? "저장 중..."
              : isEdit
              ? "수정 내용 저장하기"
              : "가게 등록 신청서 작성 (임시저장)"}
          </button>
        )}

        {/* 심사 요청 버튼 (Edit 모드에서 draft 또는 rejected 상태일 때 표시) */}
        {isEdit && (status === "draft" || status === "rejected") && (
          <button
            type="button"
            onClick={handleSubmitReview}
            disabled={isSubmitting || isSubmittingReview}
            data-testid="business-submit-review-button"
            className="flex min-h-[48px] w-full items-center justify-center rounded-xl border border-emerald-600 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800 shadow-sm transition hover:bg-emerald-100 active:bg-emerald-200 disabled:opacity-50 dark:bg-emerald-950/50 dark:text-emerald-200"
          >
            {isSubmittingReview ? "심사 요청 제출 중..." : "🚀 관리자에게 심사 요청하기"}
          </button>
        )}

        <button
          type="button"
          onClick={() => router.push("/merchant/businesses")}
          className="flex min-h-[44px] w-full items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
        >
          목록으로 돌아가기
        </button>
      </div>
    </form>
  );
}

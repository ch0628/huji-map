"use client";

import React, { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  Restroom,
  RestroomHour,
  GenderType,
  AccessMethod,
  PublicationStatus,
} from "@/lib/restrooms/types";
import {
  createMerchantRestroomSchema,
  updateMerchantRestroomSchema,
  type RestroomHourInput,
} from "@/lib/restrooms/merchant-validation";
import { setRestroomPinSchema } from "@/lib/access/crypto/types";
import type { AddressSearchFn, AddressSearchResult } from "@/lib/maps/address-search";
import AddressSearchField from "@/components/map/AddressSearchField";
import { focusFirstErrorField } from "@/lib/forms/validation-ux";
import RestroomPhotoManager, {
  uploadRestroomPhotoFile,
  type QueuedRestroomPhoto,
  type RestroomPhotoUploadFn,
} from "@/components/restroom/RestroomPhotoManager";

type WeekdayMode = "unset" | "open" | "closed";

interface WeekdayHourState {
  mode: WeekdayMode;
  opensAt: string;
  closesAt: string;
}

const WEEKDAY_DISPLAY_ORDER: ReadonlyArray<{ weekday: number; label: string }> = [
  { weekday: 1, label: "월요일" },
  { weekday: 2, label: "화요일" },
  { weekday: 3, label: "수요일" },
  { weekday: 4, label: "목요일" },
  { weekday: 5, label: "금요일" },
  { weekday: 6, label: "토요일" },
  { weekday: 0, label: "일요일" },
];

function buildInitialHoursMap(
  hoursList?: readonly Partial<RestroomHour>[]
): Record<number, WeekdayHourState> {
  const result: Record<number, WeekdayHourState> = {};
  for (let d = 0; d <= 6; d++) {
    result[d] = { mode: "unset", opensAt: "09:00", closesAt: "22:00" };
  }
  if (!hoursList || hoursList.length === 0) {
    return result;
  }
  for (const h of hoursList) {
    if (typeof h.weekday !== "number" || h.weekday < 0 || h.weekday > 6) continue;
    if (h.is_closed) {
      result[h.weekday] = { mode: "closed", opensAt: "09:00", closesAt: "22:00" };
    } else if (h.opens_at && h.closes_at) {
      result[h.weekday] = {
        mode: "open",
        opensAt: h.opens_at.slice(0, 5),
        closesAt: h.closes_at.slice(0, 5),
      };
    }
  }
  return result;
}

export interface BusinessRestroomDefaults {
  name?: string;
  roadAddress?: string;
  addressDetail?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

interface RestroomFormProps {
  businessId: string;
  businessName?: string;
  businessDefaults?: BusinessRestroomDefaults;
  initialData?: Partial<Restroom> & { hours?: RestroomHour[] };
  initialHours?: RestroomHour[];
  mode: "create" | "edit";
  publicationStatus?: PublicationStatus;
  onSuccess?: (savedRestroom: any) => void;
  onCancel?: () => void;
  addressSearchFn?: AddressSearchFn;
  photoUploadFn?: RestroomPhotoUploadFn;
}

function resolveCoord(
  primary?: number | null,
  fallback?: number | null
): number | null {
  if (primary !== undefined && primary !== null && Number.isFinite(primary)) {
    return primary;
  }
  if (fallback !== undefined && fallback !== null && Number.isFinite(fallback)) {
    return fallback;
  }
  return null;
}

export default function RestroomForm({
  businessId,
  businessName,
  businessDefaults,
  initialData,
  initialHours,
  mode,
  publicationStatus = "draft",
  onSuccess,
  onCancel,
  addressSearchFn,
  photoUploadFn = uploadRestroomPhotoFile,
}: RestroomFormProps) {
  const router = useRouter();
  const isEdit = mode === "edit";
  const isPublished = isEdit && publicationStatus === "published";

  // 1. 기본 정보 + 위치 (신규 등록 시 승인 가게 정보 자동 적용)
  const [name, setName] = useState(
    initialData?.name ||
      (!isEdit && businessDefaults?.name ? `${businessDefaults.name} 화장실` : "")
  );
  const [description, setDescription] = useState(initialData?.description || "");
  const [roadAddress, setRoadAddress] = useState(
    initialData?.road_address ||
      (!isEdit && businessDefaults?.roadAddress ? businessDefaults.roadAddress : "")
  );
  const [addressDetail, setAddressDetail] = useState(
    initialData?.address_detail ||
      (!isEdit && businessDefaults?.addressDetail ? businessDefaults.addressDetail : "")
  );

  const initLat = resolveCoord(
    initialData?.latitude,
    !isEdit ? businessDefaults?.latitude : null
  );
  const initLng = resolveCoord(
    initialData?.longitude,
    !isEdit ? businessDefaults?.longitude : null
  );
  const validInitCoords =
    initLat !== null && initLng !== null && !(initLat === 0 && initLng === 0);

  const [latitude, setLatitude] = useState<number | null>(validInitCoords ? initLat : null);
  const [longitude, setLongitude] = useState<number | null>(validInitCoords ? initLng : null);
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

  // 신규 등록 최초 PIN 설정 (휘발성 React 상태에만 보관, 저장 즉시 초기화)
  const [initialPin, setInitialPin] = useState("");
  const [initialPinConfirm, setInitialPinConfirm] = useState("");
  const [showInitialPin, setShowInitialPin] = useState(false);

  // 운영시간
  const [hoursByDay, setHoursByDay] = useState<Record<number, WeekdayHourState>>(() =>
    buildInitialHoursMap(initialHours ?? initialData?.hours)
  );

  // 이용 정책 (신규 등록 전용)
  const [policyMode, setPolicyMode] = useState<"free_with_ad" | "deposit_with_ad">(
    "free_with_ad"
  );
  const [depositAmountInput, setDepositAmountInput] = useState<string>("1000");

  // 사진 대기열 및 멱등 재시도용 참조
  const [queuedPhotos, setQueuedPhotos] = useState<QueuedRestroomPhoto[]>([]);
  const createdDraftRef = useRef<any | null>(null);
  const pinSavedRef = useRef<boolean>(false);

  // 제출 상태
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitIntent, setSubmitIntent] = useState<"draft" | "submit_review" | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const updateDayHours = (weekday: number, patch: Partial<WeekdayHourState>) => {
    setHoursByDay((prev) => ({
      ...prev,
      [weekday]: { ...prev[weekday], ...patch },
    }));
  };

  const applyDailyPreset = () => {
    setHoursByDay(() => {
      const next: Record<number, WeekdayHourState> = {};
      for (let d = 0; d <= 6; d++) {
        next[d] = { mode: "open", opensAt: "09:00", closesAt: "22:00" };
      }
      return next;
    });
  };

  const applyWeekdayOnlyPreset = () => {
    setHoursByDay(() => {
      const next: Record<number, WeekdayHourState> = {};
      for (let d = 0; d <= 6; d++) {
        if (d === 0 || d === 6) {
          next[d] = { mode: "closed", opensAt: "09:00", closesAt: "18:00" };
        } else {
          next[d] = { mode: "open", opensAt: "09:00", closesAt: "18:00" };
        }
      }
      return next;
    });
  };

  const clearHoursPreset = () => {
    setHoursByDay(buildInitialHoursMap([]));
  };

  const buildHoursPayload = (): { hours: RestroomHourInput[]; error: string | null } => {
    const result: RestroomHourInput[] = [];
    for (const { weekday, label } of WEEKDAY_DISPLAY_ORDER) {
      const state = hoursByDay[weekday];
      if (!state || state.mode === "unset") continue;
      if (state.mode === "closed") {
        result.push({
          weekday,
          is_closed: true,
          opens_at: null,
          closes_at: null,
        });
      } else {
        if (!state.opensAt || !state.closesAt) {
          return {
            hours: [],
            error: `${label} 운영시간의 시작·종료 시간을 모두 입력해 주세요.`,
          };
        }
        if (state.opensAt.slice(0, 5) === state.closesAt.slice(0, 5)) {
          return {
            hours: [],
            error: `${label}의 시작 시간과 종료 시간은 같을 수 없습니다.`,
          };
        }
        result.push({
          weekday,
          is_closed: false,
          opens_at: state.opensAt,
          closes_at: state.closesAt,
        });
      }
    }
    return { hours: result, error: null };
  };

  const hasValidCoordinates =
    latitude !== null &&
    longitude !== null &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    !(latitude === 0 && longitude === 0);

  const handleSelectAddress = (result: AddressSearchResult) => {
    setRoadAddress(result.roadAddress);
    setLatitude(result.lat);
    setLongitude(result.lng);
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next.road_address;
      delete next.latitude;
      delete next.longitude;
      delete next.coordinates;
      return next;
    });
  };

  const clearFieldError = (key: string) => {
    setFieldErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const handleSubmitFlow = async (action: "draft" | "submit_review" | "edit") => {
    if (isSubmitting) return;

    setFieldErrors({});
    setServerError(null);
    setSuccessMessage(null);

    const validationErrors: Record<string, string> = {};

    if (!name.trim()) {
      validationErrors.name = "화장실 이름을 입력해 주세요.";
    }

    if (!isPublished && (!roadAddress.trim() || !hasValidCoordinates)) {
      if (!roadAddress.trim()) {
        validationErrors.road_address = "주소 검색을 통해 도로명주소를 선택해 주세요.";
      }
      validationErrors.coordinates =
        "주소 검색을 통해 도로명주소 또는 지번주소를 선택해 위치를 확정해 주세요.";
    }

    const { hours: hoursPayload, error: hoursError } = buildHoursPayload();
    if (hoursError) {
      validationErrors.hours = hoursError;
    }

    let parsedDepositAmount: number | undefined;
    if (mode === "create" && policyMode === "deposit_with_ad") {
      const num = Number(depositAmountInput);
      if (!Number.isInteger(num) || num <= 0) {
        validationErrors.deposit_amount_krw =
          "테스트 보증금 금액은 1원 이상의 정수로 입력해 주세요.";
      } else {
        parsedDepositAmount = num;
      }
    }

    // Validate PIN when create + pin access_method
    let validatedPinToSave: string | null = null;
    if (mode === "create" && accessMethod === "pin" && !pinSavedRef.current) {
      const hasAnyPinInput =
        initialPin.trim().length > 0 || initialPinConfirm.trim().length > 0;
      if (action === "submit_review" || hasAnyPinInput) {
        if (!initialPin.trim()) {
          validationErrors.pin = "도어락 비밀번호를 입력해 주세요.";
        } else {
          const parsedPin = setRestroomPinSchema.safeParse({ pin: initialPin });
          if (!parsedPin.success) {
            validationErrors.pin =
              parsedPin.error.issues[0]?.message ||
              "도어락 비밀번호(숫자·*·# 4~20자)를 입력해 주세요.";
          } else if (parsedPin.data.pin !== initialPinConfirm.trim()) {
            validationErrors.pin_confirm =
              "입력한 비밀번호와 확인 비밀번호가 일치하지 않습니다.";
          } else {
            validatedPinToSave = parsedPin.data.pin;
          }
        }
      }
    }

    if (Object.keys(validationErrors).length > 0) {
      setFieldErrors(validationErrors);
      setServerError(
        validationErrors.name ||
          validationErrors.road_address ||
          validationErrors.coordinates ||
          validationErrors.pin ||
          validationErrors.pin_confirm ||
          validationErrors.deposit_amount_krw ||
          validationErrors.hours ||
          "필수 입력 항목을 확인해 주세요."
      );
      focusFirstErrorField(
        [
          "name",
          "road_address",
          "coordinates",
          "pin",
          "pin_confirm",
          "deposit_amount_krw",
          "hours",
        ],
        validationErrors,
        {
          name: "restroom-name",
          road_address: "restroom-road-address-search",
          coordinates: "restroom-road-address-search",
          pin: "restroom-initial-pin",
          pin_confirm: "restroom-initial-pin-confirm",
          deposit_amount_krw: "restroom-deposit-amount",
          hours: "restroom-hours-editor",
        }
      );
      return;
    }

    const idempotencyKey = crypto.randomUUID();

    try {
      setIsSubmitting(true);
      setSubmitIntent(action === "submit_review" ? "submit_review" : "draft");

      if (mode === "create") {
        // 1단계: 화장실 기본 정보/정책 임시저장 (이미 생성된 재시도면 기본정보만 PATCH해 중복 생성 방지)
        let savedRestroom = createdDraftRef.current;

        if (!savedRestroom) {
          const payload: Record<string, any> = {
            business_id: businessId,
            name: name.trim(),
            description: description.trim() || undefined,
            road_address: roadAddress.trim(),
            address_detail: addressDetail.trim() || undefined,
            latitude: latitude!,
            longitude: longitude!,
            floor: floor.trim() || undefined,
            entrance_instructions: entranceInstructions.trim() || undefined,
            gender_type: genderType,
            wheelchair_accessible: wheelchairAccessible,
            baby_changing_available: babyChangingAvailable,
            sanitary_products_available: sanitaryProductsAvailable,
            access_method: accessMethod,
            policy_mode: policyMode,
          };
          if (parsedDepositAmount !== undefined) {
            payload.deposit_amount_krw = parsedDepositAmount;
          }
          if (hoursPayload.length > 0) {
            payload.hours = hoursPayload;
          }

          const validation = createMerchantRestroomSchema.safeParse(payload);
          if (!validation.success) {
            const errors: Record<string, string> = {};
            validation.error.issues.forEach((issue) => {
              const key = issue.path[0];
              if (key) errors[String(key)] = issue.message;
            });
            setFieldErrors(errors);
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

          savedRestroom = data.data;
          createdDraftRef.current = savedRestroom;
        } else {
          // 이전 단계에서 PIN/사진/심사 실패 후 재시도: 중복 생성 없이 기존 draft만 안전 업데이트
          const retryPatch = {
            name: name.trim(),
            description: description.trim() || null,
            road_address: roadAddress.trim(),
            address_detail: addressDetail.trim() || null,
            latitude: latitude!,
            longitude: longitude!,
            floor: floor.trim() || null,
            entrance_instructions: entranceInstructions.trim() || null,
            gender_type: genderType,
            wheelchair_accessible: wheelchairAccessible,
            baby_changing_available: babyChangingAvailable,
            sanitary_products_available: sanitaryProductsAvailable,
            access_method: accessMethod,
            hours: hoursPayload,
          };
          const patchRes = await fetch(
            `/api/v1/merchant/restrooms/${savedRestroom.id}`,
            {
              method: "PATCH",
              headers: {
                "Content-Type": "application/json",
                "x-idempotency-key": crypto.randomUUID(),
              },
              body: JSON.stringify(retryPatch),
            }
          );
          const patchJson = await patchRes.json().catch(() => null);
          if (!patchRes.ok || !patchJson?.ok) {
            throw new Error(
              patchJson?.error?.message || "임시저장된 화장실 정보 갱신에 실패했습니다."
            );
          }
          savedRestroom = patchJson.data;
          createdDraftRef.current = savedRestroom;
        }

        // 2단계: 도어락 PIN 암호화 저장 (PIN 저장 실패 시 심사 요청을 진행하지 않음)
        if (accessMethod === "pin" && validatedPinToSave && !pinSavedRef.current && savedRestroom?.id) {
          const pinRes = await fetch(
            `/api/v1/merchant/restrooms/${savedRestroom.id}/pin`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-idempotency-key": crypto.randomUUID(),
              },
              body: JSON.stringify({ pin: validatedPinToSave }),
            }
          );
          const pinJson = await pinRes.json().catch(() => null);
          if (!pinRes.ok || !pinJson?.ok) {
            throw new Error(
              pinJson?.error?.message ||
                "화장실 정보는 임시저장되었으나 도어락 비밀번호 저장에 실패했습니다. 다시 시도해 주세요."
            );
          }
          pinSavedRef.current = true;
          setInitialPin("");
          setInitialPinConfirm("");
          setShowInitialPin(false);
        }

        // 3단계: 첨부 사진 업로드
        if (queuedPhotos.length > 0 && savedRestroom?.id) {
          const ordered = [...queuedPhotos].sort((a, b) =>
            a.isPrimary === b.isPrimary ? 0 : a.isPrimary ? -1 : 1
          );
          let remaining = [...ordered];
          for (const item of ordered) {
            try {
              await photoUploadFn({
                restroomId: savedRestroom.id,
                file: item.file,
                photoType: item.photoType,
                isPrimary: item.isPrimary,
                replacesPhotoId: null,
              });
              remaining = remaining.filter((q) => q.localId !== item.localId);
              setQueuedPhotos(remaining);
            } catch (photoErr: unknown) {
              const reason =
                photoErr instanceof Error
                  ? photoErr.message
                  : "사진 업로드에 실패했습니다.";
              throw new Error(
                `화장실 정보는 임시저장되었으나 사진 업로드에 실패했습니다: ${reason}`
              );
            }
          }
        }

        // 4단계: '등록하고 심사 요청하기' 클릭 시에만 관리자 심사 요청 수행
        if (action === "submit_review" && savedRestroom?.id) {
          const submitRes = await fetch(
            `/api/v1/merchant/restrooms/${savedRestroom.id}/submit`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-idempotency-key": crypto.randomUUID(),
              },
            }
          );
          const submitJson = await submitRes.json().catch(() => null);
          if (!submitRes.ok || !submitJson?.ok) {
            throw new Error(
              submitJson?.error?.message ||
                "화장실은 임시저장되었으나 관리자 심사 요청에 실패했습니다. 다시 시도해 주세요."
            );
          }
          savedRestroom = {
            ...savedRestroom,
            ...(submitJson.data || {}),
            publication_status: "pending",
          };
          setSuccessMessage("화장실이 등록되고 관리자 심사가 요청되었습니다.");
        } else {
          setSuccessMessage("화장실이 임시저장 상태로 저장되었습니다.");
        }

        if (onSuccess) {
          onSuccess(savedRestroom);
        } else {
          router.push(`/merchant/restrooms/${savedRestroom.id}`);
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
          hours: hoursPayload,
        };

        if (!isPublished) {
          patch.road_address = roadAddress.trim();
          patch.latitude = latitude!;
          patch.longitude = longitude!;
        }

        const validation = updateMerchantRestroomSchema.safeParse(patch);
        if (!validation.success) {
          const errors: Record<string, string> = {};
          validation.error.issues.forEach((issue) => {
            const key = issue.path[0];
            if (key) errors[String(key)] = issue.message;
          });
          setFieldErrors(errors);
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
      setSubmitIntent(null);
    }
  };

  const handlePrimaryFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void handleSubmitFlow(isEdit ? "edit" : "submit_review");
  };

  const hasBusinessAutoLocation = Boolean(
    !isEdit && businessDefaults?.roadAddress && hasValidCoordinates
  );

  return (
    <form
      onSubmit={handlePrimaryFormSubmit}
      noValidate
      data-testid="merchant-restroom-form"
      className="flex flex-col gap-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      {businessName && (
        <div className="rounded-xl bg-slate-50 px-3 py-2.5 text-xs text-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
          <span className="font-semibold text-slate-900 dark:text-white">등록 가게: </span>
          {businessName}
        </div>
      )}

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

      {serverError && (
        <div
          role="alert"
          data-testid="restroom-form-error"
          className="rounded-xl border border-rose-300 bg-rose-50 p-3.5 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <p className="font-semibold">⚠️ {serverError}</p>
        </div>
      )}

      {successMessage && (
        <div
          role="status"
          data-testid="restroom-form-success"
          className="rounded-xl border border-emerald-300 bg-emerald-50 p-3.5 text-xs text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
        >
          <p className="font-semibold">✓ {successMessage}</p>
        </div>
      )}

      {/* 1. 화장실 이름 및 위치 (가게 정보 자동 적용) */}
      <div className="space-y-3">
        <h3 className="text-sm font-bold text-slate-900 dark:text-white">
          1. 화장실 이름 및 위치
        </h3>

        <div>
          <label
            htmlFor="restroom-name"
            className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
          >
            화장실 이름 <span className="text-rose-500">*</span>
          </label>
          <input
            id="restroom-name"
            type="text"
            value={name}
            aria-invalid={Boolean(fieldErrors.name)}
            aria-describedby={fieldErrors.name ? "restroom-name-error" : undefined}
            onChange={(e) => {
              setName(e.target.value);
              if (e.target.value.trim()) clearFieldError("name");
            }}
            placeholder="예: 1층 고객용 화장실, 매장 전용 화장실"
            maxLength={200}
            required
            className={`mt-1 block w-full rounded-xl border bg-white px-3 py-2.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none dark:bg-slate-800 dark:text-white min-h-[44px] ${
              fieldErrors.name
                ? "border-rose-500 ring-1 ring-rose-500/30"
                : "border-slate-300 dark:border-slate-700"
            }`}
          />
          {fieldErrors.name && (
            <p
              id="restroom-name-error"
              role="alert"
              className="mt-1 text-xs font-medium text-rose-600 dark:text-rose-400"
            >
              {fieldErrors.name}
            </p>
          )}
        </div>

        {hasBusinessAutoLocation && (
          <p
            data-testid="restroom-business-autofill-note"
            className="rounded-lg bg-emerald-50 px-3 py-2 text-[11px] font-medium text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200 break-keep"
          >
            ✓ 승인된 가게 주소와 위치가 자동 적용되었어요. 다른 위치일 때만 아래에서 주소를 검색해 주세요.
          </p>
        )}

        <AddressSearchField
          roadAddress={roadAddress}
          hasCoordinates={hasValidCoordinates}
          disabled={isPublished}
          showJibunAddress={false}
          roadAddressInputId="restroom-road-address"
          roadAddressError={fieldErrors.road_address}
          coordinatesError={fieldErrors.coordinates}
          onSelectAddress={handleSelectAddress}
          addressSearchFn={addressSearchFn}
        />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label
              htmlFor="restroom-address-detail"
              className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
            >
              상세주소 (선택)
            </label>
            <input
              id="restroom-address-detail"
              type="text"
              value={addressDetail}
              onChange={(e) => setAddressDetail(e.target.value)}
              placeholder="예: 1층 카운터 왼쪽"
              maxLength={200}
              className="mt-1 block w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white min-h-[44px]"
            />
          </div>

          <div>
            <label
              htmlFor="restroom-floor"
              className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
            >
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
      </div>

      {/* 2. 출입 방식 및 도어락 PIN */}
      <div className="space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
        <h3 className="text-sm font-bold text-slate-900 dark:text-white">
          2. 출입 방식{!isEdit ? " 및 PIN" : ""}
        </h3>

        <div>
          <label
            htmlFor="restroom-access-method"
            className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
          >
            출입 방식
          </label>
          <select
            id="restroom-access-method"
            value={accessMethod}
            onChange={(e) => {
              const next = e.target.value as AccessMethod;
              setAccessMethod(next);
              if (next !== "pin") {
                setInitialPin("");
                setInitialPinConfirm("");
              }
            }}
            className="mt-1 block w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-xs text-slate-900 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white min-h-[44px]"
          >
            <option value="ask_staff">직원 문의 (매장 직원 확인 후 이용)</option>
            <option value="open">상시 개방 (자유 출입)</option>
            <option value="pin">도어락 (비밀번호 입력)</option>
          </select>
        </div>

        {/* 신규 등록 + 도어락 선택 시 최초 PIN 설정 입력란 표시 */}
        {!isEdit && accessMethod === "pin" && (
          <div
            data-testid="restroom-initial-pin-section"
            className="space-y-2.5 rounded-xl border border-purple-200 bg-purple-50/50 p-3.5 dark:border-purple-900/50 dark:bg-purple-950/20"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-bold text-purple-950 dark:text-purple-200">
                도어락 비밀번호 설정
              </p>
              <button
                type="button"
                onClick={() => setShowInitialPin((v) => !v)}
                className="text-[11px] font-semibold text-purple-700 hover:underline dark:text-purple-300"
              >
                {showInitialPin ? "가리기" : "번호 보기"}
              </button>
            </div>
            <p className="text-[11px] text-slate-600 dark:text-slate-400 break-keep">
              숫자 또는 `*`, `#` 조합 4~12자로 입력해 주세요. 입력한 비밀번호는 암호화되어 저장됩니다.
            </p>

            <div>
              <label
                htmlFor="restroom-initial-pin"
                className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300"
              >
                도어락 비밀번호 <span className="text-rose-500">*</span>
              </label>
              <input
                id="restroom-initial-pin"
                data-testid="restroom-initial-pin-input"
                type={showInitialPin ? "text" : "password"}
                inputMode="numeric"
                autoComplete="off"
                value={initialPin}
                aria-invalid={Boolean(fieldErrors.pin)}
                aria-describedby={fieldErrors.pin ? "restroom-initial-pin-error" : undefined}
                onChange={(e) => {
                  setInitialPin(e.target.value);
                  clearFieldError("pin");
                }}
                placeholder="예: 1234*"
                maxLength={12}
                className={`mt-1 block min-h-[44px] w-full rounded-xl border bg-white px-3 py-2 text-xs text-slate-900 focus:border-blue-500 focus:outline-none dark:bg-slate-800 dark:text-white ${
                  fieldErrors.pin
                    ? "border-rose-500 ring-1 ring-rose-500/30"
                    : "border-slate-300 dark:border-slate-700"
                }`}
              />
              {fieldErrors.pin && (
                <p
                  id="restroom-initial-pin-error"
                  role="alert"
                  className="mt-1 text-xs font-medium text-rose-600 dark:text-rose-400"
                >
                  {fieldErrors.pin}
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="restroom-initial-pin-confirm"
                className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300"
              >
                도어락 비밀번호 확인 <span className="text-rose-500">*</span>
              </label>
              <input
                id="restroom-initial-pin-confirm"
                data-testid="restroom-initial-pin-confirm-input"
                type={showInitialPin ? "text" : "password"}
                inputMode="numeric"
                autoComplete="off"
                value={initialPinConfirm}
                aria-invalid={Boolean(fieldErrors.pin_confirm)}
                aria-describedby={
                  fieldErrors.pin_confirm ? "restroom-initial-pin-confirm-error" : undefined
                }
                onChange={(e) => {
                  setInitialPinConfirm(e.target.value);
                  clearFieldError("pin_confirm");
                }}
                placeholder="동일한 비밀번호를 한 번 더 입력해 주세요"
                maxLength={12}
                className={`mt-1 block min-h-[44px] w-full rounded-xl border bg-white px-3 py-2 text-xs text-slate-900 focus:border-blue-500 focus:outline-none dark:bg-slate-800 dark:text-white ${
                  fieldErrors.pin_confirm
                    ? "border-rose-500 ring-1 ring-rose-500/30"
                    : "border-slate-300 dark:border-slate-700"
                }`}
              />
              {fieldErrors.pin_confirm && (
                <p
                  id="restroom-initial-pin-confirm-error"
                  role="alert"
                  className="mt-1 text-xs font-medium text-rose-600 dark:text-rose-400"
                >
                  {fieldErrors.pin_confirm}
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 3. 이용 정책 (신규 등록 시) */}
      {!isEdit && (
        <div className="space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
          <h3 className="text-sm font-bold text-slate-900 dark:text-white">
            3. 이용 정책
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 break-keep">
            손님에게 적용할 이용 방식을 선택해 주세요. 등록 후에도 변경할 수 있어요.
          </p>

          <fieldset className="space-y-2">
            <legend className="sr-only">이용 정책 선택</legend>
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
                <span className="font-bold text-slate-900 dark:text-white">무료 개방</span>
                <p className="mt-0.5 text-slate-500 dark:text-slate-400">
                  보증금 없이 무료로 이용할 수 있어요.
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
              <div className="flex-1 min-w-0 text-xs">
                <span className="font-bold text-slate-900 dark:text-white">
                  보증금 이용 (테스트 결제)
                </span>
                <p className="mt-0.5 text-slate-500 dark:text-slate-400 break-keep">
                  보증금 결제 후 매장에서 구매한 영수증을 인증하면 전액 환급돼요. (실제 금액 차감 없음)
                </p>

                {policyMode === "deposit_with_ad" && (
                  <div className="mt-2.5">
                    <label
                      htmlFor="restroom-deposit-amount"
                      className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300"
                    >
                      보증금 금액 (원) <span className="text-rose-500">*</span>
                    </label>
                    <input
                      id="restroom-deposit-amount"
                      data-testid="restroom-deposit-amount-input"
                      type="number"
                      min={100}
                      step={100}
                      value={depositAmountInput}
                      aria-invalid={Boolean(fieldErrors.deposit_amount_krw)}
                      aria-describedby={
                        fieldErrors.deposit_amount_krw ? "restroom-deposit-amount-error" : undefined
                      }
                      onChange={(e) => {
                        setDepositAmountInput(e.target.value);
                        clearFieldError("deposit_amount_krw");
                      }}
                      className={`mt-1 block min-h-[40px] w-full rounded-lg border bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-blue-500 focus:outline-none dark:bg-slate-800 dark:text-white ${
                        fieldErrors.deposit_amount_krw
                          ? "border-rose-500 ring-1 ring-rose-500/30"
                          : "border-slate-300 dark:border-slate-700"
                      }`}
                    />
                    {fieldErrors.deposit_amount_krw && (
                      <p
                        id="restroom-deposit-amount-error"
                        role="alert"
                        className="mt-1 text-xs font-medium text-rose-600 dark:text-rose-400"
                      >
                        {fieldErrors.deposit_amount_krw}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </label>
          </fieldset>
        </div>
      )}

      {/* 4. 운영시간 · 편의시설 · 출입 안내 */}
      <div
        data-testid="restroom-hours-editor"
        className="space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800"
      >
        <h3 className="text-sm font-bold text-slate-900 dark:text-white">
          {!isEdit ? "4. 운영시간 · 편의시설 · 출입 안내" : "3. 운영시간 · 편의시설 · 출입 안내"}
        </h3>

        <div>
          <label
            htmlFor="restroom-gender-type"
            className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
          >
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

        <fieldset className="space-y-2 pt-1">
          <legend className="text-xs font-semibold text-slate-700 dark:text-slate-300">
            편의시설
          </legend>

          <label className="flex items-center gap-2.5 cursor-pointer text-xs text-slate-800 dark:text-slate-200 min-h-[36px]">
            <input
              type="checkbox"
              checked={wheelchairAccessible}
              onChange={(e) => setWheelchairAccessible(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800"
            />
            <span>♿ 휠체어 접근 가능</span>
          </label>

          <label className="flex items-center gap-2.5 cursor-pointer text-xs text-slate-800 dark:text-slate-200 min-h-[36px]">
            <input
              type="checkbox"
              checked={babyChangingAvailable}
              onChange={(e) => setBabyChangingAvailable(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800"
            />
            <span>👶 기저귀 교환대 있음</span>
          </label>

          <label className="flex items-center gap-2.5 cursor-pointer text-xs text-slate-800 dark:text-slate-200 min-h-[36px]">
            <input
              type="checkbox"
              checked={sanitaryProductsAvailable}
              onChange={(e) => setSanitaryProductsAvailable(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800"
            />
            <span>🧴 여성 위생용품 있음</span>
          </label>
        </fieldset>

        <div>
          <label
            htmlFor="restroom-entrance-instructions"
            className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
          >
            출입 및 찾아가는 안내 (선택)
          </label>
          <textarea
            id="restroom-entrance-instructions"
            value={entranceInstructions}
            onChange={(e) => setEntranceInstructions(e.target.value)}
            placeholder="예: 매장 카운터 오른쪽 복도 끝 문으로 들어가시면 됩니다."
            rows={2}
            maxLength={500}
            className="mt-1 block w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
          />
        </div>

        <div>
          <label
            htmlFor="restroom-description"
            className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
          >
            추가 설명 (선택)
          </label>
          <textarea
            id="restroom-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="화장실 이용 시 참고할 내용을 적어주세요."
            rows={2}
            maxLength={2000}
            className="mt-1 block w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
          />
        </div>

        {/* 운영시간 설정 */}
        <div className="space-y-2 pt-2">
          <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">
            운영시간 설정 (선택)
          </p>

          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={applyDailyPreset}
              data-testid="hours-preset-daily"
              className="min-h-[36px] rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              매일 09:00~22:00
            </button>
            <button
              type="button"
              onClick={applyWeekdayOnlyPreset}
              data-testid="hours-preset-weekday"
              className="min-h-[36px] rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              평일 09:00~18:00 · 주말 휴무
            </button>
            <button
              type="button"
              onClick={clearHoursPreset}
              data-testid="hours-preset-clear"
              className="min-h-[36px] rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400"
            >
              전체 미설정
            </button>
          </div>

          {fieldErrors.hours && (
            <p className="text-xs font-semibold text-rose-600 dark:text-rose-400">
              ⚠️ {fieldErrors.hours}
            </p>
          )}

          <div className="space-y-2">
            {WEEKDAY_DISPLAY_ORDER.map(({ weekday, label }) => {
              const state = hoursByDay[weekday] || {
                mode: "unset",
                opensAt: "09:00",
                closesAt: "22:00",
              };
              const crossesMidnight =
                state.mode === "open" &&
                state.opensAt &&
                state.closesAt &&
                state.closesAt < state.opensAt;

              return (
                <div
                  key={weekday}
                  data-testid={`hour-row-${weekday}`}
                  className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50/70 p-2.5 dark:border-slate-800 dark:bg-slate-800/40"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-slate-800 dark:text-slate-200">
                      {label}
                    </span>
                    <select
                      aria-label={`${label} 운영 상태`}
                      data-testid={`hour-mode-${weekday}`}
                      value={state.mode}
                      onChange={(e) =>
                        updateDayHours(weekday, {
                          mode: e.target.value as WeekdayMode,
                        })
                      }
                      className="min-h-[36px] rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                    >
                      <option value="unset">미설정</option>
                      <option value="open">운영시간 입력</option>
                      <option value="closed">휴무</option>
                    </select>
                  </div>

                  {state.mode === "open" && (
                    <div className="grid grid-cols-2 gap-2">
                      <div className="min-w-0">
                        <label
                          htmlFor={`hour-opens-${weekday}`}
                          className="block text-[10px] font-medium text-slate-500 dark:text-slate-400"
                        >
                          시작
                        </label>
                        <input
                          id={`hour-opens-${weekday}`}
                          data-testid={`hour-opens-${weekday}`}
                          type="time"
                          value={state.opensAt}
                          onChange={(e) =>
                            updateDayHours(weekday, { opensAt: e.target.value })
                          }
                          className="mt-0.5 block min-h-[40px] w-full min-w-0 rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                        />
                      </div>
                      <div className="min-w-0">
                        <label
                          htmlFor={`hour-closes-${weekday}`}
                          className="block text-[10px] font-medium text-slate-500 dark:text-slate-400"
                        >
                          종료
                        </label>
                        <input
                          id={`hour-closes-${weekday}`}
                          data-testid={`hour-closes-${weekday}`}
                          type="time"
                          value={state.closesAt}
                          onChange={(e) =>
                            updateDayHours(weekday, { closesAt: e.target.value })
                          }
                          className="mt-0.5 block min-h-[40px] w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs text-slate-900 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                        />
                      </div>
                      {crossesMidnight && (
                        <p className="col-span-2 text-[10px] font-medium text-indigo-700 dark:text-indigo-300">
                          🌙 종료 시간이 시작 시간보다 빨라 익일({state.closesAt}) 종료로 저장됩니다.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* 5. 화장실 사진 첨부 (신규 등록 시) */}
      {!isEdit && (
        <RestroomPhotoManager
          mode="create"
          queuedPhotos={queuedPhotos}
          onQueuedPhotosChange={setQueuedPhotos}
          disabled={isSubmitting}
        />
      )}

      {/* 6. 등록 및 심사 요청 / 임시 저장 / 수정 완료 */}
      <div className="flex flex-col gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
        {!isEdit ? (
          <>
            <button
              type="submit"
              disabled={isSubmitting}
              data-testid="restroom-form-submit-review-button"
              className="flex min-h-[48px] w-full items-center justify-center rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-blue-700 active:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting && submitIntent === "submit_review"
                ? "등록 및 심사 요청 중..."
                : "등록하고 심사 요청하기"}
            </button>

            <div className="flex gap-2">
              <button
                type="button"
                disabled={isSubmitting}
                data-testid="restroom-form-submit-button"
                onClick={() => void handleSubmitFlow("draft")}
                className="flex min-h-[44px] flex-1 items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              >
                {isSubmitting && submitIntent === "draft" ? "임시 저장 중..." : "임시 저장"}
              </button>

              {onCancel && (
                <button
                  type="button"
                  onClick={onCancel}
                  disabled={isSubmitting}
                  className="min-h-[44px] rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-400"
                >
                  취소
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="flex items-center justify-end gap-2">
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
              {isSubmitting ? "저장 중..." : "화장실 정보 수정 완료"}
            </button>
          </div>
        )}
      </div>
    </form>
  );
}

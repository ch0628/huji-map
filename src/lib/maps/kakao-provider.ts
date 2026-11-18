/**
 * 카카오 지도 구현체 (KakaoMapProvider)
 *
 * 원칙:
 * 1. MapProvider 인터페이스를 엄격히 준수한다.
 * 2. WGS84 좌표계(LatLng)와 카카오 내부 좌표계(kakao.maps.LatLng) 간 양방향 변환을 캡슐화한다.
 * 3. 마커 및 이벤트 리스너를 철저히 추적하여 destroy() 시 메모리 누수를 방지한다.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  LatLng,
  MapBounds,
  MapOptions,
  MapProvider,
  MarkerOptions,
  isValidLatLng,
} from "./types";
import { getMarkerIcon } from "./marker-icons";
import { isKakaoSdkLoaded, loadKakaoMapSdk } from "./kakao-sdk";

interface ManagedMarker {
  readonly id: string;
  readonly markerInstance: any;
  readonly clickListener?: () => void;
}

export class KakaoMapProvider implements MapProvider {
  public readonly name = "kakao";
  private map: any = null;
  private container: HTMLElement | null = null;
  private markers: Map<string, ManagedMarker> = new Map();
  private eventListeners: Array<{ target: any; type: string; handler: any }> = [];

  public async init(container: HTMLElement, options: MapOptions): Promise<void> {
    if (typeof window === "undefined") {
      throw new Error("Cannot initialize KakaoMapProvider in server environment.");
    }

    if (!isKakaoSdkLoaded()) {
      await loadKakaoMapSdk();
    }

    if (!window.kakao || !window.kakao.maps) {
      throw new Error("Kakao Maps SDK is not loaded.");
    }

    this.container = container;

    const kakaoCenter = new window.kakao.maps.LatLng(
      options.center.lat,
      options.center.lng
    );

    const mapOptions: Record<string, any> = {
      center: kakaoCenter,
      level: options.zoomLevel,
    };

    this.map = new window.kakao.maps.Map(container, mapOptions);

    if (options.minZoomLevel !== undefined && typeof this.map.setMinLevel === "function") {
      this.map.setMinLevel(options.minZoomLevel);
    }
    if (options.maxZoomLevel !== undefined && typeof this.map.setMaxLevel === "function") {
      this.map.setMaxLevel(options.maxZoomLevel);
    }

    // 이벤트 리스너 등록
    this.setupEventListeners(options);
  }

  private setupEventListeners(options: MapOptions): void {
    const kakaoEvent = window.kakao?.maps?.event;
    if (!kakaoEvent || !this.map) return;

    if (options.onCenterChanged) {
      const centerHandler = () => {
        if (!this.map) return;
        const center = this.getCenter();
        options.onCenterChanged?.(center);
      };
      kakaoEvent.addListener(this.map, "center_changed", centerHandler);
      this.eventListeners.push({ target: this.map, type: "center_changed", handler: centerHandler });
    }

    if (options.onBoundsChanged) {
      const boundsHandler = () => {
        if (!this.map) return;
        const bounds = this.getBounds();
        options.onBoundsChanged?.(bounds);
      };
      kakaoEvent.addListener(this.map, "bounds_changed", boundsHandler);
      this.eventListeners.push({ target: this.map, type: "bounds_changed", handler: boundsHandler });
    }

    if (options.onZoomChanged) {
      const zoomHandler = () => {
        if (!this.map) return;
        const level = this.getZoomLevel();
        options.onZoomChanged?.(level);
      };
      kakaoEvent.addListener(this.map, "zoom_changed", zoomHandler);
      this.eventListeners.push({ target: this.map, type: "zoom_changed", handler: zoomHandler });
    }

    if (options.onClick) {
      const clickHandler = (mouseEvent: any) => {
        if (!mouseEvent || !mouseEvent.latLng) return;
        const latLng: LatLng = {
          lat: mouseEvent.latLng.getLat(),
          lng: mouseEvent.latLng.getLng(),
        };
        options.onClick?.(latLng);
      };
      kakaoEvent.addListener(this.map, "click", clickHandler);
      this.eventListeners.push({ target: this.map, type: "click", handler: clickHandler });
    }
  }

  public getCenter(): LatLng {
    this.ensureInitialized();
    const kakaoCenter = this.map.getCenter();
    return {
      lat: kakaoCenter.getLat(),
      lng: kakaoCenter.getLng(),
    };
  }

  public setCenter(center: LatLng, smooth = false): void {
    this.ensureInitialized();
    if (!isValidLatLng(center)) {
      throw new Error(`Invalid LatLng coordinates: ${JSON.stringify(center)}`);
    }

    const kakaoCenter = new window.kakao!.maps!.LatLng(center.lat, center.lng);
    if (smooth && typeof this.map.panTo === "function") {
      this.map.panTo(kakaoCenter);
    } else {
      this.map.setCenter(kakaoCenter);
    }
  }

  public getZoomLevel(): number {
    this.ensureInitialized();
    return this.map.getLevel();
  }

  public setZoomLevel(level: number): void {
    this.ensureInitialized();
    this.map.setLevel(level);
  }

  public getBounds(): MapBounds {
    this.ensureInitialized();
    const bounds = this.map.getBounds();
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();

    return {
      south: sw.getLat(),
      west: sw.getLng(),
      north: ne.getLat(),
      east: ne.getLng(),
    };
  }

  public fitBounds(bounds: MapBounds): void {
    this.ensureInitialized();
    const sw = new window.kakao!.maps!.LatLng(bounds.south, bounds.west);
    const ne = new window.kakao!.maps!.LatLng(bounds.north, bounds.east);
    const kakaoBounds = new window.kakao!.maps!.LatLngBounds(sw, ne);
    this.map.setBounds(kakaoBounds);
  }

  public setMarkers(markers: readonly MarkerOptions[]): void {
    this.clearMarkers();
    for (const marker of markers) {
      this.addMarker(marker);
    }
  }

  public addMarker(options: MarkerOptions): void {
    this.ensureInitialized();
    if (this.markers.has(options.id)) {
      this.removeMarker(options.id);
    }

    const kakaoLatLng = new window.kakao!.maps!.LatLng(
      options.position.lat,
      options.position.lng
    );

    const markerParams: Record<string, any> = {
      map: this.map,
      position: kakaoLatLng,
      title: options.title,
      zIndex: options.zIndex ?? 1,
    };

    const icon = getMarkerIcon(options.type, options.selected === true);
    if (icon && window.kakao!.maps!.MarkerImage && window.kakao!.maps!.Size && window.kakao!.maps!.Point) {
      const maps = window.kakao!.maps!;
      markerParams.image = new maps.MarkerImage(
        icon.src,
        new maps.Size(icon.width, icon.height),
        { offset: new maps.Point(icon.anchorX, icon.anchorY) }
      );
    }

    const markerInstance = new window.kakao!.maps!.Marker(markerParams);

    let clickListener: (() => void) | undefined;
    if (options.onClick) {
      clickListener = () => options.onClick?.(options.id);
      window.kakao!.maps!.event.addListener(
        markerInstance,
        "click",
        clickListener
      );
    }

    this.markers.set(options.id, {
      id: options.id,
      markerInstance,
      clickListener,
    });
  }

  public removeMarker(markerId: string): void {
    const existing = this.markers.get(markerId);
    if (!existing) return;

    if (existing.clickListener && window.kakao?.maps?.event) {
      window.kakao.maps.event.removeListener(
        existing.markerInstance,
        "click",
        existing.clickListener
      );
    }

    existing.markerInstance.setMap(null);
    this.markers.delete(markerId);
  }

  public clearMarkers(): void {
    for (const [id] of this.markers) {
      this.removeMarker(id);
    }
    this.markers.clear();
  }

  public relayout(): void {
    if (this.map && typeof this.map.relayout === "function") {
      this.map.relayout();
    }
  }

  public destroy(): void {
    this.clearMarkers();

    if (window.kakao?.maps?.event) {
      for (const listener of this.eventListeners) {
        window.kakao.maps.event.removeListener(
          listener.target,
          listener.type,
          listener.handler
        );
      }
    }
    this.eventListeners = [];

    this.map = null;
    this.container = null;
  }

  private ensureInitialized(): void {
    if (!this.map) {
      throw new Error("KakaoMapProvider is not initialized. Call init() first.");
    }
  }
}

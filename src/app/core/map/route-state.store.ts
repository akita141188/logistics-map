import { Injectable, computed, signal } from '@angular/core';
import {
  AnyRoutePoint,
  LatLng,
  LngLatTuple,
  RoutePoint,
  RouteType,
} from './map.types';
import { decodeToLngLat } from './polyline.util';
import { metersToKm, toLatLng, totalDistanceMeters } from './geo.util';
import {
  ExpectedRouteContext,
  RouteCustomer,
  buildExpectedRoutePoints,
  hasVisitSequence,
} from './expected-route.util';

/**
 * State điều phối màn "Giám sát lộ trình bán hàng".
 * Gom `monitoringMgm.service.ts` + `detailInfo.service.ts` (bản Vue) vào 1 store.
 *
 * Bản Vue để state ở MODULE SCOPE (`const routingPointList = ref()`), tức là
 * singleton sống mãi kể cả khi rời màn — nguồn gốc của hàng loạt bug "vẽ lại
 * lộ trình cũ" và "watch async resume sau khi map đã chết".
 * Ở đây là service DI: provide ở cấp route/component thì state chết theo màn hình.
 *
 * ```ts
 * // trong routes.ts
 * {
 *   path: 'monitoring-sales',
 *   providers: [RouteStateStore],
 *   loadComponent: () => import('./monitoring-map.component'),
 * }
 * ```
 */
@Injectable()
export class RouteStateStore {
  private readonly _routeType = signal<RouteType | null>(null);
  private readonly _expectedPoints = signal<LngLatTuple[]>([]);
  private readonly _realPoints = signal<RoutePoint[]>([]);
  private readonly _distanceMeters = signal(0);
  /** Mật độ điểm GPS người dùng chọn: 0 | 10 | 20 | 30 | 50 (%). */
  private readonly _positionRate = signal<number>(30);

  readonly routeType = this._routeType.asReadonly();
  readonly expectedPoints = this._expectedPoints.asReadonly();
  readonly realPoints = this._realPoints.asReadonly();
  readonly positionRate = this._positionRate.asReadonly();

  /** Quãng đường do dịch vụ định tuyến trả về (mét). */
  readonly distanceMeters = this._distanceMeters.asReadonly();
  readonly distanceKm = computed(() => metersToKm(this._distanceMeters()));

  /** Đang xem lộ trình thực tế -> mới hiện bộ chọn mật độ điểm GPS. */
  readonly showPositionRate = computed(
    () => this._routeType() === RouteType.Real,
  );

  /** Điểm để đẩy vào nhánh Google/OSM (2 nhánh này dùng `{ lat, lng }`). */
  readonly routingLatLng = computed<LatLng[]>(() => {
    if (this._routeType() === RouteType.Real) {
      return this._realPoints().map((p) => ({ lat: p.lat, lng: p.lng }));
    }
    return this._expectedPoints().map(toLatLng);
  });

  // -------------------------------------------------------------- commands

  /** MH06 — bấm "Lộ trình dự kiến". */
  showExpectedRoute(
    customers: readonly RouteCustomer[],
    context: ExpectedRouteContext,
  ): void {
    this._expectedPoints.set(buildExpectedRoutePoints(customers, context));
    this._realPoints.set([]);
    this._routeType.set(RouteType.Expected);
  }

  /**
   * MH05 (nguồn a) — lộ trình thực tế từ `polylineEncoded` của API chi tiết NV.
   * `decodeToLngLat` đã lo việc đảo `[lat,lng]` -> `[lng,lat]`.
   */
  showRealRouteFromPolyline(polylineEncoded?: string | null): void {
    this._expectedPoints.set(
      polylineEncoded ? (decodeToLngLat(polylineEncoded, 5) as LngLatTuple[]) : [],
    );
    this._realPoints.set([]);
    this._routeType.set(RouteType.Real);
  }

  /** MH05 (nguồn b) — lộ trình thực tế từ GPS log theo mật độ %. */
  showRealRouteFromLogs(logs: readonly AnyRoutePoint[]): void {
    this._realPoints.set(logs as RoutePoint[]);
    this._expectedPoints.set([]);
    this._routeType.set(RouteType.Real);
  }

  setPositionRate(percent: number): void {
    this._positionRate.set(percent);
  }

  /** Component bản đồ gọi lại qua `(distanceChange)`. */
  setDistanceMeters(meters: number): void {
    this._distanceMeters.set(meters);
  }

  /** Bấm "Quay lại" — xoá lộ trình, chỉ còn marker. */
  clear(): void {
    this._routeType.set(null);
    this._expectedPoints.set([]);
    this._realPoints.set([]);
    this._distanceMeters.set(0);
  }

  // -------------------------------------------------------------- helpers

  /**
   * Tự cộng quãng đường từ polyline mà KHÔNG gọi dịch vụ định tuyến.
   * Dùng cho field "Quãng đường đã đi" (MH04) — kết quả bằng MÉT.
   */
  static distanceFromPolyline(polylineEncoded?: string | null): number {
    if (!polylineEncoded) return 0;
    const points = decodeToLngLat(polylineEncoded, 5).map(([lng, lat]) => ({
      lat,
      lng,
    }));
    return Math.round(totalDistanceMeters(points));
  }

  static hasVisitSequence = hasVisitSequence;
}

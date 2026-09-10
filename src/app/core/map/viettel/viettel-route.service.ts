import { Injectable, inject, signal } from '@angular/core';
import { AnyRoutePoint, LngLatTuple, ROUTE_LINE_COLOR, RoutePoint } from '../map.types';
import { decimatePoints, dedupeConsecutive, normalizePoints } from '../geo.util';
import { ViettelMapService } from './viettel-map.service';
import { RoadMarkerRenderer } from './road-marker.renderer';
import {
  ROAD_DISTANCE_ELEMENT_ID,
  ROAD_LAYER_ID,
  ROAD_SOURCE_ID,
  VtRoadDrawerControl,
} from './vtmap.types';

/** Thời gian chờ DOM ổn định sau khi SDK cập nhật quãng đường. */
const SETTLE_DEBOUNCE_MS = 150;
/** Nếu SDK "im lặng" quá lâu vẫn phải giải phóng Promise, tránh treo UI. */
const SAFETY_TIMEOUT_MS = 5000;

export interface ViettelRouteResult {
  /** Tổng quãng đường do dịch vụ định tuyến trả về, đơn vị MÉT. */
  distanceMeters: number;
  /** Số điểm thực sự được gửi vào dịch vụ định tuyến sau dedupe + decimate. */
  sentPoints: number;
}

const EMPTY_RESULT: ViettelRouteResult = { distanceMeters: 0, sentPoints: 0 };

/**
 * ===================== LÕI CHỈ ĐƯỜNG VIETTEL MAP =====================
 *
 * Port của `getRoadBasedOnLatLng` + `getRoadBasedOnLatLngForRealRoute`.
 *
 * CƠ CHẾ HOẠT ĐỘNG (đọc kỹ trước khi sửa):
 * `RoadDrawerControl.setPoints()` là API *fire-and-forget* — không Promise,
 * không callback, không event. Cách DUY NHẤT biết routing đã xong là quan sát
 * phần tử DOM `#road-draw-total-distance` mà SDK ghi kết quả vào.
 * Toàn bộ đống `MutationObserver` + debounce + safety timeout bên dưới sinh ra
 * từ hạn chế đó, KHÔNG phải do code thừa.
 *
 * Provide ở cấp component cùng với `ViettelMapService`:
 * ```ts
 * providers: [ViettelMapService, RoadMarkerRenderer, ViettelRouteService]
 * ```
 */
@Injectable()
export class ViettelRouteService {
  private readonly mapService = inject(ViettelMapService);
  private readonly markers = inject(RoadMarkerRenderer);

  private roadDrawer: VtRoadDrawerControl | null = null;

  private observer: MutationObserver | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;

  /** Đang gọi dịch vụ định tuyến — bind vào spinner của màn hình. */
  readonly drawing = signal(false);
  /** Tổng quãng đường lần vẽ gần nhất (mét). */
  readonly lastDistanceMeters = signal(0);

  // ------------------------------------------------------- lộ trình dự kiến

  /**
   * Vẽ LỘ TRÌNH DỰ KIẾN (MH06) và So sánh lộ trình.
   * Đầu vào là danh sách điểm bán đã sắp theo thứ tự ghé thăm.
   *
   * @param points danh sách `[lng, lat]` — CHÚ Ý thứ tự lng trước lat.
   */
  async drawExpectedRoute(
    points: readonly LngLatTuple[] | null | undefined,
    color = ROUTE_LINE_COLOR,
  ): Promise<ViettelRouteResult> {
    if (!this.mapService.isAlive()) return EMPTY_RESULT;

    // `RoadDrawerControl._updatePath()` của SDK v4 RETURN SỚM khi có < 2 marker:
    // không vẽ và KHÔNG ghi vào #road-draw-total-distance -> MutationObserver
    // không bao giờ fire -> Promise TREO VĨNH VIỄN, và observer còn sống sang
    // lượt vẽ sau (khi đó `refresh()` ghi "0m" sẽ đánh thức nhầm observer cũ).
    // Phải chặn ngay tại đây, đồng thời xoá đường của lần vẽ trước.
    if (!points || points.length < 2) {
      this.clearRoute();
      return EMPTY_RESULT;
    }

    this.prepareLayer(color);
    this.drawing.set(true);

    try {
      const distanceMeters = await this.setPointsAndAwaitDistance(
        points as LngLatTuple[],
        () => {
          this.hideDefaultMarkers();
          this.hideDrawerUi();
          // Ở lộ trình dự kiến, fit theo overlay là ĐÚNG: overlay chính là các
          // điểm bán của tuyến.
          this.mapService.fitOverlays();
        },
      );

      this.lastDistanceMeters.set(distanceMeters);
      return { distanceMeters, sentPoints: points.length };
    } finally {
      this.drawing.set(false);
    }
  }

  // ------------------------------------------------------ lộ trình thực tế

  /**
   * Vẽ LỘ TRÌNH THỰC TẾ (MH05) từ GPS track thô.
   *
   * Khác `drawExpectedRoute` ở 4 điểm:
   *  1. Dedupe điểm trùng liên tiếp (GPS nhiễu khi nhân viên đứng yên).
   *  2. Decimate xuống `maxPointsForDrawer` — nếu không sẽ dính HTTP 414.
   *  3. Marker được gắn nhãn giờ + popup, và ẩn bớt cho đỡ lag DOM.
   *  4. Fit khung nhìn theo CHÍNH GPS track, không theo overlay.
   */
  async drawRealRoute(
    points: readonly AnyRoutePoint[] | null | undefined,
    color = ROUTE_LINE_COLOR,
  ): Promise<ViettelRouteResult> {
    this.cancelPending();
    this.markers.cleanup();

    if (!this.mapService.isAlive()) return EMPTY_RESULT;

    const { maxPoints, maxMarkers, epsilon } = this.mapService.routingLimits;

    const normalized = normalizePoints(points);
    if (!normalized.length) return EMPTY_RESULT;

    const deduped = dedupeConsecutive(normalized, epsilon);
    const forDrawer = decimatePoints(deduped, maxPoints);
    const tuples: LngLatTuple[] = forDrawer.map((p) => [p.lng, p.lat]);

    if (tuples.length < 2) {
      this.clearRoute();
      return EMPTY_RESULT;
    }

    this.prepareLayer(color);
    const visible = this.computeVisibleMarkerIndexes(forDrawer, maxMarkers);
    this.drawing.set(true);

    try {
      const distanceMeters = await this.setPointsAndAwaitDistance(tuples, () => {
        this.markers.render(forDrawer, visible);
        this.mapService.fitToPoints(forDrawer);
        this.hideDrawerUi();

        // TUYỆT ĐỐI KHÔNG gọi `fitOverlays()` ở đây: nó bắt đầu bằng `map.stop()`
        // (huỷ animation fitBounds mà `fitToPoints` vừa khởi động) rồi fit lại
        // theo overlay = marker KHÁCH HÀNG, nên khung nhìn cuối cùng bám cụm
        // khách hàng thay vì bám GPS track của nhân viên.
      });

      this.lastDistanceMeters.set(distanceMeters);
      return { distanceMeters, sentPoints: tuples.length };
    } finally {
      this.drawing.set(false);
    }
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Xoá đường đã vẽ. PHẢI gọi trước khi vẽ tuyến mới và khi rời màn hình —
   * `removeMarkerSource()` KHÔNG dọn `roaddraw-layer`.
   */
  clearRoute(): void {
    this.cancelPending();
    this.markers.cleanup();
    if (!this.mapService.isAlive()) return;
    // refresh() -> _clearPath() -> _updateSource() đọc `this._map.getSource()`:
    // map đã chết thì ném lỗi, nên guard ở trên là bắt buộc.
    this.roadDrawer?.refresh();
    this.lastDistanceMeters.set(0);
  }

  /** Gọi trong `ngOnDestroy` của component chứa bản đồ. */
  destroy(): void {
    this.cancelPending();
    this.markers.cleanup();
    this.roadDrawer = null;
  }

  // -------------------------------------------------------------- internal

  private ensureRoadDrawer(): VtRoadDrawerControl | null {
    const map = this.mapService.instance;
    const sdk = this.mapService.vtmapgl;
    if (!map || !sdk) return null;

    if (!this.roadDrawer) {
      this.roadDrawer = new sdk.RoadDrawerControl({
        accessToken: sdk.accessToken,
        // mode: 'driving',   // 'cycling' | 'walking'
        // lineColor: '#ff9900',
      });
      map.addControl(this.roadDrawer);
    }
    return this.roadDrawer;
  }

  /**
   * SDK ghi hình học vào source `roaddraw-source` nhưng KHÔNG tạo layer hiển thị.
   * App phải tự thêm layer để chọn màu/độ dày — và phải xoá layer cũ trước,
   * nếu không `addLayer` trùng id sẽ ném lỗi.
   */
  private prepareLayer(color: string): void {
    this.ensureRoadDrawer();
    const map = this.mapService.instance;
    if (!map) return;

    try {
      map.removeLayer(ROAD_LAYER_ID);
    } catch {
      // layer chưa tồn tại ở lần vẽ đầu tiên
    }

    map.addLayer({
      id: ROAD_LAYER_ID,
      type: 'line',
      source: ROAD_SOURCE_ID,
      layout: {},
      paint: { 'line-color': color, 'line-width': 4 },
    });
  }

  /**
   * Gửi điểm vào SDK rồi CHỜ kết quả qua MutationObserver trên
   * `#road-draw-total-distance`.
   *
   * - Debounce 150ms: SDK ghi DOM nhiều lần liên tiếp trong 1 lần routing.
   * - Safety timeout 5s: dịch vụ lỗi/không phản hồi thì vẫn resolve với 0m,
   *   marker và các phần khác của màn hình không bị kẹt.
   */
  private setPointsAndAwaitDistance(
    points: LngLatTuple[],
    onReady: () => void,
  ): Promise<number> {
    const drawer = this.ensureRoadDrawer();
    if (!drawer) return Promise.resolve(0);

    return new Promise<number>((resolve, reject) => {
      const target = document.getElementById(ROAD_DISTANCE_ELEMENT_ID);
      if (!target) {
        reject(new Error(`Không tìm thấy #${ROAD_DISTANCE_ELEMENT_ID}`));
        return;
      }

      const settle = () => {
        this.cancelPending();
        try {
          // Text dạng "12.4 km" / "850 m" -> lấy phần số.
          const raw = target.textContent?.trim() ?? '';
          const distance = Number.parseFloat(raw.replace(/[^\d.]/g, '')) || 0;
          onReady();
          resolve(distance);
        } catch (error) {
          reject(error);
        }
      };

      this.observer = new MutationObserver(() => {
        if (this.settleTimer) clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(settle, SETTLE_DEBOUNCE_MS);
      });
      this.observer.observe(target, {
        childList: true,
        subtree: true,
        characterData: true,
      });

      this.safetyTimer = setTimeout(settle, SAFETY_TIMEOUT_MS);

      drawer.setPoints(points);
      // Tắt chế độ vẽ tay tương tác — nếu không, click lên bản đồ sẽ chèn thêm điểm.
      drawer.deactive();
    });
  }

  private cancelPending(): void {
    this.observer?.disconnect();
    this.observer = null;

    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;

    if (this.safetyTimer) clearTimeout(this.safetyTimer);
    this.safetyTimer = null;
  }

  /** Luôn giữ điểm ĐẦU và điểm CUỐI, phần giữa lấy mẫu đều. */
  private computeVisibleMarkerIndexes(
    points: readonly RoutePoint[],
    maxMarkers: number,
  ): Set<number> {
    const step =
      points.length > maxMarkers ? Math.ceil(points.length / maxMarkers) : 1;

    const visible = new Set<number>();
    for (let i = 0; i < points.length; i += step) visible.add(i);
    if (points.length) {
      visible.add(0);
      visible.add(points.length - 1);
    }
    return visible;
  }

  /** Ẩn marker số thứ tự mặc định của SDK (dùng cho lộ trình dự kiến). */
  private hideDefaultMarkers(): void {
    const list = document.getElementsByClassName(
      'indexed-marker',
    ) as HTMLCollectionOf<HTMLElement>;
    for (let i = 0; i < list.length; i++) list[i].style.display = 'none';
  }

  /** Ẩn toolbar vẽ tay của control (app tự làm UI riêng). */
  private hideDrawerUi(): void {
    const container = this.roadDrawer?._container;
    if (!container) return;

    const toolbar =
      container.querySelector<HTMLElement>('.road-draw-toolbar') ??
      container.querySelector<HTMLElement>('.mapbox-gl-draw_control');

    // SDK render toolbar trễ một nhịp -> hoãn 40ms mới ẩn được.
    if (toolbar) setTimeout(() => (toolbar.style.display = 'none'), 40);
    container.style.visibility = 'hidden';
  }
}

import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { LatLng, MAP_COLORS, MapMarker, MapPath, ROUTE_LINE_COLOR } from '../map.types';
import { escapeHtml, safeColor } from '../html-safe.util';
import { ViettelMapService } from './viettel-map.service';
import { ViettelRouteService } from './viettel-route.service';
import { RoadMarkerRenderer } from './road-marker.renderer';

/**
 * ==================== BẢN ĐỒ VIETTEL (vtmap-gl) ====================
 *
 * Thay thế cho `MapContainer.vue` (nhánh VTMAP) của bản Vue.
 *
 * ĐIỂM KHÁC BIỆT LỚN NHẤT so với Vue: bên Vue toàn bộ logic vẽ nằm trong 1
 * `watch([...])` khổng lồ với `switch (mapType)`. Ở đây dùng `effect()` — chỉ
 * chạy lại khi signal đầu vào đổi, và tự huỷ khi component destroy (không cần
 * `onUnmounted` thủ công).
 *
 * 3 service đều provide ở CẤP COMPONENT: mỗi instance bản đồ có state riêng,
 * tránh hoàn toàn lớp bug "singleton module-level" của bản Vue (state sống dai
 * hơn màn hình -> vẽ lại lộ trình cũ, watch async resume sau khi map đã chết).
 *
 * CẦN API KEY: đặt `vtmapKey` trong `provideMapRouting()`. Không có key thì
 * component hiển thị thông báo hướng dẫn thay vì bản đồ xám trắng khó hiểu.
 */
@Component({
  selector: 'dms-viettel-map',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ViettelMapService, RoadMarkerRenderer, ViettelRouteService],
  template: `
    <div #mapHost class="vt-map__canvas" [class.vt-map--picking]="pickMode()"></div>

    @if (routeService.drawing()) {
      <div class="vt-map__badge vt-map__badge--center">Đang tính lộ trình…</div>
    }

    @if (error(); as message) {
      <div class="vt-map__error">
        <strong>Không dùng được Viettel Map</strong>
        <p>{{ message }}</p>
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
      position: relative;
      width: 100%;
      height: 100%;
    }
    .vt-map__canvas {
      width: 100%;
      height: 100%;
      background: #e8eef3;
    }
    .vt-map--picking {
      cursor: crosshair;
    }
    .vt-map__badge {
      position: absolute;
      z-index: 3;
      padding: 6px 14px;
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.85);
      color: #fff;
      font-size: 12px;
    }
    .vt-map__badge--center {
      top: 12px;
      left: 50%;
      transform: translateX(-50%);
    }
    .vt-map__error {
      position: absolute;
      inset: 0;
      z-index: 4;
      display: grid;
      place-content: center;
      gap: 6px;
      padding: 24px;
      text-align: center;
      font-size: 13px;
      color: #475569;
      background: #f1f5f9;
    }
    .vt-map__error strong {
      color: #dc2626;
    }
  `,
})
export class ViettelMapComponent {
  private readonly mapHost = viewChild.required<ElementRef<HTMLDivElement>>('mapHost');
  private readonly destroyRef = inject(DestroyRef);

  protected readonly mapService = inject(ViettelMapService);
  protected readonly routeService = inject(ViettelRouteService);

  readonly center = input<LatLng>({ lat: 21.0278, lng: 105.8342 });
  readonly zoom = input(12);
  readonly markers = input<readonly MapMarker[]>([]);
  readonly paths = input<readonly MapPath[]>([]);
  readonly vehicle = input<MapMarker | null>(null);
  readonly pickMode = input(false);
  readonly lineColor = input(ROUTE_LINE_COLOR);

  /**
   * Điểm cần ĐỊNH TUYẾN qua `RoadDrawerControl`. Khác `paths` ở chỗ `paths` là
   * hình học đã có sẵn, còn cái này phải gọi dịch vụ định tuyến mới ra đường đi.
   */
  readonly routingPoints = input<readonly LatLng[]>([]);

  /** Đổi giá trị này để ép bản đồ ôm trọn dữ liệu vào khung nhìn. */
  readonly fitToken = input<string | number>(0);
  /** Bay tới một điểm cụ thể. */
  readonly focus = input<LatLng | null>(null);

  readonly mapClick = output<LatLng>();
  readonly markerClick = output<MapMarker>();
  /** Bắn ra tổng quãng đường (MÉT) sau mỗi lần vẽ xong. */
  readonly distanceChange = output<number>();

  protected readonly error = signal<string | null>(null);
  private readonly ready = signal(false);

  /** `fitToken` đã thực hiện — xem effect fit ở constructor. */
  private appliedFitToken: string | number | null = null;

  constructor() {
    // 1) Khởi tạo bản đồ đúng 1 lần, sau khi view có DOM thật.
    effect((onCleanup) => {
      const host = this.mapHost().nativeElement;
      const c = this.center();

      let cancelled = false;
      this.mapService
        .init({ container: host, center: [c.lng, c.lat], zoom: this.zoom() })
        .then(() => {
          if (cancelled) return;
          this.mapService.onMapClick((p) => {
            if (this.pickMode()) this.mapClick.emit(p);
          });
          this.ready.set(true);
        })
        .catch((err: Error) => !cancelled && this.error.set(err.message));

      onCleanup(() => {
        cancelled = true;
        this.routeService.destroy();
        this.mapService.destroy();
      });
    });

    // 2) Marker.
    effect(() => {
      const items = this.markers();
      const v = this.vehicle();
      if (!this.ready()) return;

      this.mapService.removeMarkerSource();
      for (const m of items) {
        this.mapService.addMarker(m, this.markerHtml(m), true);
      }
      if (v) {
        this.mapService.addMarker(
          v,
          `<div class="dms-vehicle-vt">${escapeHtml(v.label ?? '🚚')}</div>`,
        );
      }
    });

    // 3) Đường có sẵn hình học.
    effect(() => {
      const items = this.paths();
      if (this.ready()) this.mapService.renderPaths(items);
    });

    // 4) Định tuyến — tương đương `watch([getRoutingPointList, getRouteType])` bên Vue.
    effect(() => {
      const points = this.routingPoints();
      const color = this.lineColor();
      if (!this.ready()) return;
      void this.drawRoute(points, color);
    });

    // 5) Fit đúng một lần cho mỗi `fitToken`, và CHỜ tới khi có dữ liệu —
    //    cùng lý do như nhánh Leaflet, xem `osm-map.component.ts`.
    effect(() => {
      const token = this.fitToken();
      const coords = this.collectCoords();

      if (!this.ready() || token === this.appliedFitToken || !coords.length) return;

      this.appliedFitToken = token;
      this.mapService.fitToPoints(coords);
    });

    // 6) Bay tới một điểm.
    effect(() => {
      const point = this.focus();
      if (point && this.ready()) this.mapService.flyTo(point, 17);
    });

    this.destroyRef.onDestroy(() => this.routeService.destroy());
  }

  private collectCoords(): LatLng[] {
    const coords: LatLng[] = [];

    for (const p of this.paths()) {
      for (const pt of p.points) coords.push(pt);
    }
    for (const m of this.markers()) coords.push({ lat: m.lat, lng: m.lng });

    // `routingPoints` là các điểm SDK tự định tuyến — hình học chỉ có sau khi
    // gọi mạng, nhưng bản thân các điểm đã đủ để đặt khung nhìn đúng vùng.
    for (const p of this.routingPoints()) coords.push(p);

    const v = this.vehicle();
    if (v) coords.push({ lat: v.lat, lng: v.lng });

    return coords;
  }

  private async drawRoute(points: readonly LatLng[], color: string): Promise<void> {
    this.error.set(null);
    try {
      const { distanceMeters } = await this.routeService.drawExpectedRoute(
        points.map((p) => [p.lng, p.lat] as [number, number]),
        color,
      );
      if (points.length >= 2) {
        this.mapService.drawEndpointFlags(points.map((p) => [p.lng, p.lat] as [number, number]));
      }
      this.distanceChange.emit(distanceMeters);
    } catch (err) {
      // Dịch vụ định tuyến lỗi -> bỏ phần đường, marker vẫn phải hiển thị.
      this.error.set((err as Error).message);
      this.distanceChange.emit(0);
    }
  }

  /** Xem `html-safe.util.ts` — SDK Viettel nhận HTML thô y như Leaflet. */
  private markerHtml(m: MapMarker): string {
    const color = safeColor(m.color, MAP_COLORS.pending);
    if (m.dot) {
      return `<div class="dms-pin dms-pin--dot"><span style="background:${color}"></span></div>`;
    }
    return `<div class="dms-pin${m.active ? ' dms-pin--active' : ''}">
      <span style="background:${color}">${escapeHtml(m.label)}</span>
    </div>`;
  }
}

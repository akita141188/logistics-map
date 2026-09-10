import { Injectable, inject, signal } from '@angular/core';
import { MAP_ROUTING_CONFIG } from '../map-routing.config';
import { AnyRoutePoint, LatLng, LngLatTuple, MapPath } from '../map.types';
import {
  distanceMeters,
  isValidLatLng,
  normalizePoints,
} from '../geo.util';
import { VtmapLoaderService } from './vtmap-loader.service';
import { VtLngLatBounds, VtMap, VtMarker, Vtmapgl } from './vtmap.types';

/** Tâm mặc định: Đà Nẵng, zoom 5 — nhìn được toàn Việt Nam. */
const DEFAULT_CENTER: LngLatTuple = [108.2022, 16.0544];
const DEFAULT_ZOOM = 5;

const FLAG_GREEN = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 56 56"><path fill="green" d="M8.969 51.004c.984 0 1.781-.773 1.781-1.781V36.215c.586-.258 2.79-1.102 6.234-1.102c8.672 0 14.11 4.243 22.36 4.243c3.656 0 5.015-.399 6.797-1.196c1.617-.726 2.672-1.945 2.672-4.101V10.246c0-1.242-1.079-1.992-2.438-1.992c-1.148 0-3.305 1.008-7.336 1.008c-8.25 0-13.664-4.266-22.36-4.266c-3.656 0-5.038.398-6.82 1.195c-1.617.727-2.671 1.97-2.671 4.102v38.93c0 .96.82 1.78 1.78 1.78"/></svg>`;
const FLAG_RED = FLAG_GREEN.replace('fill="green"', 'fill="red"');

export interface ViettelMapInitOptions {
  container: string | HTMLElement;
  center?: LngLatTuple;
  zoom?: number;
  /** Thêm NavigationControl + GeolocateControl mặc định. */
  withDefaultControls?: boolean;
}

/**
 * Vòng đời bản đồ Viettel + quản lý marker/overlay.
 * Port phần "khung" của `MapUtil` (loadMap, addMarker, fitOverlays, killMap...).
 *
 * KHÁC BIỆT KIẾN TRÚC QUAN TRỌNG so với bản Vue:
 * `viettel-map.js` giữ `_map` và `_listOverlay` ở MODULE SCOPE (singleton toàn app).
 * Chính vì thế mới cần `isMapAlive()` rải khắp nơi: khi component unmount thì
 * `_map = null`, nhưng các `watch` async đang `await` vẫn resume và gọi tiếp vào
 * hàm cũ -> TypeError giữa chừng -> bản đồ đứng yên.
 *
 * Ở Angular, service này KHÔNG `providedIn: 'root'`. Nó được provide ở cấp
 * COMPONENT (`providers: [ViettelMapService]`), nên mỗi bản đồ có state riêng và
 * chết cùng component. Guard `assertAlive()` vẫn giữ để chặn race của tác vụ async
 * còn dở, nhưng không còn nguy cơ 2 màn hình giẫm chân nhau.
 */
@Injectable()
export class ViettelMapService {
  private readonly loader = inject(VtmapLoaderService);
  private readonly config = inject(MAP_ROUTING_CONFIG);

  private map: VtMap | null = null;
  private sdk: Vtmapgl | null = null;
  private overlays: VtMarker[] = [];
  /** ID các layer đường do app tự vẽ — cần nhớ để dọn ở lần render sau. */
  private pathLayerIds: string[] = [];

  /** Bản đồ đã khởi tạo xong chưa — dùng ở template với `@if`. */
  readonly ready = signal(false);

  async init(options: ViettelMapInitOptions): Promise<VtMap> {
    // Không có access token thì SDK vẫn tải được nhưng mọi request tile/route đều
    // trả 401 -> bản đồ xám trắng không rõ nguyên nhân. Báo lỗi sớm cho rõ ràng.
    if (!this.config.vtmapKey) {
      throw new Error(
        'Chưa cấu hình Viettel Map access token (vtmapKey trong app.config.ts). ' +
          'Đăng ký key tại https://maps.viettel.vn hoặc chọn provider OpenStreetMap.',
      );
    }

    const sdk = await this.loader.load();
    this.sdk = sdk;

    const container =
      typeof options.container === 'string'
        ? document.getElementById(options.container)
        : options.container;

    if (!container) {
      throw new Error('Không tìm thấy container của bản đồ');
    }
    // Bản Vue làm `innerHTML = ''` để tránh khởi tạo chồng 2 canvas khi vào lại màn.
    container.innerHTML = '';

    this.map = new sdk.Map({
      container,
      style: sdk.STYLES.VTRANS,
      center: options.center ?? DEFAULT_CENTER,
      zoom: options.zoom ?? DEFAULT_ZOOM,
    });

    if (options.withDefaultControls ?? true) {
      this.map.addControl(new sdk.NavigationControl(), 'top-right');
      this.map.addControl(
        new sdk.GeolocateControl({
          positionOptions: { enableHighAccuracy: true },
          trackUserLocation: true,
        }),
      );
    }

    this.ready.set(true);
    return this.map;
  }

  /** Truy cập map thô khi cần API chưa được bọc. Có thể null. */
  get instance(): VtMap | null {
    return this.map;
  }

  get vtmapgl(): Vtmapgl | null {
    return this.sdk;
  }

  /**
   * Map còn sống không. Mọi hàm thao tác với `map` PHẢI gọi guard này trước —
   * "map đã chết" là trạng thái HỢP LỆ, chỉ việc bỏ qua lệnh, không được ném lỗi.
   */
  isAlive(): boolean {
    return !!this.map;
  }

  /** Huỷ bản đồ. Gọi trong `ngOnDestroy` của component sở hữu. */
  destroy(): void {
    this.clearOverlays();
    this.map?.remove();
    this.map = null;
    this.ready.set(false);
  }

  // ---------------------------------------------------------------- markers

  /**
   * Cắm 1 marker HTML tuỳ biến.
   * @param addToOverlays có tính vào khung nhìn `fitOverlays()` hay không.
   */
  addMarker(
    point: LatLng,
    html?: string,
    addToOverlays = false,
  ): VtMarker | null {
    if (!this.map || !this.sdk) return null;
    if (!isValidLatLng(point.lng, point.lat)) return null;

    const el = document.createElement('div');
    el.innerHTML =
      html ?? '<img style="width:20px;height:25px;" src="/image/defmarker.png" alt="" />';

    const marker = new this.sdk.Marker({
      element: el,
      draggable: false,
      anchor: 'center',
    })
      .setLngLat([point.lng, point.lat])
      .addTo(this.map);

    if (addToOverlays) this.overlays.push(marker);
    return marker;
  }

  clearOverlays(): void {
    for (const overlay of this.overlays) {
      try {
        overlay.remove();
      } catch {
        // marker đã bị SDK gỡ khi map remove -> bỏ qua
      }
    }
    this.overlays = [];
  }

  /**
   * Xoá layer + source `markers` (KHÔNG đụng tới `roaddraw-layer` — đây chính là
   * cái bẫy khiến đường của lần vẽ trước còn nguyên trên bản đồ).
   */
  removeMarkerSource(): void {
    if (!this.map) {
      this.clearOverlays();
      return;
    }

    for (const id of ['clusters', 'cluster-count']) {
      if (this.map.getLayer(id)) this.map.removeLayer(id);
    }
    if (this.map.getLayer('markers') && this.map.getSource('markers')) {
      this.map.removeLayer('markers');
      this.map.removeSource('markers');
    }
    this.clearOverlays();
  }

  // ------------------------------------------------------------- viewport

  /**
   * Fit khung nhìn theo TOÀN BỘ overlay (marker khách hàng/nhân viên).
   *
   * CẢNH BÁO: hàm bắt đầu bằng `map.stop()` — nó HUỶ mọi animation đang chạy.
   * Đừng gọi sau `fitToPoints()`, nếu không khung nhìn sẽ nhảy về cụm marker
   * thay vì bám GPS track vừa vẽ.
   */
  fitOverlays(options?: { maxZoom?: number }): void {
    if (!this.map || !this.sdk || !this.overlays.length) return;

    this.map.stop();

    let bounds: VtLngLatBounds | null = null;
    for (const overlay of this.overlays) {
      const { lng, lat } = overlay.getLngLat();
      if (!isValidLatLng(lng, lat)) continue;

      const p = new this.sdk.LngLat(lng, lat);
      bounds = bounds ? bounds.extend(p) : new this.sdk.LngLatBounds(p, p);
    }
    if (!bounds) return;

    // Nới biên ra một chút để marker ở rìa không bị cắt (logic gốc bản Vue).
    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    const padding =
      distanceMeters(ne, sw) / 1000 / 1666 / this.map.getCanvas().height;

    bounds.setNorthEast({
      lng: Math.min(ne.lng + padding, 180),
      lat: Math.min(ne.lat + padding, 90),
    });
    bounds.setSouthWest({
      lng: Math.max(sw.lng - padding, -180),
      lat: Math.max(sw.lat - padding, -90),
    });

    this.map.fitBounds(bounds, options);
  }

  /** Fit khung nhìn theo một danh sách điểm cụ thể (GPS track). */
  fitToPoints(points: readonly AnyRoutePoint[]): void {
    if (!this.map || !this.sdk) return;

    const normalized = normalizePoints(points);
    if (!normalized.length) return;

    if (normalized.length === 1) {
      const [p] = normalized;
      this.map.flyTo({ center: [p.lng, p.lat], zoom: 16 });
      return;
    }

    const bounds = new this.sdk.LngLatBounds();
    for (const p of normalized) bounds.extend([p.lng, p.lat]);
    if (!bounds.isEmpty()) {
      this.map.fitBounds(bounds, { padding: 50, duration: 500 });
    }
  }

  flyTo(point: LatLng, zoom = 5, speed = 1): void {
    this.map?.flyTo({ center: [point.lng, point.lat], zoom, speed });
  }

  // ------------------------------------------------------- endpoint flags

  /**
   * Cắm cờ điểm ĐẦU (xanh) và điểm CUỐI (đỏ) của lộ trình.
   *
   * TRƯỜNG HỢP KHÉP VÒNG (lộ trình dự kiến xuất phát & kết thúc tại NPP nên toạ
   * độ đầu ≡ cuối): cắm 2 marker chồng khít thì cờ đỏ (vẽ sau) che hẳn cờ xanh.
   * Giải pháp: vẽ CẢ 2 lá cờ trong CÙNG 1 marker DOM (`display:flex`, cờ xanh lật
   * ngang) — như vậy khoảng cách giữa 2 cờ cố định theo PIXEL ở mọi mức zoom.
   * Nếu tách 2 marker rồi cộng lệch vào toạ độ thì khoảng hở sẽ giãn/thu theo zoom.
   */
  drawEndpointFlags(points: readonly AnyRoutePoint[]): void {
    const list = normalizePoints(points);
    if (!list.length) return;

    const start = list[0];
    const end = list[list.length - 1];

    if (list.length === 1) {
      this.addMarker(start, FLAG_GREEN, true);
      return;
    }

    if (start.lng === end.lng && start.lat === end.lat) {
      const flipped = FLAG_GREEN.replace(
        '<svg ',
        '<svg style="transform:scaleX(-1);margin-right:-9px" ',
      );
      this.addMarker(
        start,
        `<div style="display:flex;align-items:flex-end;white-space:nowrap">${flipped}${FLAG_RED}</div>`,
        true,
      );
      return;
    }

    this.addMarker(start, FLAG_GREEN, true);
    this.addMarker(end, FLAG_RED, true);
  }

  // ----------------------------------------------------------- custom paths

  /**
   * Vẽ các đường có sẵn hình học (lộ trình dự kiến nét đứt, GPS track...) bằng
   * source/layer GeoJSON của riêng app — TÁCH BIỆT hoàn toàn với `roaddraw-layer`
   * do `RoadDrawerControl` quản lý, nên hai bên không giẫm chân nhau.
   *
   * Mapbox/Viettel GL không có `dashArray` cho polyline như Leaflet; nét đứt khai
   * báo qua `line-dasharray` (đơn vị = bội số của `line-width`).
   */
  renderPaths(paths: readonly MapPath[]): void {
    if (!this.map) return;

    // Dọn sạch layer/source của lần vẽ trước. Thứ tự BẮT BUỘC: layer trước,
    // source sau — xoá source khi còn layer tham chiếu sẽ ném lỗi.
    for (const id of this.pathLayerIds) {
      try {
        if (this.map.getLayer(id)) this.map.removeLayer(id);
        if (this.map.getSource(id)) this.map.removeSource(id);
      } catch {
        // style chưa load xong -> bỏ qua, lần render sau sẽ vẽ lại
      }
    }
    this.pathLayerIds = [];

    for (const path of paths) {
      if (path.points.length < 2) continue;

      const id = `dms-path-${path.key}`;
      try {
        this.map.addSource(id, {
          type: 'geojson',
          data: {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'LineString',
              // GeoJSON: [lng, lat].
              coordinates: path.points.map((p) => [p.lng, p.lat]),
            },
          },
        });

        this.map.addLayer({
          id,
          type: 'line',
          source: id,
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': path.color ?? '#0ea5e9',
            'line-width': path.weight ?? 5,
            'line-opacity': path.opacity ?? 0.9,
            ...(path.dashed ? { 'line-dasharray': [2, 2] } : {}),
          },
        });

        this.pathLayerIds.push(id);
      } catch {
        // addSource/addLayer ném lỗi nếu style chưa sẵn sàng — bỏ qua đường này.
      }
    }
  }

  /** Đăng ký callback khi người dùng bấm lên bản đồ (chế độ chọn điểm). */
  onMapClick(handler: (point: LatLng) => void): void {
    this.map?.on('click', ((e: { lngLat: { lng: number; lat: number } }) => {
      handler({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    }) as (e: never) => void);
  }

  // ------------------------------------------------------------- geocoding

  /** Reverse geocode + zoom tới điểm (tương đương `getLocationBasedOnLatLng`). */
  async resolveAddress(point: LatLng): Promise<unknown> {
    const sdk = await this.loader.load();
    const service = new sdk.GeocoderAPIService({ accessToken: sdk.accessToken });

    const result = await new Promise<unknown>((resolve, reject) => {
      service.fetchLatlngToAddress(`${point.lat}, ${point.lng}`, (res, status) => {
        status === 0 ? resolve(res) : reject(status);
      });
    });

    this.map?.easeTo({ center: [point.lng, point.lat], zoom: 18 });
    return result;
  }

  /** Cấu hình (giới hạn điểm/marker) — route service dùng chung. */
  get routingLimits() {
    return {
      maxPoints: this.config.maxPointsForDrawer,
      maxMarkers: this.config.maxMarkers,
      epsilon: this.config.dedupeEpsilon,
    };
  }
}

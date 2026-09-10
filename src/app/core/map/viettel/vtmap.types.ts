/**
 * Khai báo type TỐI THIỂU cho SDK `vtmap-gl.js` v4.0.0.
 *
 * SDK này KHÔNG có trên npm và KHÔNG có file .d.ts — nó được nạp runtime từ CDN
 * `maps.viettel.vn` và gán vào global `window.vtmapgl` (UMD). Vì vậy phải tự
 * khai báo interface, chỉ khai báo đúng phần đang dùng.
 *
 * Tài liệu SDK: https://maps.viettel.vn/docs
 * API bề mặt gần như trùng mapbox-gl v1 — nếu cần thêm method, tra doc mapbox-gl v1 trước.
 */

export interface VtLngLat {
  lng: number;
  lat: number;
}

export interface VtLngLatBounds {
  extend(point: [number, number] | VtLngLat): VtLngLatBounds;
  isEmpty(): boolean;
  getNorthEast(): VtLngLat;
  getSouthWest(): VtLngLat;
  setNorthEast(p: VtLngLat): void;
  setSouthWest(p: VtLngLat): void;
}

export interface VtMarker {
  setLngLat(lngLat: [number, number]): VtMarker;
  getLngLat(): VtLngLat;
  addTo(map: VtMap): VtMarker;
  remove(): void;
}

export interface VtPopup {
  setLngLat(lngLat: [number, number]): VtPopup;
  setHTML(html: string): VtPopup;
  setMaxWidth(width: string): VtPopup;
  addTo(map: VtMap): VtPopup;
  remove(): void;
}

export interface VtFitBoundsOptions {
  padding?: number | { top: number; bottom: number; left: number; right: number };
  duration?: number;
  maxZoom?: number;
}

export interface VtLayerSpec {
  id: string;
  type: 'line' | 'symbol' | 'fill' | 'circle';
  source: string;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
}

export interface VtMap {
  addControl(control: unknown, position?: string): VtMap;
  removeControl(control: unknown): VtMap;
  addLayer(layer: VtLayerSpec): VtMap;
  removeLayer(id: string): VtMap;
  getLayer(id: string): unknown;
  addSource(id: string, source: unknown): VtMap;
  removeSource(id: string): VtMap;
  getSource(id: string): unknown;
  getContainer(): HTMLElement;
  getCanvas(): HTMLCanvasElement;
  getZoom(): number;
  fitBounds(bounds: VtLngLatBounds, options?: VtFitBoundsOptions): VtMap;
  flyTo(options: { center: [number, number]; zoom?: number; speed?: number }): VtMap;
  easeTo(options: { center: [number, number]; zoom?: number }): VtMap;
  stop(): VtMap;
  on(event: string, listener: (e: never) => void): VtMap;
  on(event: string, layerId: string, listener: (e: never) => void): VtMap;
  remove(): void;
}

/**
 * Control định tuyến của Viettel — TRÁI TIM của tính năng chỉ đường.
 *
 * Đặc tính quan trọng (và khó chịu):
 *  - `setPoints()` KHÔNG trả Promise. Kết quả routing chỉ được biết qua việc SDK
 *    ghi text vào phần tử DOM `#road-draw-total-distance`.
 *  - Kết quả hình học được ghi vào source `roaddraw-source`; app phải tự thêm
 *    layer `roaddraw-layer` để tô màu/độ dày.
 *  - Mỗi control chỉ giữ được MỘT tuyến; `setPoints()` lần sau ghi đè lần trước.
 *  - `_container`, `_totalDistanceEl` là private API nhưng bắt buộc phải đụng tới
 *    để ẩn toolbar mặc định.
 */
export interface VtRoadDrawerControl {
  setPoints(points: [number, number][]): void;
  deactive(): void;
  refresh(): void;
  _container?: HTMLElement;
  _totalDistanceEl?: HTMLElement;
}

export interface Vtmapgl {
  accessToken: string;
  STYLES: { VTRANS: string; [key: string]: string };
  Map: new (options: {
    container: string | HTMLElement;
    style: string;
    center: [number, number];
    zoom: number;
  }) => VtMap;
  Marker: new (options?: {
    element?: HTMLElement;
    draggable?: boolean;
    anchor?: string;
  }) => VtMarker;
  Popup: new (options?: {
    className?: string;
    closeOnClick?: boolean;
    offset?: number;
  }) => VtPopup;
  LngLat: new (lng: number, lat: number) => VtLngLat;
  LngLatBounds: new (sw?: VtLngLat, ne?: VtLngLat) => VtLngLatBounds;
  NavigationControl: new () => unknown;
  FullscreenControl: new () => unknown;
  GeolocateControl: new (options?: unknown) => unknown;
  RoadDrawerControl: new (options: {
    accessToken: string;
    mode?: 'driving' | 'cycling' | 'walking';
    lineColor?: string;
    alternatives?: boolean;
  }) => VtRoadDrawerControl;
  GeocoderAPIService: new (options: { accessToken: string }) => {
    fetchLatlngToAddress(
      latlng: string,
      callback: (result: unknown, status: number) => void,
    ): void;
  };
}

declare global {
  interface Window {
    vtmapgl?: Vtmapgl;
  }
}

/** ID cố định do SDK quy ước — đừng đổi. */
export const ROAD_SOURCE_ID = 'roaddraw-source';
export const ROAD_LAYER_ID = 'roaddraw-layer';
export const ROAD_DISTANCE_ELEMENT_ID = 'road-draw-total-distance';
export const ROAD_MARKER_CLASS = 'indexed-marker';

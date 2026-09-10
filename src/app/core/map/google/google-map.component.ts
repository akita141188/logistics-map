import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  GoogleMap,
  MapCircle as GmapCircle,
  MapMarker as GmapMarker,
  MapPolyline,
} from '@angular/google-maps';
import { MAP_ROUTING_CONFIG } from '../map-routing.config';
import { LatLng, MAP_COLORS, MapCircle, MapMarker, MapPath } from '../map.types';
import { GoogleMapsLoaderService } from './google-maps-loader.service';

/**
 * Nhánh Google Map — dùng package CHÍNH CHỦ `@angular/google-maps`
 * (cùng team Angular maintain, không phải thư viện cộng đồng).
 *
 * ```bash
 * npm i @angular/google-maps
 * npm i -D @types/google.maps
 * ```
 *
 * Bảng đối chiếu nếu bạn đang chuyển từ `vue3-google-map`:
 * | vue3-google-map   | @angular/google-maps      |
 * |-------------------|---------------------------|
 * | `<GoogleMap>`     | `<google-map>`            |
 * | `<Marker>`        | `<map-marker>`            |
 * | `<CustomMarker>`  | `<map-advanced-marker>`   |
 * | `<Polyline>`      | `<map-polyline>`          |
 * | `<InfoWindow>`    | `<map-info-window>`       |
 * | `<MarkerCluster>` | `<map-marker-clusterer>`  |
 *
 * Ở đây dùng `<map-marker>` (marker cổ điển) thay vì `<map-advanced-marker>`:
 * advanced marker BẮT BUỘC phải có `mapId` hợp lệ tạo trong Cloud Console,
 * dùng `DEMO_MAP_ID` sẽ chỉ hiện cảnh báo và marker không lên.
 */
@Component({
  selector: 'dms-google-map',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GoogleMap, GmapMarker, MapPolyline, GmapCircle],
  template: `
    @if (loadError(); as message) {
      <div class="gmap-error">
        <strong>Không dùng được Google Map</strong>
        <p>{{ message }}</p>
      </div>
    } @else if (ready()) {
      <google-map
        height="100%"
        width="100%"
        [center]="center()"
        [zoom]="zoom()"
        [options]="mapOptions()"
        (mapClick)="onMapClick($event)"
      >
        @for (marker of markers(); track marker.key) {
          <map-marker
            [position]="{ lat: marker.lat, lng: marker.lng }"
            [title]="marker.title ?? ''"
            [options]="markerOptions(marker)"
            (mapClick)="markerClick.emit(marker)"
          />
        }

        @if (vehicle(); as v) {
          <map-marker [position]="{ lat: v.lat, lng: v.lng }" [options]="vehicleOptions()" />
        }

        @for (path of paths(); track path.key) {
          <map-polyline [path]="path.points" [options]="pathOptions(path)" />
        }

        @for (circle of circles(); track circle.key) {
          <map-circle
            [center]="circle.center"
            [radius]="circle.radiusMeters"
            [options]="circleOptions(circle)"
          />
        }
      </google-map>
    } @else {
      <div class="gmap-loading">Đang tải Google Maps…</div>
    }
  `,
  styles: `
    :host {
      display: block;
      position: relative;
      width: 100%;
      height: 100%;
    }
    .gmap-error,
    .gmap-loading {
      display: grid;
      place-content: center;
      gap: 6px;
      height: 100%;
      padding: 24px;
      text-align: center;
      font-size: 13px;
      color: #475569;
      background: #f1f5f9;
    }
    .gmap-error strong {
      color: #dc2626;
    }
  `,
})
export class GoogleMapComponent {
  private readonly loader = inject(GoogleMapsLoaderService);
  private readonly config = inject(MAP_ROUTING_CONFIG);

  readonly center = input<LatLng>({ lat: 21.0278, lng: 105.8342 });
  readonly zoom = input(12);
  readonly markers = input<readonly MapMarker[]>([]);
  readonly paths = input<readonly MapPath[]>([]);
  readonly vehicle = input<MapMarker | null>(null);
  /** Geofence — `<map-circle>` nhận bán kính theo MÉT, đúng đơn vị của `MapCircle`. */
  readonly circles = input<readonly MapCircle[]>([]);
  readonly pickMode = input(false);
  /** Đổi giá trị này để ép bản đồ ôm trọn dữ liệu vào khung nhìn. */
  readonly fitToken = input<string | number>(0);
  /** Bay tới một điểm cụ thể (bấm vào một điểm giao, một cảnh báo...). */
  readonly focus = input<LatLng | null>(null);

  readonly mapClick = output<LatLng>();
  readonly markerClick = output<MapMarker>();

  protected readonly ready = signal(false);
  protected readonly loadError = signal<string | null>(null);

  /**
   * `viewChild` chứ không `ViewChild` cổ điển: `<google-map>` nằm trong `@if`
   * nên tham chiếu xuất hiện MUỘN (sau khi SDK tải xong). Signal-based query trả
   * `undefined` rồi tự cập nhật, không cần `ngAfterViewInit` + kiểm tra null rải rác.
   */
  private readonly mapRef = viewChild(GoogleMap);

  /** `fitToken` đã thực hiện — xem effect fit ở constructor. */
  private appliedFitToken: string | number | null = null;

  protected readonly mapOptions = computed<google.maps.MapOptions>(() => {
    // CHỈ đặt `mapId` khi đó là Map ID THẬT.
    // Đặt một mapId không hợp lệ khiến Google chuyển map sang chế độ vector và
    // log "The map is initialised without a valid Map ID"; đồng thời mọi tuỳ
    // biến qua `styles` bị vô hiệu. Ở đây dùng marker cổ điển nên không cần
    // mapId — bỏ hẳn đi thì map raster chạy sạch, không cảnh báo.
    const mapId = this.config.googleMapId;
    const hasRealMapId = !!mapId && mapId !== 'DEMO_MAP_ID';

    return {
      mapId: hasRealMapId ? mapId : undefined,
      disableDefaultUI: false,
      clickableIcons: false,
      draggableCursor: this.pickMode() ? 'crosshair' : undefined,
    };
  });

  constructor() {
    effect(() => {
      this.loader
        .load()
        .then(() => this.ready.set(true))
        .catch((err: Error) => this.loadError.set(err.message));
    });

    /**
     * Fit đúng một lần cho mỗi `fitToken`, và CHỜ tới khi có dữ liệu.
     *
     * Cùng lý do như nhánh Leaflet: đổi chuyến là dữ liệu rỗng trong vài trăm
     * mili-giây, fit vào lúc đó thì không có gì để ôm, mà token thì đã "dùng
     * xong" — bản đồ nằm lại chuyến cũ. Xem `osm-map.component.ts`.
     */
    effect(() => {
      const token = this.fitToken();
      const coords = this.collectCoords();
      const map = this.mapRef()?.googleMap;

      if (!map || token === this.appliedFitToken || !coords.length) return;

      this.appliedFitToken = token;

      if (coords.length === 1) {
        map.setCenter(coords[0]);
        map.setZoom(16);
        return;
      }

      const bounds = new google.maps.LatLngBounds();
      for (const c of coords) bounds.extend(c);
      // Số thứ hai là padding theo PIXEL, không phải mét.
      map.fitBounds(bounds, 48);
    });

    effect(() => {
      const point = this.focus();
      const map = this.mapRef()?.googleMap;
      if (!point || !map) return;

      map.panTo(point);
      if ((map.getZoom() ?? 0) < 15) map.setZoom(17);
    });
  }

  private collectCoords(): LatLng[] {
    const coords: LatLng[] = [];

    for (const p of this.paths()) {
      for (const pt of p.points) coords.push(pt);
    }
    for (const m of this.markers()) coords.push({ lat: m.lat, lng: m.lng });

    const v = this.vehicle();
    if (v) coords.push({ lat: v.lat, lng: v.lng });

    return coords;
  }

  protected onMapClick(event: google.maps.MapMouseEvent | google.maps.IconMouseEvent): void {
    if (!this.pickMode() || !event.latLng) return;
    this.mapClick.emit({ lat: event.latLng.lat(), lng: event.latLng.lng() });
  }

  /**
   * Marker có nhãn số thứ tự: Google Maps không cho HTML tuỳ ý trong marker cổ
   * điển, nên dùng `label` + symbol vẽ vector (`SymbolPath.CIRCLE`).
   */
  protected markerOptions(m: MapMarker): google.maps.MarkerOptions {
    return {
      label: m.label ? { text: m.label, color: '#fff', fontSize: '11px', fontWeight: '700' } : null,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: m.active ? 15 : m.dot ? 5 : 12,
        fillColor: m.color ?? MAP_COLORS.pending,
        fillOpacity: 1,
        strokeColor: '#ffffff',
        strokeWeight: 2,
      },
      zIndex: m.active ? 1000 : 1,
    };
  }

  protected vehicleOptions(): google.maps.MarkerOptions {
    return {
      icon: {
        path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
        scale: 6,
        fillColor: MAP_COLORS.real,
        fillOpacity: 1,
        strokeColor: '#ffffff',
        strokeWeight: 2,
      },
      zIndex: 2000,
    };
  }

  /**
   * Vòng geofence.
   *
   * `clickable: false` là bắt buộc: vòng tròn phủ lên marker điểm giao nằm ở tâm
   * nó, để bắt sự kiện chuột thì người dùng không bấm được vào chính điểm giao.
   */
  protected circleOptions(circle: MapCircle): google.maps.CircleOptions {
    return {
      strokeColor: circle.color ?? MAP_COLORS.done,
      strokeOpacity: 0.9,
      strokeWeight: circle.dashed ? 1 : 2,
      fillColor: circle.color ?? MAP_COLORS.done,
      fillOpacity: circle.fillOpacity ?? 0.08,
      clickable: false,
      zIndex: 0,
    };
  }

  /**
   * Nét đứt trong Google Maps KHÔNG có `strokeDashArray`: phải đặt
   * `strokeOpacity: 0` rồi lặp lại một icon gạch dọc dọc theo đường.
   */
  protected pathOptions(path: MapPath): google.maps.PolylineOptions {
    return {
      geodesic: true,
      strokeColor: path.color ?? MAP_COLORS.real,
      strokeOpacity: path.dashed ? 0 : (path.opacity ?? 0.9),
      strokeWeight: path.weight ?? 5,
      icons: path.dashed
        ? [
            {
              icon: {
                path: 'M 0,-1 0,1',
                strokeOpacity: 1,
                strokeColor: path.color ?? MAP_COLORS.expected,
                scale: 3,
              },
              offset: '0',
              repeat: '14px',
            },
          ]
        : undefined,
    };
  }
}

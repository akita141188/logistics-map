import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { map } from 'rxjs/operators';
import { MAP_ROUTING_CONFIG } from '../map-routing.config';
import { LatLng, MapProvider, RouteResult, RouteSource, RouteStep, TravelMode } from '../map.types';
import { RoutingError, TRAVEL_MODE_LABEL } from '../routing.error';

interface OsrmManeuver {
  type: string;
  modifier?: string;
  location: [number, number];
  exit?: number;
}

interface OsrmStep {
  distance: number;
  duration: number;
  name: string;
  maneuver: OsrmManeuver;
}

interface OsrmLeg {
  distance: number;
  duration: number;
  steps?: OsrmStep[];
}

interface OsrmRoute {
  /** GeoJSON LineString — coordinates là [lng, lat]. */
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  distance: number; // mét
  duration: number; // giây
  legs?: OsrmLeg[];
}

interface OsrmResponse {
  code: string;
  message?: string;
  routes?: OsrmRoute[];
}

export interface OsrmRouteOptions {
  travelMode?: TravelMode;
  /** Lấy kèm chỉ dẫn rẽ từng chặng (`steps=true`). */
  withSteps?: boolean;
  /** Trả về tối đa 3 phương án thay thế. */
  alternatives?: boolean;
}

/**
 * ================== ĐỊNH TUYẾN BẰNG OSRM (OpenStreetMap) ==================
 *
 * Đây là provider DUY NHẤT chạy được mà KHÔNG cần API key — nên demo lấy làm
 * mặc định.
 *
 * CẢNH BÁO PRODUCTION:
 *  - `router.project-osrm.org` là **server demo công cộng**: không SLA,
 *    rate-limit gắt, có thể chết bất cứ lúc nào. Muốn dùng thật phải self-host:
 *    ```bash
 *    wget https://download.geofabrik.de/asia/vietnam-latest.osm.pbf
 *    docker run -t -v "${PWD}:/data" osrm/osrm-backend \
 *      osrm-extract -p /opt/car.lua /data/vietnam-latest.osm.pbf
 *    docker run -t -v "${PWD}:/data" osrm/osrm-backend osrm-partition /data/vietnam-latest.osrm
 *    docker run -t -v "${PWD}:/data" osrm/osrm-backend osrm-customize /data/vietnam-latest.osrm
 *    docker run -t -i -p 5000:5000 -v "${PWD}:/data" osrm/osrm-backend \
 *      osrm-routed --algorithm mld /data/vietnam-latest.osrm
 *    ```
 *  - OSRM nhận toạ độ theo thứ tự **`lng,lat`** ngăn cách bởi `;` — ngược với
 *    Leaflet (`[lat, lng]`). Đây là bẫy dễ dính nhất khi nối 2 thư viện này.
 *  - Toạ độ nằm trong query string -> gửi vài nghìn điểm GPS thô sẽ dính
 *    `414 URI Too Long`. Luôn `decimatePoints()` trước khi gọi.
 */
@Injectable({ providedIn: 'root' })
export class OsrmRoutingService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(MAP_ROUTING_CONFIG);

  /**
   * @param points điểm theo thứ tự đi qua, dạng `{ lat, lng }`.
   * @returns đường đi đã giải mã + quãng đường (mét) + thời gian (giây).
   */
  async computeRoute(
    points: readonly LatLng[],
    options: OsrmRouteOptions = {},
  ): Promise<RouteResult> {
    const routes = await this.computeRoutes(points, options);
    if (!routes.length) {
      const mode = options.travelMode ?? 'driving';
      throw new RoutingError(
        'NO_ROUTE',
        `OSRM không tìm được lộ trình ${TRAVEL_MODE_LABEL[mode].toLowerCase()} cho các điểm đã chọn.`,
        mode,
        this.sourceOf(mode).label,
      );
    }
    return routes[0];
  }

  /**
   * Hồ sơ (profile) OSRM THẬT SỰ được dùng cho một phương tiện.
   *
   * ⚠️ Đoạn `/driving/` trong URL của OSRM **không chọn phương tiện** — mỗi
   * server chỉ biên dịch được đúng MỘT profile Lua, phương tiện chọn bằng cách
   * đổi base URL (xem `osrmProfileBaseUrl`).
   *
   * `router.project-osrm.org` chỉ có hồ sơ ô tô, nên **xe máy chạy bằng hồ sơ
   * ô tô** — sai ở chỗ nó tránh mọi ngõ cấm ô tô và tôn trọng đường một chiều
   * dành cho ô tô, trong khi xe máy ở Việt Nam đi được nhiều đường hơn. Đây là
   * giới hạn thật, nên trả về `degraded: true` để UI nói rõ chứ không giấu.
   */
  sourceOf(mode: TravelMode): RouteSource {
    const dedicated = this.config.osrmProfileBaseUrl[mode];
    const degraded = mode === 'motorbike' && !dedicated;

    return {
      provider: MapProvider.OpenStreet,
      label: `OSRM ${TRAVEL_MODE_LABEL[mode]}`,
      travelMode: mode,
      profile: dedicated ?? this.config.osrmBaseUrl,
      degraded: degraded || undefined,
      note: degraded
        ? 'OSRM công cộng không có hồ sơ xe máy — đang dùng hồ sơ ô tô, đường đi có thể dài hơn thực tế.'
        : undefined,
    };
  }

  /**
   * Trả về TẤT CẢ phương án OSRM tìm được (khi `alternatives: true`).
   *
   * OSRM chỉ sinh phương án thay thế cho tuyến **2 điểm**. Có waypoint trung gian
   * thì tham số `alternatives` bị bỏ qua — không phải lỗi, là thiết kế của OSRM:
   * bài toán tìm đường thay thế qua nhiều điểm là bài toán khác hẳn.
   */
  async computeRoutes(
    points: readonly LatLng[],
    options: OsrmRouteOptions = {},
  ): Promise<RouteResult[]> {
    if (points.length < 2) {
      return [{ path: [...points], distanceMeters: 0, durationSeconds: 0, steps: [] }];
    }

    const mode = options.travelMode ?? 'driving';
    // OSRM: "lng,lat;lng,lat;..."
    const coordinates = points.map((p) => `${p.lng},${p.lat}`).join(';');

    const query = new URLSearchParams({
      overview: 'full',
      geometries: 'geojson',
      steps: options.withSteps ? 'true' : 'false',
      alternatives: options.alternatives ? 'true' : 'false',
    });

    // Đoạn `/driving/` là bắt buộc về cú pháp nhưng KHÔNG chọn phương tiện —
    // profile do server quyết định. Phương tiện được chọn bằng cách đổi base URL.
    const baseUrl = this.config.osrmProfileBaseUrl[mode] ?? this.config.osrmBaseUrl;
    const url = `${baseUrl}/driving/${coordinates}?${query.toString()}`;

    return firstValueFrom(
      this.http.get<OsrmResponse>(url).pipe(
        map((res) => {
          if (res.code !== 'Ok' || !res.routes?.length) {
            // `NoRoute` là câu trả lời hợp lệ ("hai điểm không nối được"),
            // khác hẳn `InvalidUrl`/lỗi mạng. Phân biệt để UI nói đúng chuyện.
            throw new RoutingError(
              res.code === 'NoRoute' ? 'NO_ROUTE' : 'PROVIDER_ERROR',
              res.message ??
                `OSRM không tìm được lộ trình ${TRAVEL_MODE_LABEL[mode].toLowerCase()} (mã ${res.code}).`,
              mode,
              this.sourceOf(mode).label,
            );
          }
          const source = this.sourceOf(mode);
          return res.routes.map((r) => this.toRouteResult(r, source));
        }),
      ),
    );
  }

  private toRouteResult(route: OsrmRoute, source: RouteSource): RouteResult {
    return {
      // GeoJSON trả [lng, lat] -> đảo lại cho Leaflet/Google.
      path: route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      steps: (route.legs ?? []).flatMap((leg) => (leg.steps ?? []).map((s) => this.toStep(s))),
      // OSRM luôn trả `legs` (không cần xin thêm field): đúng bằng số waypoint - 1.
      legs: (route.legs ?? []).map((leg) => ({
        distanceMeters: leg.distance,
        durationSeconds: leg.duration,
      })),
      source,
    };
  }

  private toStep(step: OsrmStep): RouteStep {
    const [lng, lat] = step.maneuver.location;
    return {
      instruction: this.describe(step),
      roadName: step.name,
      distanceMeters: step.distance,
      durationSeconds: step.duration,
      location: { lat, lng },
      maneuver: step.maneuver.type,
      modifier: step.maneuver.modifier,
    };
  }

  /**
   * OSRM chỉ trả `maneuver.type` + `modifier` (tiếng Anh, dạng mã) chứ KHÔNG trả
   * câu chỉ dẫn. Bên thứ 3 hay dùng `osrm-text-instructions`, nhưng thư viện đó
   * không có bản dịch tiếng Việt — nên tự dựng câu ở đây.
   */
  private describe(step: OsrmStep): string {
    const { type, modifier, exit } = step.maneuver;
    const road = step.name ? ` vào ${step.name}` : '';

    const direction = (): string => {
      switch (modifier) {
        case 'left':
          return 'Rẽ trái';
        case 'right':
          return 'Rẽ phải';
        case 'sharp left':
          return 'Rẽ gấp sang trái';
        case 'sharp right':
          return 'Rẽ gấp sang phải';
        case 'slight left':
          return 'Chếch sang trái';
        case 'slight right':
          return 'Chếch sang phải';
        case 'uturn':
          return 'Quay đầu';
        default:
          return 'Đi thẳng';
      }
    };

    switch (type) {
      case 'depart':
        return `Xuất phát${road}`;
      case 'arrive':
        return modifier === 'left'
          ? 'Đã tới nơi, điểm đến ở bên trái'
          : modifier === 'right'
            ? 'Đã tới nơi, điểm đến ở bên phải'
            : 'Đã tới nơi';
      case 'roundabout':
      case 'rotary':
        return `Vào vòng xuyến, ra lối thứ ${exit ?? 1}${road}`;
      case 'merge':
        return `Nhập làn${road}`;
      case 'fork':
        return `Tại ngã ba, ${direction().toLowerCase()}${road}`;
      case 'on ramp':
        return `Đi vào đường dẫn${road}`;
      case 'off ramp':
        return `Ra khỏi đường dẫn${road}`;
      case 'continue':
        return `Tiếp tục${road}`;
      case 'new name':
        return `Đi tiếp${road}`;
      default:
        return `${direction()}${road}`;
    }
  }
}

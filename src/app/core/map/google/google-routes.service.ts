import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { map } from 'rxjs/operators';
import { MAP_ROUTING_CONFIG } from '../map-routing.config';
import { LatLng, MapProvider, RouteResult, RouteStep, TravelMode } from '../map.types';
import { decode } from '../polyline.util';
import { RoutingError, TRAVEL_MODE_LABEL } from '../routing.error';

const ROUTES_API = 'https://routes.googleapis.com/directions/v2:computeRoutes';

type GoogleTravelMode = 'DRIVE' | 'BICYCLE' | 'WALK' | 'TWO_WHEELER' | 'TRANSIT';

const TRAVEL_MODE: Record<TravelMode, GoogleTravelMode> = {
  driving: 'DRIVE',
  motorbike: 'TWO_WHEELER',
  walking: 'WALK',
  cycling: 'BICYCLE',
};

type RoutingPreference = 'TRAFFIC_UNAWARE' | 'TRAFFIC_AWARE' | 'TRAFFIC_AWARE_OPTIMAL';

export interface ComputeRoutesOptions {
  travelMode?: TravelMode;
  routingPreference?: RoutingPreference;
  /** Cho phép Google sắp xếp lại thứ tự waypoint để tối ưu quãng đường. */
  optimizeWaypointOrder?: boolean;
  computeAlternativeRoutes?: boolean;
  withSteps?: boolean;
  languageCode?: string;
}

interface GoogleStep {
  distanceMeters?: number;
  staticDuration?: string;
  navigationInstruction?: { maneuver?: string; instructions?: string };
  startLocation?: { latLng?: { latitude?: number; longitude?: number } };
}

interface ComputeRoutesResponse {
  routes?: {
    polyline?: { encodedPolyline?: string };
    distanceMeters?: number;
    duration?: string;
    legs?: { steps?: GoogleStep[]; distanceMeters?: number; duration?: string }[];
    optimizedIntermediateWaypointIndex?: number[];
  }[];
}

/**
 * Định tuyến bằng **Google Routes API v2** (`directions/v2:computeRoutes`).
 * Đây là API thay thế cho Directions API cũ (`/maps/api/directions/json`).
 *
 * LƯU Ý API — đọc kỹ, sai là mất tiền hoặc mất dữ liệu:
 *  - Header `X-Goog-FieldMask` là **BẮT BUỘC**. Muốn thêm dữ liệu (vd chỉ dẫn rẽ
 *    `routes.legs.steps.navigationInstruction`) thì phải khai báo thêm ở đây,
 *    nếu không response sẽ rỗng phần đó — không có lỗi, chỉ đơn giản là thiếu.
 *  - Routes API **tính tiền theo FieldMask**: xin `legs.steps` đắt hơn hẳn chỉ xin
 *    polyline. Vì thế `withSteps` mặc định là `false`.
 *  - Giới hạn 25 waypoint trung gian (`intermediates`) cho tài khoản thường.
 *  - `duration` trả về dạng chuỗi `"1234s"` chứ không phải số.
 *  - API này gọi bằng REST thuần (không qua JS SDK) nên key phải mở quyền
 *    "Routes API" và giới hạn theo HTTP referrer.
 */
@Injectable({ providedIn: 'root' })
export class GoogleRoutesService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(MAP_ROUTING_CONFIG);

  /** Hạn mức `intermediates` của tài khoản Routes API thường. */
  static readonly MAX_INTERMEDIATES = 25;

  private static readonly BASE_FIELDS = [
    'routes.polyline.encodedPolyline',
    'routes.distanceMeters',
    'routes.duration',
    // Quãng đường/thời gian TỪNG CHẶNG. Hai field này nằm trong nhóm Basic của
    // Routes API (không đội giá lên bậc Advanced như `legs.steps.*`), nên xin
    // luôn — thiếu nó thì không tính được ETA của từng điểm giao.
    'routes.legs.distanceMeters',
    'routes.legs.duration',
  ];

  private static readonly STEP_FIELDS = [
    'routes.legs.steps.navigationInstruction',
    'routes.legs.steps.distanceMeters',
    'routes.legs.steps.staticDuration',
    'routes.legs.steps.startLocation',
  ];

  /**
   * @param points điểm ĐẦU là origin, điểm CUỐI là destination, phần giữa là
   *               `intermediates` (waypoint).
   */
  async computeRoute(
    points: readonly LatLng[],
    options: ComputeRoutesOptions = {},
  ): Promise<RouteResult> {
    const routes = await this.computeRoutes(points, options);
    if (!routes.length) {
      throw new RoutingError(
        'NO_ROUTE',
        `Google Routes không tìm được lộ trình ${TRAVEL_MODE_LABEL[options.travelMode ?? 'driving'].toLowerCase()} cho các điểm đã chọn.`,
        options.travelMode,
        'Google Routes',
      );
    }
    return routes[0];
  }

  /**
   * Như `computeRoute` nhưng trả về **tất cả** phương án Google đề xuất.
   *
   * Google chỉ sinh phương án thay thế khi `computeAlternativeRoutes: true` VÀ
   * tuyến không có waypoint trung gian — có `intermediates` thì API luôn trả về
   * đúng một tuyến. Đây là hạn chế của API, không phải lỗi cấu hình.
   */
  async computeRoutes(
    points: readonly LatLng[],
    options: ComputeRoutesOptions = {},
  ): Promise<RouteResult[]> {
    if (points.length < 2) {
      return [{ path: [...points], distanceMeters: 0, durationSeconds: 0, steps: [] }];
    }

    const mode = options.travelMode ?? 'driving';
    const travelMode = TRAVEL_MODE[mode];

    /*
     * Routes API chặn cứng 25 waypoint trung gian.
     *
     * Trước đây chỗ này là `.slice(0, 25)` — tức là **âm thầm vứt bớt điểm giao**
     * rồi vẫn trả về một tuyến trông hoàn toàn hợp lệ. Có 35 khách thì 8 khách
     * biến mất khỏi lộ trình mà không ai biết. Giờ ném lỗi và để `RoutingFacade`
     * cắt tuyến thành nhiều request nối đuôi (xem `computeChunked`).
     */
    const intermediates = points.slice(1, -1);
    if (intermediates.length > GoogleRoutesService.MAX_INTERMEDIATES) {
      throw new RoutingError(
        'PROVIDER_ERROR',
        `Google Routes chỉ nhận tối đa ${GoogleRoutesService.MAX_INTERMEDIATES} điểm trung gian, tuyến này có ${intermediates.length}.`,
        mode,
        'Google Routes',
      );
    }

    const body = {
      origin: this.toWaypoint(points[0]),
      destination: this.toWaypoint(points[points.length - 1]),
      intermediates: intermediates.map((p) => this.toWaypoint(p)),
      travelMode,
      // TRAFFIC_AWARE chỉ hợp lệ với DRIVE/TWO_WHEELER; mode khác phải bỏ đi.
      routingPreference:
        travelMode === 'DRIVE' || travelMode === 'TWO_WHEELER'
          ? (options.routingPreference ?? 'TRAFFIC_AWARE')
          : undefined,
      computeAlternativeRoutes: options.computeAlternativeRoutes ?? false,
      optimizeWaypointOrder: options.optimizeWaypointOrder ?? false,
      languageCode: options.languageCode ?? 'vi',
      units: 'METRIC',
    };

    const fieldMask = options.withSteps
      ? [...GoogleRoutesService.BASE_FIELDS, ...GoogleRoutesService.STEP_FIELDS]
      : GoogleRoutesService.BASE_FIELDS;

    const headers = new HttpHeaders({
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': this.config.googleMapsKey,
      'X-Goog-FieldMask': fieldMask.join(','),
    });

    return firstValueFrom(
      this.http.post<ComputeRoutesResponse>(ROUTES_API, body, { headers }).pipe(
        map((res) => {
          const list = res.routes ?? [];

          // `routes: []` là câu trả lời HỢP LỆ của Google cho "không có tuyến"
          // (hay gặp nhất với BICYCLE ở Việt Nam — Google không phủ dữ liệu xe
          // đạp ở đây). Đây KHÔNG phải chỗ để bịa ra một tuyến rỗng.
          if (!list.length) {
            throw new RoutingError(
              'NO_ROUTE',
              `Google Routes không tìm được lộ trình ${TRAVEL_MODE_LABEL[mode].toLowerCase()} cho các điểm đã chọn.`,
              mode,
              'Google Routes',
            );
          }

          const results = list
            .map((_, i) => this.toRouteResult(res, i, mode))
            .filter((r): r is RouteResult => r !== null);

          if (!results.length) {
            throw new RoutingError(
              'NO_ROUTE',
              `Google Routes trả về tuyến ${TRAVEL_MODE_LABEL[mode].toLowerCase()} không có hình học đường đi.`,
              mode,
              'Google Routes',
            );
          }

          return results;
        }),
      ),
    );
  }

  private toWaypoint({ lat, lng }: LatLng) {
    return { location: { latLng: { latitude: lat, longitude: lng } } };
  }

  /**
   * `null` = tuyến này không dùng được (thiếu polyline / thiếu số liệu).
   *
   * Không bao giờ trả về "tuyến nối thẳng các waypoint" thay thế: đường chim bay
   * hiện lên bản đồ y như đường thật, nhưng km và ETA thì sai hoàn toàn.
   */
  private toRouteResult(
    response: ComputeRoutesResponse,
    index: number,
    mode: TravelMode,
  ): RouteResult | null {
    const route = response.routes?.[index];
    const encoded = route?.polyline?.encodedPolyline;

    if (!encoded) return null;

    return {
      path: decode(encoded, 5).map(([lat, lng]) => ({ lat, lng })),
      distanceMeters: route?.distanceMeters ?? 0,
      durationSeconds: route?.duration ? Number.parseFloat(route.duration) : undefined,
      steps: (route?.legs ?? []).flatMap((leg) => (leg.steps ?? []).map((s) => this.toStep(s))),
      legs: (route?.legs ?? []).map((leg) => ({
        distanceMeters: leg.distanceMeters ?? 0,
        // Google trả `"1234s"` chứ không phải số — `parseFloat` bỏ được hậu tố `s`.
        durationSeconds: leg.duration ? Number.parseFloat(leg.duration) : 0,
      })),
      source: {
        provider: MapProvider.Google,
        label: `Google Routes · ${TRAVEL_MODE_LABEL[mode]}`,
        travelMode: mode,
        profile: TRAVEL_MODE[mode],
      },
    };
  }

  private toStep(step: GoogleStep): RouteStep {
    const loc = step.startLocation?.latLng;

    /*
     * Google nhét NHIỀU DÒNG vào `instructions`, ngăn bằng `\n`:
     *
     *   "Rẽ phải tại Quán Bia Hơi Hà Nội vào Đ. Nguyễn Văn Cừ
     *    Đi qua Kelly Fruits (ở phía bên phải)"
     *
     * Dòng đầu là thao tác phải làm, các dòng sau là mốc nhận biết dọc đường.
     * Băng chỉ dẫn của màn dẫn đường chỉ có một hàng chữ to; ném cả cụm vào đó
     * là bị cắt cụt ngay giữa câu quan trọng nhất. Nên tách: dòng đầu làm câu
     * chỉ dẫn, phần còn lại đẩy xuống `roadName` (chỗ hiển thị phụ).
     */
    const lines = (step.navigationInstruction?.instructions ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    return {
      // Google trả sẵn câu chỉ dẫn đã dịch theo `languageCode` — đỡ phải tự dựng
      // như bên OSRM.
      instruction: lines[0] ?? '',
      roadName: lines.slice(1).join(' · '),
      distanceMeters: step.distanceMeters ?? 0,
      durationSeconds: step.staticDuration ? Number.parseFloat(step.staticDuration) : 0,
      location: { lat: loc?.latitude ?? 0, lng: loc?.longitude ?? 0 },
      maneuver: step.navigationInstruction?.maneuver ?? '',
    };
  }
}

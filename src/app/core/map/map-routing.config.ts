import { EnvironmentProviders, InjectionToken, makeEnvironmentProviders } from '@angular/core';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { MapProvider, TravelMode } from './map.types';

/**
 * Cấu hình runtime của tính năng bản đồ.
 * Gom vào 1 InjectionToken để test/override dễ, thay vì rải biến môi trường
 * khắp nơi như bản Vue (`helpers/configs.ts` + `.env.production`).
 */
export interface MapRoutingConfig {
  /** Provider dùng khi người dùng chưa chọn gì. */
  defaultProvider: MapProvider;

  /** `maps.viettel.vn` */
  vtmapDomain: string;
  /** `v4.0.0` — đổi version là đổi luôn URL script + css của SDK. */
  vtmapVersion: string;
  /** Access token Viettel Map. Rỗng -> nhánh VTMAP sẽ báo "chưa cấu hình". */
  vtmapKey: string;

  /** API key Google — dùng cho cả JS SDK lẫn Routes API v2. */
  googleMapsKey: string;
  /** Map ID (bắt buộc khi dùng `<map-advanced-marker>`). */
  googleMapId: string;

  /**
   * Gốc của mọi dịch vụ OSRM (`/route`, `/nearest`, `/table`, `/match`, `/trip`).
   * KHÔNG kèm `/route/v1` — phần đó do từng service tự nối vào.
   */
  osrmHost: string;

  /**
   * Endpoint OSRM. Mặc định là server demo công cộng — KHÔNG có SLA,
   * production phải self-host hoặc dùng dịch vụ trả phí.
   */
  osrmBaseUrl: string;

  /**
   * ====== GIỚI HẠN THẬT CỦA `router.project-osrm.org` (đã đo, 09/2026) ======
   *
   * Không phải con số phỏng đoán — đo bằng cách gọi thẳng vào server rồi
   * nhị phân tìm ngưỡng. Đây là các ràng buộc phải thiết kế quanh nó:
   *
   * | Dịch vụ    | Giới hạn đo được | Lỗi khi vượt                     |
   * |------------|------------------|----------------------------------|
   * | `/match`   | **10 điểm**      | 400 `{"code":"TooBig"}`          |
   * | `/table`   | >= 25 điểm (mặc định OSRM là 100) | 400 `TooBig`    |
   * | `/route`   | >= 60 điểm       | 414 URI Too Long trước khi tới đây |
   *
   * `/match` chỉ nhận 10 điểm là con số RẤT nhỏ so với một GPS track thật
   * (hàng trăm điểm) — nên `OsrmMatchService` phải cắt track thành nhiều cửa sổ
   * chồng mép rồi khâu lại. Self-host thì chỉnh `--max-matching-size` là hết.
   */
  osrmMaxMatchPoints: number;
  osrmMaxTablePoints: number;
  /** Giãn cách giữa 2 request liên tiếp khi khớp đường theo lô (ms). */
  osrmThrottleMs: number;
  /**
   * Endpoint OSRM riêng cho từng phương tiện.
   *
   * VÌ SAO CẦN: một server OSRM chỉ được biên dịch với MỘT profile Lua duy nhất
   * (car / foot / bicycle). Đoạn `driving` trong URL của OSRM **không có tác
   * dụng chọn phương tiện** — server bỏ qua nó hoàn toàn. Muốn có lộ trình đi bộ
   * / xe đạp thật thì phải trỏ sang một instance khác.
   *
   * `router.project-osrm.org` chỉ có profile ô tô; FOSSGIS chạy sẵn 3 instance
   * tại `routing.openstreetmap.de/routed-{car,foot,bike}`.
   */
  osrmProfileBaseUrl: Partial<Record<TravelMode, string>>;
  /** Nominatim — geocode/reverse geocode miễn phí, rate-limit 1 req/s. */
  nominatimBaseUrl: string;
  /**
   * Photon (Komoot) — geocoder DỰ PHÒNG, cũng chạy trên dữ liệu OpenStreetMap.
   *
   * VÌ SAO CẦN DỰ PHÒNG: `nominatim.openstreetmap.org` bị chặn ở khá nhiều mạng
   * doanh nghiệp / nhà mạng VN (đo tại chỗ: tên miền phân giải được nhưng TCP
   * 443 không mở, trong khi `openstreetmap.org` gốc vẫn vào bình thường).
   * Không có dự phòng thì ô tìm địa chỉ chết câm mà không rõ lý do.
   *
   * Photon còn hợp với autocomplete hơn Nominatim: nó được xây riêng cho
   * gõ-tới-đâu-gợi-ý-tới-đó, không có luật 1 request/giây.
   */
  photonBaseUrl: string;

  /** Giới hạn điểm gửi vào RoadDrawerControl — tránh HTTP 414 URI Too Long. */
  maxPointsForDrawer: number;

  /**
   * Số **waypoint nghiệp vụ** tối đa gửi trong MỘT request định tuyến.
   *
   * ⚠️ ĐỪNG NHẦM VỚI `maxPointsForDrawer`. Hai con số này trông giống nhau nhưng
   * xử lý ngược nhau khi vượt ngưỡng:
   *  - `maxPointsForDrawer` áp cho HÌNH HỌC (GPS track dày đặc): vượt thì **lấy
   *    mẫu thưa**, bỏ bớt điểm — chấp nhận được vì bỏ một điểm GPS giữa đường
   *    không làm sai lộ trình.
   *  - `maxWaypointsPerRequest` áp cho ĐIỂM DỪNG (kho, khách hàng): vượt thì
   *    **cắt thành nhiều request nối đuôi**, TUYỆT ĐỐI không bỏ điểm. Bỏ một
   *    khách hàng ra khỏi tuyến rồi vẫn vẽ một đường trông hợp lệ là lỗi nghiệp
   *    vụ nặng nhất mà lớp bản đồ có thể gây ra — không ai nhìn bản đồ mà phát
   *    hiện ra được.
   *
   * Nguồn của hai con số mặc định:
   *  - `google: 27` = 25 `intermediates` (hạn mức tài khoản thường) + origin + destination.
   *  - `osrm: 60`   = ngưỡng đo được trước khi `router.project-osrm.org` trả
   *    `414 URI Too Long` (toạ độ nằm trong query string).
   */
  maxWaypointsPerRequest: { google: number; osrm: number };
  /** Giới hạn marker DOM hiển thị — quá nhiều marker làm treo trình duyệt. */
  maxMarkers: number;
  /** Ngưỡng coi 2 điểm GPS liên tiếp là trùng nhau (độ, ~0.00001 ≈ 1m). */
  dedupeEpsilon: number;
  /** GPS cách lộ trình dự kiến quá ngưỡng này (mét) -> tính là LỆCH TUYẾN. */
  deviationThresholdMeters: number;

  // ------------------------------------------------- ngưỡng nghiệp vụ vận tải

  /** Bán kính coi là "đã tới nơi" quanh mỗi điểm giao (mét). */
  geofenceRadiusMeters: number;
  /** Vượt quá tốc độ này thì sinh cảnh báo (km/h). */
  overspeedKmh: number;
  /** Đứng yên (< `idleSpeedKmh`) lâu hơn ngần này phút -> cảnh báo dừng đỗ. */
  idleMinutes: number;
  /** Dưới tốc độ này coi như xe không di chuyển (km/h). */
  idleSpeedKmh: number;
  /** Tốc độ vượt ngưỡng này là nhiễu GPS chứ không phải xe chạy (km/h). */
  maxPlausibleSpeedKmh: number;
}

export const MAP_ROUTING_CONFIG = new InjectionToken<MapRoutingConfig>('MAP_ROUTING_CONFIG');

export const DEFAULT_MAP_ROUTING_CONFIG: MapRoutingConfig = {
  defaultProvider: MapProvider.OpenStreet,

  vtmapDomain: 'maps.viettel.vn',
  vtmapVersion: 'v4.0.0',
  vtmapKey: '',

  googleMapsKey: '',
  googleMapId: 'DEMO_MAP_ID',

  osrmHost: 'https://router.project-osrm.org',
  osrmBaseUrl: 'https://router.project-osrm.org/route/v1',
  osrmMaxMatchPoints: 10,
  osrmMaxTablePoints: 25,
  osrmThrottleMs: 120,
  osrmProfileBaseUrl: {
    walking: 'https://routing.openstreetmap.de/routed-foot/route/v1',
    cycling: 'https://routing.openstreetmap.de/routed-bike/route/v1',
  },
  nominatimBaseUrl: 'https://nominatim.openstreetmap.org',
  photonBaseUrl: 'https://photon.komoot.io',

  maxPointsForDrawer: 400,
  maxWaypointsPerRequest: { google: 27, osrm: 60 },
  maxMarkers: 400,
  dedupeEpsilon: 0.00001,
  deviationThresholdMeters: 120,

  geofenceRadiusMeters: 150,
  overspeedKmh: 60,
  idleMinutes: 12,
  idleSpeedKmh: 3,
  maxPlausibleSpeedKmh: 130,
};

/**
 * Đăng ký ở `app.config.ts`:
 *
 * ```ts
 * export const appConfig: ApplicationConfig = {
 *   providers: [
 *     provideMapRouting({ vtmapKey: environment.vtmapKey }),
 *   ],
 * };
 * ```
 */
export function provideMapRouting(config: Partial<MapRoutingConfig> = {}): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideHttpClient(withFetch()),
    {
      provide: MAP_ROUTING_CONFIG,
      useValue: { ...DEFAULT_MAP_ROUTING_CONFIG, ...config },
    },
  ]);
}

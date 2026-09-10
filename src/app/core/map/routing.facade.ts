import { Injectable, inject } from '@angular/core';
import { GoogleRoutesService } from './google/google-routes.service';
import { GoogleMatrixService } from './google/google-matrix.service';
import { MapProviderService } from './map-provider.service';
import { MAP_ROUTING_CONFIG } from './map-routing.config';
import { LatLng, MapProvider, RouteResult, TravelMode } from './map.types';
import { RoutingError, TRAVEL_MODE_LABEL } from './routing.error';
import { MANDATED_SOURCE, MANDATE_REASON, detourNote, judgeDetour } from './routing-capability';
import { OsrmRoutingService } from './osm/osrm-routing.service';
import { CostMatrix, OsrmMatrixService } from './osm/osrm-matrix.service';
import { OsrmNearestService, SnapResult } from './osm/osrm-nearest.service';
import { MatchOptions, MatchResult, OsrmMatchService } from './osm/osrm-match.service';

export interface RoutingRequest {
  /**
   * ĐIỂM DỪNG NGHIỆP VỤ theo đúng thứ tự đi qua (kho -> khách -> ... -> kho).
   *
   * KHÔNG truyền GPS track thô vào đây: facade cam kết giữ nguyên 100% số điểm,
   * nên một track 2000 điểm sẽ thành 80 request. Track thô thì dùng
   * `matchTrack()` (map matching), đó mới là hàm dành cho hình học dày.
   */
  points: readonly LatLng[];
  travelMode?: TravelMode;
  /** Lấy kèm chỉ dẫn rẽ từng chặng. */
  withSteps?: boolean;
  /** Xin thêm phương án đi đường khác (chỉ có tác dụng với tuyến 2 điểm). */
  alternatives?: boolean;
  /**
   * Tính theo tình trạng giao thông hiện tại (chỉ Google, chỉ ô tô/xe máy).
   *
   * ĐÂY KHÔNG PHẢI CÔNG TẮC CHỈ ĐỔI SỐ PHÚT — nó đổi luôn cả ĐƯỜNG ĐI. Đo thật
   * trên chặng Ngọc Lâm -> Bà Triệu:
   *   - tắt : 6.792 m / 20 phút  (qua cầu Chương Dương, đúng đường ai cũng đi)
   *   - bật : 10.787 m / 25 phút (né Chương Dương, vòng cầu khác — **dài thêm 59%**)
   *
   * Nên mặc định TẮT: màn lập kế hoạch và báo cáo chi phí cần quãng đường ổn
   * định, gọi lại lúc khác vẫn ra cùng con số. Màn dẫn đường thì bật lên để ETA
   * bám thực tế — chấp nhận đường đi thay đổi theo giờ.
   */
  trafficAware?: boolean;
}

/**
 * Cửa duy nhất mà tầng nghiệp vụ gọi để lấy đường đi.
 * Màn hình KHÔNG được gọi thẳng `OsrmRoutingService` / `GoogleRoutesService` —
 * làm vậy là hard-code provider vào nghiệp vụ.
 *
 * BẢNG PHÂN NHÁNH:
 * | Provider | Dịch vụ định tuyến      | Cần key | Có turn-by-turn |
 * |----------|-------------------------|---------|-----------------|
 * | OSMAP    | OSRM (`/route/v1`)      | Không   | Có (tự dịch)    |
 * | GMAP     | Google Routes API v2    | Có      | Có (Google dịch)|
 * | VTMAP    | `RoadDrawerControl`     | Có      | Không           |
 *
 * VÌ SAO VTMAP LẠI RƠI VỀ OSRM Ở ĐÂY:
 * SDK Viettel không có hàm định tuyến trả JSON — nó chỉ có `RoadDrawerControl`,
 * một *map control* vẽ thẳng lên bản đồ và thông báo kết quả bằng cách ghi text
 * vào DOM (xem `ViettelRouteService`). Nghĩa là không có cách nào lấy được danh
 * sách chặng/thời gian ở tầng service thuần. Do đó:
 *  - phần ĐƯỜNG VẼ khi chọn VTMAP do chính `RoadDrawerControl` đảm nhiệm
 *    (truyền qua input `routingPoints` của `dms-map-surface`),
 *  - phần SỐ LIỆU (km, thời gian, chỉ dẫn rẽ) mà màn hình cần thì lấy từ OSRM.
 */
@Injectable({ providedIn: 'root' })
export class RoutingFacade {
  private readonly osrm = inject(OsrmRoutingService);
  private readonly google = inject(GoogleRoutesService);
  private readonly matrixService = inject(OsrmMatrixService);
  private readonly googleMatrix = inject(GoogleMatrixService);
  private readonly nearest = inject(OsrmNearestService);
  private readonly matcher = inject(OsrmMatchService);
  private readonly mapProvider = inject(MapProviderService);
  private readonly config = inject(MAP_ROUTING_CONFIG);

  /** Provider hiện tại có tự vẽ đường lấy không (chỉ Viettel). */
  readonly providerDrawsOwnRoute = () => this.mapProvider.provider() === MapProvider.Viettel;

  async computeRoute(request: RoutingRequest): Promise<RouteResult> {
    const routes = await this.computeRoutes(request);
    return routes[0];
  }

  /**
   * Tuyến chính + các phương án thay thế, xếp theo thứ tự provider trả về.
   *
   * BA CAM KẾT của hàm này:
   *  1. **Không bao giờ bỏ waypoint.** `request.points` là ĐIỂM DỪNG NGHIỆP VỤ
   *     (kho, khách hàng), không phải hình học. Vượt hạn mức provider thì cắt
   *     thành nhiều request nối đuôi, không lấy mẫu thưa.
   *  2. **Không bao giờ trả tuyến giả.** Không tìm được đường thì ném
   *     `RoutingError`, để màn hình hiện lỗi thay vì hiện `0 m / 0 phút`.
   *  3. **Luôn gắn `source`** — người xem biết km/phút trước mắt do ai tính,
   *     bằng hồ sơ phương tiện nào.
   */
  async computeRoutes(request: RoutingRequest): Promise<RouteResult[]> {
    const points = request.points;
    const mode = request.travelMode ?? 'driving';

    if (points.length < 2) {
      return [{ path: [...points], distanceMeters: 0, durationSeconds: 0, steps: [] }];
    }

    const limit = this.waypointLimit(mode);

    // Tuyến dài hơn hạn mức: cắt khúc, KHÔNG lấy mẫu thưa. Phương án thay thế
    // mất nghĩa khi ghép nhiều khúc nên chỉ trả về một tuyến.
    if (points.length > limit) {
      return [await this.computeChunked(points, request, limit)];
    }

    return this.requestRoutes(points, request, mode);
  }

  /**
   * Một lần gọi provider, kèm CHÍNH SÁCH CHỌN NGUỒN.
   *
   * Ba tầng, theo đúng thứ tự (khớp với README — đừng sửa một bên mà quên bên kia):
   *
   *  1. **ÉP NGUỒN THEO PHƯƠNG TIỆN.** Có phương tiện mà một nguồn đơn giản là
   *     không có dữ liệu ở Việt Nam. Với những trường hợp ĐÃ ĐO ĐƯỢC bằng chứng
   *     (xem `routing-capability.ts`) thì đi thẳng sang nguồn có dữ liệu, không
   *     chờ nguồn kia hỏng — vì nó KHÔNG hỏng, nó trả HTTP 200 kèm số liệu sai.
   *     Đây là bài học đắt nhất của module này: tầng dự phòng ở mục 2 dưới đây
   *     chỉ cứu được lỗi *ồn ào*, hoàn toàn bất lực trước lỗi *im lặng*.
   *
   *  2. **DỰ PHÒNG KHI HỎNG.** Đang chọn Google mà Google ném lỗi -> thử lại
   *     bằng OSRM với đúng hồ sơ phương tiện. Không có chiều ngược lại: đang
   *     chọn OSM mà nhảy sang Google sẽ tiêu quota của người dùng ngoài ý muốn.
   *
   *  3. **ĐỐI CHIẾU KHI SỐ LIỆU ĐÁNG NGỜ.** Tuyến vòng gấp hơn 3 lần đường chim
   *     bay -> gọi nguồn còn lại, giữ tuyến ngắn hơn. Đây là lưới an toàn cho
   *     những khoảng trống dữ liệu CHƯA biết, xem `judgeDetour`.
   *
   * Xuyên suốt: không bao giờ hạ xuống đường chim bay, và luôn ghi lại nguồn
   * thật vào `source` để UI nói đúng ai đã tính ra con số đang hiện.
   */
  private async requestRoutes(
    points: readonly LatLng[],
    request: RoutingRequest,
    mode: TravelMode,
  ): Promise<RouteResult[]> {
    // --- Tầng 1: phương tiện này có bị ép nguồn không?
    const mandated = MANDATED_SOURCE[mode];
    if (this.useGoogle() && mandated === 'osrm') {
      const results = await this.osrm.computeRoutes(points, {
        travelMode: mode,
        withSteps: request.withSteps,
        alternatives: request.alternatives,
      });
      return results.map((r) => this.tag(r, { switched: true, note: MANDATE_REASON[mode] }));
    }

    if (!this.useGoogle()) {
      return this.verifyDetour(
        await this.osrm.computeRoutes(points, {
          travelMode: mode,
          withSteps: request.withSteps,
          alternatives: request.alternatives,
        }),
        points,
        request,
        mode,
      );
    }

    try {
      const results = await this.google.computeRoutes(points, {
        travelMode: mode,
        withSteps: request.withSteps,
        computeAlternativeRoutes: request.alternatives,
        routingPreference: request.trafficAware ? 'TRAFFIC_AWARE' : 'TRAFFIC_UNAWARE',
      });
      return this.verifyDetour(results, points, request, mode);
    } catch (googleError) {
      const reason =
        googleError instanceof RoutingError
          ? googleError.message
          : `Google Routes gặp lỗi: ${(googleError as Error)?.message ?? 'không rõ'}`;

      let results: RouteResult[];
      try {
        results = await this.osrm.computeRoutes(points, {
          travelMode: mode,
          withSteps: request.withSteps,
          alternatives: request.alternatives,
        });
      } catch (osrmError) {
        /*
         * Cả hai nguồn cùng hỏng. Ném ra lỗi kể ĐỦ CẢ HAI VẾ.
         *
         * Nếu chỉ để lỗi của OSRM lọt lên, người dùng đọc được câu vô nghĩa kiểu
         * "Http failure response ... 0 Unknown Error" và không biết rằng thật ra
         * nguyên nhân gốc là Google không phục vụ phương tiện đó ở Việt Nam.
         */
        const osrmReason =
          osrmError instanceof RoutingError
            ? osrmError.message
            : `không kết nối được máy chủ OSRM (${TRAVEL_MODE_LABEL[mode].toLowerCase()})`;

        throw new RoutingError(
          'NO_ROUTE',
          `Không tính được lộ trình ${TRAVEL_MODE_LABEL[mode].toLowerCase()}. ${reason} Nguồn dự phòng cũng không dùng được: ${osrmReason}.`,
          mode,
          'Google Routes + OSRM',
        );
      }

      // Ghi rõ ĐÃ chuyển nguồn: con số km/phút giờ do OSRM tính, không phải Google.
      return results.map((r) =>
        this.tag(r, {
          switched: true,
          label: `${r.source?.label ?? 'OSRM'} (dự phòng cho Google)`,
          note: reason,
        }),
      );
    }
  }

  /**
   * Tầng 3 của chính sách: tuyến có vòng tới mức phi lý không?
   *
   * VÌ SAO KHÔNG ÁP DỤNG CHO MỌI TRƯỜNG HỢP MÀ CHỈ ĐỐI CHIẾU KHI VƯỢT NGƯỠNG:
   * gọi cả hai nguồn cho mọi tuyến là nhân đôi độ trễ và nhân đôi hoá đơn
   * Google. Ngưỡng 3,0 đủ cao để đường vòng thật (cù lao, vùng một cây cầu)
   * không kích hoạt — xem bảng số đo trong `routing-capability.ts`.
   *
   * Chỉ xét tuyến CHÍNH (`results[0]`): các phương án thay thế theo định nghĩa
   * là những đường dài hơn, đem so với đường chim bay là sai đối tượng.
   *
   * Nguồn đối chiếu hỏng -> **giữ nguyên kết quả gốc**, chỉ ghi chú. Một con số
   * đáng ngờ vẫn hơn không có gì, miễn là nói rõ nó đáng ngờ.
   */
  private async verifyDetour(
    results: RouteResult[],
    points: readonly LatLng[],
    request: RoutingRequest,
    mode: TravelMode,
  ): Promise<RouteResult[]> {
    const primary = results[0];
    if (!primary) return results;

    const verdict = judgeDetour(primary, points);
    if (!verdict.implausible) {
      return results.map((r, i) => (i === 0 ? this.tag(r, { detourRatio: verdict.ratio }) : r));
    }

    const usedGoogle = primary.source?.provider === MapProvider.Google;
    const label = primary.source?.label ?? 'Nguồn định tuyến';

    try {
      const rival = usedGoogle
        ? await this.osrm.computeRoutes(points, { travelMode: mode, withSteps: request.withSteps })
        : await this.google.computeRoutes(points, {
            travelMode: mode,
            withSteps: request.withSteps,
            routingPreference: request.trafficAware ? 'TRAFFIC_AWARE' : 'TRAFFIC_UNAWARE',
          });

      const challenger = rival[0];
      if (challenger && challenger.distanceMeters < primary.distanceMeters) {
        const better = judgeDetour(challenger, points);
        return [
          this.tag(challenger, {
            switched: true,
            detourRatio: better.ratio,
            note: detourNote(verdict, label),
          }),
        ];
      }
    } catch {
      // Nguồn đối chiếu không dùng được — không phải lý do để bỏ tuyến đang có.
    }

    return results.map((r, i) =>
      i === 0
        ? this.tag(r, {
            detourRatio: verdict.ratio,
            note: `Tuyến này dài gấp ${verdict.ratio.toFixed(1)} lần đường chim bay — kiểm tra lại trước khi giao cho tài xế.`,
          })
        : r,
    );
  }

  /** Ghi thêm metadata vào `source` mà không đè mất ghi chú đã có. */
  private tag(
    route: RouteResult,
    patch: { switched?: boolean; label?: string; note?: string; detourRatio?: number },
  ): RouteResult {
    if (!route.source) return route;
    return {
      ...route,
      source: {
        ...route.source,
        label: patch.label ?? route.source.label,
        switched: patch.switched ?? route.source.switched,
        detourRatio: patch.detourRatio ?? route.source.detourRatio,
        note: [patch.note, route.source.note].filter(Boolean).join(' ') || undefined,
      },
    };
  }

  /**
   * Tuyến vượt hạn mức waypoint của provider -> cắt thành nhiều khúc **chồng
   * mép** rồi khâu lại.
   *
   * Chồng mép nghĩa là khúc sau bắt đầu đúng tại điểm cuối của khúc trước. Nhờ
   * vậy:
   *  - không điểm dừng nào bị bỏ,
   *  - thứ tự giữ nguyên,
   *  - tổng số `legs` vẫn đúng bằng `points.length - 1`, nên ETA từng điểm giao
   *    tính ra vẫn khớp.
   *
   * Cái mất: đoạn nối giữa hai khúc bị ép đi qua đúng điểm chia, nên tổng quãng
   * đường có thể nhỉnh hơn tuyến tối ưu toàn cục vài chục mét. Đổi lại là không
   * mất khách hàng nào — đánh đổi đúng chiều.
   */
  private async computeChunked(
    points: readonly LatLng[],
    request: RoutingRequest,
    limit: number,
  ): Promise<RouteResult> {
    const mode = request.travelMode ?? 'driving';
    const chunks: LatLng[][] = [];

    for (let start = 0; start < points.length - 1;) {
      const end = Math.min(start + limit - 1, points.length - 1);
      chunks.push(points.slice(start, end + 1));
      start = end;
    }

    const parts: RouteResult[] = [];
    for (const chunk of chunks) {
      // Tuần tự chứ không `Promise.all`: cả OSRM công cộng lẫn Routes API đều
      // rate-limit, bắn song song là dính 429 rồi hỏng cả tuyến.
      parts.push((await this.requestRoutes(chunk, { ...request, alternatives: false }, mode))[0]);
    }

    const merged: RouteResult = {
      path: [],
      distanceMeters: 0,
      durationSeconds: 0,
      steps: request.withSteps ? [] : undefined,
      legs: [],
    };

    parts.forEach((part, i) => {
      // Bỏ điểm đầu của khúc sau: nó trùng điểm cuối khúc trước.
      merged.path.push(...(i === 0 ? part.path : part.path.slice(1)));
      merged.distanceMeters += part.distanceMeters;
      merged.durationSeconds = (merged.durationSeconds ?? 0) + (part.durationSeconds ?? 0);
      if (merged.steps && part.steps) merged.steps.push(...part.steps);
      merged.legs!.push(...(part.legs ?? []));
    });

    const base = parts[0]?.source;
    merged.source = base && {
      ...base,
      requestCount: chunks.length,
      note: [
        base.note,
        `Tuyến ${points.length} điểm vượt hạn mức ${limit} điểm/request — đã ghép ${chunks.length} lần gọi, giữ nguyên toàn bộ điểm dừng.`,
      ]
        .filter(Boolean)
        .join(' '),
    };

    return merged;
  }

  /**
   * Hạn mức waypoint nghiệp vụ cho MỘT request, theo NGUỒN THẬT SẼ ĐƯỢC GỌI.
   *
   * Phải xét cả việc ép nguồn: tuyến đi bộ 40 điểm đi thẳng sang OSRM (hạn mức
   * 60) thì chỉ cần 1 request. Lấy nhầm hạn mức 27 của Google sẽ cắt thành 2
   * khúc vô ích — chậm gấp đôi và ép tuyến đi qua đúng điểm chia.
   */
  private waypointLimit(mode: TravelMode): number {
    const { google, osrm } = this.config.maxWaypointsPerRequest;
    return this.useGoogle() && MANDATED_SOURCE[mode] !== 'osrm' ? google : osrm;
  }

  // ------------------------------------------------- nhóm hàm về ĐỘ CHÍNH XÁC

  /**
   * Bám một điểm vào tim đường gần nhất.
   *
   * CHỈ CÓ NHÁNH OSRM. Google có Roads API (`snapToRoads`) làm đúng việc này
   * nhưng đó là **sản phẩm tính tiền riêng**, không nằm trong Routes/Geocoding —
   * bật lên là phát sinh hoá đơn ngoài dự tính. Viettel không công bố dịch vụ
   * tương đương. Nên dù đang chọn provider nào, phần bám đường vẫn nhờ OSRM:
   * mạng đường OSM ở Việt Nam đủ đầy đủ cho việc canh một điểm vào mép phố.
   */
  snap(point: LatLng, radiusMeters?: number): Promise<SnapResult> {
    return this.nearest.snap(point, radiusMeters);
  }

  snapMany(points: readonly LatLng[], radiusMeters?: number): Promise<SnapResult[]> {
    return this.nearest.snapMany(points, radiusMeters);
  }

  /**
   * Ma trận quãng đường/thời gian THẬT giữa mọi cặp điểm — nền tảng của tối ưu tuyến.
   *
   * Có nhánh Google vì đây là dữ liệu quyết định chất lượng phương án chia tuyến:
   * ở mạng chặn `router.project-osrm.org` (rất phổ biến trong doanh nghiệp VN),
   * nếu chỉ có một nguồn thì màn lập kế hoạch âm thầm tụt xuống ước lượng chim
   * bay và ra phương án sai 15–30% quãng đường mà không ai biết.
   */
  matrix(points: readonly LatLng[]): Promise<CostMatrix> {
    return this.useGoogle()
      ? this.googleMatrix.getMatrix(points)
      : this.matrixService.getMatrix(points);
  }

  /** Khớp GPS thô vào mạng đường (map matching) — xem `OsrmMatchService`. */
  matchTrack(points: readonly LatLng[], options?: MatchOptions): Promise<MatchResult> {
    return this.matcher.matchTrack(points, options);
  }

  private useGoogle(): boolean {
    return this.mapProvider.provider() === MapProvider.Google && !!this.config.googleMapsKey;
  }
}

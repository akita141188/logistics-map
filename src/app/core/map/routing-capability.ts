import { LatLng, RouteResult, TravelMode } from './map.types';
import { distanceMeters } from './geo.util';

/**
 * ============ NGUỒN NÀO ĐỦ DỮ LIỆU CHO PHƯƠNG TIỆN NÀO (tại Việt Nam) ============
 *
 * File này tồn tại vì một lỗi đã lọt qua toàn bộ test lẫn review: màn chỉ đường
 * báo tuyến ĐI BỘ từ Ngọc Lâm sang Bà Triệu dài **21.741 m / 4 giờ 57 phút**,
 * trong khi đường chim bay chỉ 4,4 km. Không có gì "hỏng" cả — Google trả về
 * HTTP 200 kèm một tuyến hoàn toàn hợp lệ, nên mọi lớp bắt lỗi đều im lặng.
 *
 * ĐÃ ĐO TẬN NƠI (10/09, cùng một cặp toạ độ 21.0447,105.8752 -> 21.0126,105.8489):
 *
 * | Nguồn                        | Ô tô     | Xe máy   | Xe đạp      | Đi bộ      |
 * |------------------------------|----------|----------|-------------|------------|
 * | Google Routes v2             | 6.792 m¹ | 6.196 m  | `routes:[]` | 21.741 m ✗ |
 * | Google Directions (API cũ)   | 6.791 m  | —        | ZERO_RESULTS| 21.742 m ✗ |
 * | OSRM `routed-car`            | 6.462 m  | 6.462 m² | —           | —          |
 * | OSRM `routed-bike`           | —        | —        | 6.748 m ✓   | —          |
 * | OSRM `routed-foot`           | —        | —        | —           | 6.573 m ✓  |
 *
 * ¹ với `TRAFFIC_UNAWARE`. Bật `TRAFFIC_AWARE` thì thành 10.787 m — xem
 *   `RoutingRequest.trafficAware`.
 * ² hồ sơ ô tô, không phải hồ sơ xe máy — xem `OsrmRoutingService.sourceOf`.
 *
 * VÌ SAO GOOGLE ĐI BỘ RA 21 KM — đã xin `legs.steps` để đọc từng bước:
 * nó đi 9,2 km xuống ĐT378 rồi **qua phà Kim Lan - Lĩnh Nam**. Tức là đồ thị đi
 * bộ của Google **không có lối vượt sông Hồng nào ở nội thành Hà Nội**: cầu
 * Chương Dương cấm người đi bộ (đúng thực tế), nhưng cầu Long Biên — nơi người
 * đi bộ vẫn qua hằng ngày — cũng không có trong đồ thị đó.
 * Kiểm chứng thêm: ép một waypoint lên giữa cầu Long Biên thì tuyến **dài thêm**
 * (28.713 m) chứ không đi qua cầu — Google đi tới chân cầu rồi vòng lại xuống phà.
 * OSRM `routed-foot`/`routed-bike` đi thẳng **cầu Long Biên (1.850 m)** -> 6,5 km.
 *
 * KẾT LUẬN: đây là KHOẢNG TRỐNG DỮ LIỆU của Google ở Việt Nam, không phải lỗi
 * tham số. Không có tham số nào sửa được (`avoidFerries` bị API từ chối thẳng:
 * *"avoid_ferries only applies to DRIVE and TWO_WHEELER travel modes"*).
 * Cách duy nhất đúng là **đổi nguồn theo phương tiện**, không phải đổi tham số.
 */

/** Nguồn định tuyến ở mức trừu tượng — không phải `MapProvider` (đó là bản đồ nền). */
export type RoutingSourceId = 'google' | 'osrm';

/**
 * Nguồn BẮT BUỘC cho một phương tiện, bất kể người dùng đang chọn bản đồ nào.
 *
 * `undefined` = không ép, dùng nguồn theo provider đang chọn.
 *
 * Chỉ ép khi có bằng chứng đo được rằng nguồn kia trả về số liệu SAI (chứ không
 * phải chỉ khác vài phần trăm). Ép nguồn là đánh đổi: người dùng chọn bản đồ
 * Google nhưng km lại do OSM tính — nên UI phải nói rõ, xem `mandateReason`.
 */
export const MANDATED_SOURCE: Partial<Record<TravelMode, RoutingSourceId>> = {
  // Google: 21.741 m qua phà, vs OSM 6.573 m qua cầu Long Biên. Sai 3,3 lần.
  walking: 'osrm',
  // Google không phủ dữ liệu xe đạp ở VN: `routes: []` / `ZERO_RESULTS`.
  cycling: 'osrm',
};

export const MANDATE_REASON: Partial<Record<TravelMode, string>> = {
  walking:
    'Google không có lối đi bộ vượt sông Hồng ở Hà Nội (nó vòng 9 km xuống phà Kim Lan), nên tuyến đi bộ luôn tính bằng OSRM routed-foot.',
  cycling:
    'Google Routes không phục vụ xe đạp tại Việt Nam (trả về danh sách tuyến rỗng), nên tuyến xe đạp luôn tính bằng OSRM routed-bike.',
};

/**
 * ================== CHỐT CHẶN "ĐƯỜNG VÒNG VÔ LÝ" ==================
 *
 * Bảng trên chỉ vá được những khoảng trống ĐÃ BIẾT. Chốt chặn này để bắt những
 * khoảng trống CHƯA BIẾT — dữ liệu bản đồ thay đổi liên tục, và kiểu lỗi này
 * không bao giờ tự lộ ra: nó trả HTTP 200, vẽ lên bản đồ một đường liền mạch
 * rất thuyết phục, chỉ có con số km là sai gấp mấy lần.
 *
 * Cách đo: `hệ số vòng = quãng đường thật / tổng đường chim bay giữa các điểm`.
 * Đây là chặn dưới tuyệt đối — không tuyến nào ngắn hơn đường chim bay được.
 *
 * NGƯỠNG lấy từ số đo thật ở trên, không phải bịa:
 * (đường chim bay của cặp toạ độ trên = 4.493 m)
 *  - đi bộ qua cầu Long Biên  : 6.573 / 4.493 = **1,46**
 *  - xe đạp qua cầu Long Biên : 6.748 / 4.493 = **1,50**
 *  - ô tô qua cầu Chương Dương: 6.792 / 4.493 = **1,51**
 *  - ô tô vòng tránh tắc      : 10.787 / 4.493 = **2,40**  <- vẫn phải chấp nhận
 *  - đi bộ qua phà (SAI)      : 21.741 / 4.493 = **4,84**  <- phải bắt được
 *
 * Chọn 3,0: cao hơn hẳn mọi tuyến đúng đo được (tối đa 2,40) và thấp hơn hẳn
 * tuyến sai (4,84). Đặt sát 2,5 sẽ báo động nhầm ở địa hình thật có đường vòng
 * lớn (cù lao, đường ven núi, khu vực chỉ có một cây cầu).
 *
 * ⚠️ VÀ ĐÂY LÀ GIỚI HẠN THẬT CỦA CHỐT CHẶN NÀY — phải nói thẳng:
 * trên tuyến 3 điểm của màn chỉ đường (kho -> Bà Triệu -> Cầu Giấy), Google WALK
 * ra **30.033 m / chim bay 10.352 m = 2,90** — tức là **LỌT** ngưỡng 3,0 trong
 * gang tấc, dù vẫn là chính tuyến đi phà sai bét. Lý do: càng nhiều điểm dừng,
 * phần đường vòng sai càng bị pha loãng trong tổng quãng đường.
 *
 * Cho nên đừng bao giờ coi hệ số vòng là tuyến phòng thủ chính. Nó là LƯỚI
 * CUỐI, chỉ để bắt những khoảng trống dữ liệu chưa ai biết. Tuyến phòng thủ
 * chính là bảng `MANDATED_SOURCE` ở trên — thứ được xây từ bằng chứng đo đạc
 * cho từng phương tiện cụ thể. Hạ ngưỡng xuống 2,5 để "bắt cho bằng được" ca
 * này sẽ đánh đổi bằng báo động nhầm ở tuyến ô tô tránh tắc (đo được 2,40) —
 * lợi bất cập hại.
 */
export const IMPLAUSIBLE_DETOUR_RATIO = 3;

/**
 * Dưới ngưỡng này thì không xét — tuyến vài trăm mét trong khu phố cổ có hệ số
 * vòng rất cao một cách bình thường (đường một chiều, phố đi bộ), xét vào là
 * báo động nhầm liên tục.
 */
export const MIN_DISTANCE_FOR_DETOUR_CHECK_METERS = 1000;

/** Tổng đường chim bay dọc theo thứ tự điểm dừng — chặn dưới của mọi lộ trình. */
export function crowFlyMeters(points: readonly LatLng[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distanceMeters(points[i - 1], points[i]);
  return total;
}

export interface DetourVerdict {
  /** Quãng đường thật / đường chim bay. `Infinity` khi các điểm trùng nhau. */
  ratio: number;
  crowFlyMeters: number;
  /** `true` khi con số đáng ngờ tới mức nên đối chiếu nguồn khác. */
  implausible: boolean;
}

/**
 * Tuyến này có vòng vèo tới mức phi lý không?
 *
 * KHÔNG tự ý sửa kết quả — chỉ đưa ra nhận định. Quyết định làm gì tiếp
 * (đối chiếu nguồn khác, cảnh báo, hay bỏ qua) là việc của `RoutingFacade`.
 */
export function judgeDetour(route: RouteResult, points: readonly LatLng[]): DetourVerdict {
  const crow = crowFlyMeters(points);
  const ratio = crow > 0 ? route.distanceMeters / crow : Infinity;

  return {
    ratio,
    crowFlyMeters: crow,
    implausible: crow >= MIN_DISTANCE_FOR_DETOUR_CHECK_METERS && ratio > IMPLAUSIBLE_DETOUR_RATIO,
  };
}

/** Câu cảnh báo cho UI khi phải đổi nguồn vì tuyến gốc quá vòng. */
export function detourNote(rejected: DetourVerdict, rejectedLabel: string): string {
  return (
    `${rejectedLabel} trả về tuyến dài gấp ${rejected.ratio.toFixed(1)} lần đường chim bay ` +
    `(ngưỡng ${IMPLAUSIBLE_DETOUR_RATIO}) — nghi thiếu dữ liệu, đã đối chiếu nguồn khác.`
  );
}

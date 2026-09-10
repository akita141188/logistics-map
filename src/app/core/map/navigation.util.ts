import { distanceMeters, interpolate, bearingDegrees } from './geo.util';
import { LatLng, RouteLeg, RouteStep } from './map.types';

/**
 * ============ LÕI DẪN ĐƯỜNG THEO VỊ TRÍ (turn-by-turn) ============
 *
 * Khác hẳn "vẽ một đường lên bản đồ": ở đây tuyến đã có sẵn, việc phải làm là
 * mỗi khi nhận một bản ghi GPS thì trả lời bốn câu:
 *
 *   1. Xe đang ở ĐOẠN NÀO của tuyến?           -> `projectOnPath()`
 *   2. Còn bao nhiêu mét tới chỗ rẽ kế tiếp?    -> `guidanceAt()`
 *   3. Xe có còn bám tuyến không?               -> `updateOffRoute()`
 *   4. Bao giờ tới điểm giao kế tiếp?           -> `etaSeconds()`
 *
 * Toàn bộ là HÀM THUẦN TUÝ: không service, không HTTP, không DOM. Đây là chỗ
 * duy nhất chứa logic dẫn đường, nên nó phải test được bằng số học thuần.
 *
 * VÌ SAO KHÔNG DÙNG THẲNG CHỈ SỐ MẢNG GPS (`track[i]`) NHƯ MÀN TUA LẠI:
 * Dẫn đường là bài toán "vị trí thật của tôi nằm ở đâu TRÊN TUYẾN", mà vị trí
 * thật gần như không bao giờ trùng đúng một đỉnh polyline. Phải chiếu vuông góc
 * xuống tuyến (map-matching hình học) rồi làm việc theo QUÃNG ĐƯỜNG DỌC TUYẾN
 * (`alongMeters`). Làm theo chỉ số đỉnh thì mỗi lần polyline dày/thưa khác nhau
 * là mọi con số km còn lại nhảy loạn.
 */

/** Vị trí đã được chiếu vuông góc xuống tuyến. */
export interface PathProjection {
  /** Chỉ số đỉnh bắt đầu của đoạn chứa hình chiếu. */
  index: number;
  /** Toạ độ hình chiếu — đây mới là điểm nên vẽ marker xe, không phải toạ độ GPS thô. */
  snapped: LatLng;
  /** Khoảng cách từ GPS thô tới tuyến (mét) — chính là "độ lệch tuyến" tức thời. */
  lateralMeters: number;
  /** Quãng đường đã đi DỌC THEO tuyến, tính từ điểm xuất phát (mét). */
  alongMeters: number;
}

interface SegmentProjection {
  point: LatLng;
  /** Tỉ lệ vị trí trên đoạn (0 = đầu đoạn, 1 = cuối đoạn). */
  t: number;
  distanceMeters: number;
}

/**
 * Chiếu một điểm xuống ĐOẠN THẲNG a-b.
 *
 * Quy đổi kinh độ theo `cos(lat)` trước khi coi như mặt phẳng: ở vĩ độ 21° (Hà
 * Nội) một độ kinh tuyến chỉ dài bằng ~0,93 độ vĩ tuyến. Bỏ qua bước này thì
 * hình chiếu bị kéo lệch về phía đông/tây vài mét — đủ để một xe đi đúng đường
 * bị hệ thống chấm là lệch tuyến.
 */
export function projectOnSegment(p: LatLng, a: LatLng, b: LatLng): SegmentProjection {
  const scale = Math.cos((p.lat * Math.PI) / 180);
  const ax = a.lng * scale;
  const bx = b.lng * scale;
  const px = p.lng * scale;

  const dx = bx - ax;
  const dy = b.lat - a.lat;

  if (dx === 0 && dy === 0) {
    return { point: { ...a }, t: 0, distanceMeters: distanceMeters(p, a) };
  }

  const t = Math.min(Math.max(((px - ax) * dx + (p.lat - a.lat) * dy) / (dx * dx + dy * dy), 0), 1);
  const point = interpolate(a, b, t);

  return { point, t, distanceMeters: distanceMeters(p, point) };
}

/**
 * Quãng đường tích luỹ tới từng đỉnh của polyline.
 * Tính một lần rồi truyền lại cho các hàm khác — tuyến một chuyến giao hàng có
 * thể vài nghìn đỉnh, mà dẫn đường thì mỗi giây gọi lại một lần.
 */
export function cumulativeAlong(path: readonly LatLng[]): number[] {
  const out = new Array<number>(path.length);
  out[0] = 0;
  for (let i = 1; i < path.length; i++) {
    out[i] = out[i - 1] + distanceMeters(path[i - 1], path[i]);
  }
  return out;
}

/**
 * Chiếu vị trí GPS xuống toàn tuyến.
 *
 * @param searchFromIndex bắt đầu quét từ đỉnh này. Dẫn đường thật LUÔN nên
 *   truyền vị trí lần trước vào: vừa nhanh hơn, vừa tránh cái bẫy kinh điển —
 *   tuyến đi qua cùng một con phố hai lần (đi và về) thì chiếu toàn cục sẽ nhảy
 *   sang nhánh về, làm "quãng đường còn lại" tụt đột ngột vài km.
 */
export function projectOnPath(
  point: LatLng,
  path: readonly LatLng[],
  cumulative?: readonly number[],
  searchFromIndex = 0,
): PathProjection {
  if (path.length === 0) {
    return { index: 0, snapped: { ...point }, lateralMeters: 0, alongMeters: 0 };
  }
  if (path.length === 1) {
    return {
      index: 0,
      snapped: { ...path[0] },
      lateralMeters: distanceMeters(point, path[0]),
      alongMeters: 0,
    };
  }

  const cum = cumulative ?? cumulativeAlong(path);
  const start = Math.min(Math.max(searchFromIndex, 0), path.length - 2);

  let best: PathProjection = {
    index: start,
    snapped: { ...path[start] },
    lateralMeters: Number.POSITIVE_INFINITY,
    alongMeters: cum[start],
  };

  for (let i = start; i < path.length - 1; i++) {
    const seg = projectOnSegment(point, path[i], path[i + 1]);
    if (seg.distanceMeters < best.lateralMeters) {
      const segLength = cum[i + 1] - cum[i];
      best = {
        index: i,
        snapped: seg.point,
        lateralMeters: seg.distanceMeters,
        alongMeters: cum[i] + segLength * seg.t,
      };
    }
  }

  return best;
}

/** Toạ độ tại mốc `alongMeters` dọc tuyến — dùng để mô phỏng xe chạy. */
export function pointAtAlong(
  path: readonly LatLng[],
  alongMeters: number,
  cumulative?: readonly number[],
): LatLng {
  if (!path.length) return { lat: 0, lng: 0 };
  if (path.length === 1) return { ...path[0] };

  const cum = cumulative ?? cumulativeAlong(path);
  const total = cum[cum.length - 1];
  const target = Math.min(Math.max(alongMeters, 0), total);

  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= target) lo = mid;
    else hi = mid;
  }

  const segLength = cum[hi] - cum[lo];
  const t = segLength === 0 ? 0 : (target - cum[lo]) / segLength;
  return interpolate(path[lo], path[hi], t);
}

/**
 * Cắt một KHÚC hình học của tuyến theo QUÃNG ĐƯỜNG dọc tuyến (mét).
 *
 * VÌ SAO KHÔNG CẮT THEO CHỈ SỐ ĐỈNH (`path.slice(0, index + 1)`):
 * Đó là cách hiển nhiên nhất và cũng là nguồn của cả một họ lỗi vẽ đường ở màn
 * dẫn đường. `projectOnPath` trả về chỉ số ĐOẠN chứa hình chiếu, mà chỉ số đó
 * phụ thuộc vào mồi tìm kiếm và vào nhiễu GPS:
 *
 *  - Một bản ghi nhiễu là hình chiếu tụt về đoạn trước -> điểm cắt nhảy lùi ->
 *    phần đường xanh phía trước "co giật" mỗi nhịp.
 *  - Mồi còn sót của tuyến CŨ bị kẹp vào `path.length - 2` của tuyến MỚI ->
 *    điểm cắt nhảy thẳng tới cuối tuyến -> cả tuyến bị tô màu "đã đi", đường
 *    xanh biến mất.
 *  - Polyline dày/thưa khác nhau giữa hai nhà cung cấp -> cùng một vị trí thật
 *    cho ra hai chỉ số rất khác nhau, nhìn như vẽ sai.
 *
 * Cắt theo mét thì điểm cắt là một con số DUY NHẤT, đơn điệu, không phụ thuộc
 * mật độ đỉnh; hai đầu khúc được nội suy đúng vị trí nên đường liền mạch không
 * hở, không chồng.
 *
 * @returns mảng rỗng nếu khúc không có độ dài (không phải mảng 1 điểm — người
 *   gọi chỉ cần kiểm tra `length > 1` là đủ để biết có gì để vẽ).
 */
export function slicePathByDistance(
  path: readonly LatLng[],
  cumulative: readonly number[] | undefined,
  fromMeters: number,
  toMeters: number,
): LatLng[] {
  if (path.length < 2) return [];

  const cum = cumulative ?? cumulativeAlong(path);
  const total = cum[cum.length - 1];

  const from = Math.min(Math.max(fromMeters, 0), total);
  const to = Math.min(Math.max(toMeters, 0), total);
  if (to - from <= 0) return [];

  const out: LatLng[] = [pointAtAlong(path, from, cum)];

  for (let i = 0; i < path.length; i++) {
    if (cum[i] <= from) continue;
    if (cum[i] >= to) break;
    out.push(path[i]);
  }

  out.push(pointAtAlong(path, to, cum));
  return out;
}

/** Hướng mũi xe tại mốc `alongMeters` (độ, 0 = Bắc) — để xoay icon xe. */
export function bearingAtAlong(
  path: readonly LatLng[],
  alongMeters: number,
  cumulative?: readonly number[],
): number {
  if (path.length < 2) return 0;
  const here = pointAtAlong(path, alongMeters, cumulative);
  const ahead = pointAtAlong(path, alongMeters + 25, cumulative);
  return distanceMeters(here, ahead) < 1 ? 0 : bearingDegrees(here, ahead);
}

// ------------------------------------------------------------ CHỈ DẪN RẼ

/** Một chỉ dẫn rẽ kèm mốc quãng đường của nó trên tuyến. */
export interface StepOffset {
  step: RouteStep;
  /** Mét tính từ đầu tuyến tới lúc BẮT ĐẦU chặng này. */
  startMeters: number;
  /** Mét tới lúc kết thúc chặng — cũng chính là vị trí phải thực hiện thao tác rẽ. */
  endMeters: number;
}

/**
 * Gắn mốc quãng đường cho từng chỉ dẫn.
 *
 * BẪY: `step.distanceMeters` của OSRM là độ dài chặng "đi hết đoạn này rồi mới
 * rẽ", còn `step.location` lại là toạ độ ở ĐẦU chặng. Nên khoảng cách tới lần
 * rẽ tiếp theo phải đo tới `endMeters` của chặng đang chạy, không phải tới
 * `location` của chặng đó — nhầm chỗ này là màn hình đếm ngược về 0 ngay lúc
 * vừa bắt đầu chặng.
 */
export function stepOffsets(steps: readonly RouteStep[]): StepOffset[] {
  const out: StepOffset[] = [];
  let acc = 0;
  for (const step of steps) {
    const start = acc;
    acc += Math.max(step.distanceMeters, 0);
    out.push({ step, startMeters: start, endMeters: acc });
  }
  return out;
}

/** Nội dung băng chỉ dẫn hiển thị trên đầu màn hình dẫn đường. */
export interface Guidance {
  stepIndex: number;
  /** Câu chỉ dẫn của thao tác SẮP TỚI (không phải thao tác vừa làm xong). */
  instruction: string;
  roadName: string;
  maneuver: string;
  modifier?: string;
  /** Còn bao nhiêu mét nữa thì tới chỗ rẽ. */
  distanceToManeuverMeters: number;
  /** Câu chỉ dẫn liền sau — hiện mờ ở dòng dưới để tài xế biết trước. */
  nextInstruction: string;
  /** Đang trong ngưỡng "chuẩn bị rẽ" (< 150 m) — dùng để làm nổi băng chỉ dẫn. */
  imminent: boolean;
}

const IMMINENT_METERS = 150;

/**
 * Chỉ dẫn tại mốc `alongMeters`.
 *
 * Trả về thao tác của chặng ĐANG chạy: đang ở giữa chặng "đi thẳng 800 m rồi rẽ
 * phải vào Trần Duy Hưng" thì băng chỉ dẫn phải hiện "Rẽ phải vào Trần Duy Hưng"
 * kèm số mét còn lại — chứ không phải hiện "đi thẳng".
 */
export function guidanceAt(offsets: readonly StepOffset[], alongMeters: number): Guidance | null {
  if (!offsets.length) return null;

  let index = offsets.findIndex((o) => alongMeters < o.endMeters);
  if (index === -1) index = offsets.length - 1;

  const current = offsets[index];
  // Thao tác cần làm ở CUỐI chặng đang chạy chính là maneuver của chặng kế tiếp.
  const target = offsets[index + 1]?.step ?? current.step;
  const following = offsets[index + 2]?.step;
  const distance = Math.max(current.endMeters - alongMeters, 0);

  return {
    stepIndex: index,
    instruction: target.instruction,
    roadName: target.roadName || current.step.roadName,
    maneuver: target.maneuver,
    modifier: target.modifier,
    distanceToManeuverMeters: distance,
    nextInstruction: following?.instruction ?? '',
    imminent: distance <= IMMINENT_METERS,
  };
}

/**
 * Ký hiệu mũi tên cho từng loại thao tác.
 *
 * PHẢI HIỂU HAI BỘ MÃ KHÁC NHAU, vì hai nhà cung cấp mô tả cùng một cú rẽ theo
 * hai cách hoàn toàn khác:
 *  - OSRM   : `type` = 'turn' + `modifier` = 'right'  (hai trường)
 *  - Google : `maneuver` = 'TURN_RIGHT', không có modifier (một trường)
 *
 * Chỉ xử lý một bộ thì đổi nhà cung cấp là mọi chỉ dẫn rẽ trái/phải hiện thành
 * mũi tên đi thẳng — sai lệch nguy hiểm mà nhìn thoáng qua vẫn thấy "có icon".
 */
export function maneuverIcon(maneuver: string, modifier?: string): string {
  const google = GOOGLE_MANEUVER_ICON[maneuver];
  if (google) return google;

  if (maneuver === 'arrive') return '🏁';
  if (maneuver === 'depart') return '🚩';
  if (maneuver === 'roundabout' || maneuver === 'rotary') return '🔄';

  switch (modifier) {
    case 'left':
      return '⬅️';
    case 'right':
      return '➡️';
    case 'sharp left':
      return '↰';
    case 'sharp right':
      return '↱';
    case 'slight left':
      return '↖️';
    case 'slight right':
      return '↗️';
    case 'uturn':
      return '↩️';
    default:
      return '⬆️';
  }
}

/** Mã maneuver của Google Routes API v2 (`navigationInstruction.maneuver`). */
const GOOGLE_MANEUVER_ICON: Record<string, string> = {
  DEPART: '🚩',
  DESTINATION: '🏁',
  DESTINATION_LEFT: '🏁',
  DESTINATION_RIGHT: '🏁',
  TURN_LEFT: '⬅️',
  TURN_RIGHT: '➡️',
  TURN_SLIGHT_LEFT: '↖️',
  TURN_SLIGHT_RIGHT: '↗️',
  TURN_SHARP_LEFT: '↰',
  TURN_SHARP_RIGHT: '↱',
  TURN_U_TURN_LEFT: '↩️',
  TURN_U_TURN_RIGHT: '↪️',
  UTURN_LEFT: '↩️',
  UTURN_RIGHT: '↪️',
  ROUNDABOUT_LEFT: '🔄',
  ROUNDABOUT_RIGHT: '🔄',
  MERGE: '🔀',
  FORK_LEFT: '↖️',
  FORK_RIGHT: '↗️',
  RAMP_LEFT: '↖️',
  RAMP_RIGHT: '↗️',
  STRAIGHT: '⬆️',
  NAME_CHANGE: '⬆️',
  FERRY: '⛴️',
  FERRY_TRAIN: '🚆',
};

// ------------------------------------------------------------ CHẶNG & ETA

/**
 * Mốc quãng đường của từng waypoint (điểm giao) trên tuyến.
 * `boundaries[i]` = mét từ đầu tuyến tới waypoint thứ `i`; phần tử đầu luôn là 0.
 */
export function legBoundaries(legs: readonly RouteLeg[]): number[] {
  const out = [0];
  let acc = 0;
  for (const leg of legs) {
    acc += Math.max(leg.distanceMeters, 0);
    out.push(acc);
  }
  return out;
}

/**
 * Waypoint kế tiếp mà xe đang hướng tới (chỉ số trong mảng waypoint gốc).
 * Trả về `boundaries.length - 1` khi đã đi hết tuyến.
 */
export function activeLegIndex(boundaries: readonly number[], alongMeters: number): number {
  for (let i = 1; i < boundaries.length; i++) {
    if (alongMeters < boundaries[i]) return i;
  }
  return boundaries.length - 1;
}

/**
 * Thời gian còn lại tới đích (giây).
 *
 * Không lấy `route.durationSeconds` trừ dần theo tỉ lệ quãng đường phẳng: đoạn
 * cao tốc và đoạn phố cổ có cùng số km nhưng khác nhau ba lần về thời gian.
 * Ở đây quy đổi theo tốc độ TRUNG BÌNH THỰC TẾ của xe khi đã có đủ mẫu, chỉ khi
 * chưa chạy đủ thì mới rơi về tốc độ trung bình của tuyến do máy chủ định tuyến
 * ước lượng.
 *
 * @param stopsAhead số điểm giao còn phải ghé — mỗi điểm cộng thêm thời gian
 *   đứng giao hàng. Bỏ qua khoản này là hứa với khách một giờ không bao giờ đúng.
 */
export function etaSeconds(params: {
  remainingMeters: number;
  routeMeters: number;
  routeSeconds: number;
  observedSpeedMps?: number;
  stopsAhead?: number;
  serviceSecondsPerStop?: number;
}): number {
  const {
    remainingMeters,
    routeMeters,
    routeSeconds,
    observedSpeedMps,
    stopsAhead = 0,
    serviceSecondsPerStop = 0,
  } = params;

  const plannedSpeed = routeMeters > 0 && routeSeconds > 0 ? routeMeters / routeSeconds : 0;
  const speed = observedSpeedMps && observedSpeedMps > 0.5 ? observedSpeedMps : plannedSpeed;

  const driving = speed > 0 ? remainingMeters / speed : 0;
  return Math.round(driving + stopsAhead * serviceSecondsPerStop);
}

/** Cộng `seconds` vào một mốc thời gian ISO, trả về ISO. */
export function addSeconds(iso: string, seconds: number): string {
  const base = new Date(iso);
  if (Number.isNaN(base.getTime())) return iso;
  return new Date(base.getTime() + seconds * 1000).toISOString();
}

// ------------------------------------------------------- PHÁT HIỆN LỆCH TUYẾN

export interface OffRouteOptions {
  /** Xa tuyến hơn ngần này mét thì tính là một lần nghi ngờ (mét). */
  thresholdMeters: number;
  /** Phải nghi ngờ liên tiếp đủ ngần này bản ghi mới dám kết luận là đi sai. */
  confirmFixes: number;
  /** Về gần hơn ngần này mét thì coi như đã bám lại tuyến (mét). */
  clearMeters: number;
}

export const DEFAULT_OFF_ROUTE_OPTIONS: OffRouteOptions = {
  thresholdMeters: 60,
  confirmFixes: 3,
  clearMeters: 30,
};

export interface OffRouteState {
  /** Số bản ghi liên tiếp đang nằm ngoài ngưỡng. */
  consecutive: number;
  /** Đã kết luận là đi sai đường. */
  offRoute: boolean;
  /** Độ lệch của bản ghi gần nhất (mét). */
  lastLateralMeters: number;
  /** Vừa mới chuyển từ "đang bám tuyến" sang "đi sai" ở bản ghi này -> nên định tuyến lại. */
  justTriggered: boolean;
}

export const INITIAL_OFF_ROUTE_STATE: OffRouteState = {
  consecutive: 0,
  offRoute: false,
  lastLateralMeters: 0,
  justTriggered: false,
};

/**
 * Cập nhật trạng thái lệch tuyến theo một bản ghi GPS mới.
 *
 * VÌ SAO PHẢI ĐẾM LIÊN TIẾP CHỨ KHÔNG SO MỘT LẦN:
 * GPS đô thị hay bắn lệch một nhịp rồi về lại (phản xạ tín hiệu ở toà nhà cao).
 * Định tuyến lại ngay ở bản ghi đầu tiên là màn hình cứ vài chục giây lại đổi
 * tuyến một lần, tài xế mất tin tưởng và server định tuyến lãnh đủ số request.
 *
 * VÌ SAO NGƯỠNG THOÁT (`clearMeters`) NHỎ HƠN NGƯỠNG VÀO (`thresholdMeters`):
 * Đây là trễ Schmitt. Để hai ngưỡng bằng nhau thì một xe chạy dập dềnh đúng
 * quanh mốc 60 m sẽ bật/tắt cảnh báo liên tục.
 */
export function updateOffRoute(
  state: OffRouteState,
  lateralMeters: number,
  options: OffRouteOptions = DEFAULT_OFF_ROUTE_OPTIONS,
): OffRouteState {
  if (lateralMeters <= options.clearMeters) {
    return {
      consecutive: 0,
      offRoute: false,
      lastLateralMeters: lateralMeters,
      justTriggered: false,
    };
  }

  if (lateralMeters <= options.thresholdMeters) {
    // Vùng xám: không tính thêm lần nghi ngờ, nhưng cũng chưa xoá kết luận cũ.
    return { ...state, lastLateralMeters: lateralMeters, justTriggered: false };
  }

  const consecutive = state.consecutive + 1;
  const offRoute = consecutive >= options.confirmFixes;

  return {
    consecutive,
    offRoute,
    lastLateralMeters: lateralMeters,
    justTriggered: offRoute && !state.offRoute,
  };
}

import { LatLng, RoutePoint } from './map.types';
import { distanceMeters } from './geo.util';

/**
 * ============ LÀM SẠCH & ĐÁNH GIÁ CHẤT LƯỢNG DỮ LIỆU GPS ============
 *
 * Trước khi vẽ hay tính bất cứ con số nào từ GPS tài xế, phải qua bước này.
 * Toàn bộ là hàm thuần tuý -> unit-test được, không cần mạng, không cần DOM.
 *
 * BA LOẠI RÁC LUÔN CÓ TRONG DỮ LIỆU GPS THẬT:
 *
 *  1. **Điểm nhảy cóc (teleport)**: mất tín hiệu trong hầm/nhà cao tầng rồi bắt
 *     lại, thiết bị bắn ra một toạ độ cách vài km. Tính vào quãng đường là cộng
 *     oan mấy km mỗi lần.
 *  2. **Nhiễu khi đứng yên (jitter)**: xe đỗ giao hàng 20 phút, thiết bị vẫn bắn
 *     log, toạ độ lang thang trong bán kính 10–20 m. Cộng dồn thành hàng trăm
 *     mét "đã đi" trong lúc xe không hề nhúc nhích.
 *  3. **Khoảng trống (gap)**: app bị kill, hết pin, mất sóng — track đứt một
 *     đoạn dài. Nối thẳng hai đầu là vẽ ra một đường xuyên qua sông.
 *
 * Không xử lý ba thứ này thì mọi KPI phía sau (km thực tế, tốc độ trung bình,
 * lệch tuyến) đều sai, và sai theo hướng luôn LỚN HƠN sự thật.
 */

export interface CleanOptions {
  /** Nhanh hơn mức này là nhiễu, không phải xe chạy (km/h). */
  maxSpeedKmh: number;
  /** Hai điểm gần nhau hơn ngần này mét thì coi là một (mét). */
  minSpacingMeters: number;
  /** Cách nhau lâu hơn ngần này giây thì tính là ĐỨT track (giây). */
  gapSeconds: number;
}

export const DEFAULT_CLEAN_OPTIONS: CleanOptions = {
  maxSpeedKmh: 130,
  minSpacingMeters: 8,
  gapSeconds: 15 * 60,
};

export interface TrackGap {
  /** Chỉ số điểm ngay trước chỗ đứt (trong mảng ĐÃ LÀM SẠCH). */
  index: number;
  fromIso: string;
  toIso: string;
  minutes: number;
  meters: number;
}

export interface CleanResult {
  points: RoutePoint[];
  /** Số điểm bị loại vì nhảy cóc phi vật lý. */
  removedOutliers: number;
  /** Số điểm bị gộp vì quá sát nhau (xe đứng yên vẫn bắn log). */
  removedJitter: number;
  /** Các chỗ track bị đứt — màn hình nên vẽ nét đứt chứ đừng nối liền. */
  gaps: TrackGap[];
}

/**
 * Làm sạch chuỗi điểm GPS.
 *
 * QUAN TRỌNG — vì sao lọc theo TỐC ĐỘ chứ không theo khoảng cách:
 * Hai điểm cách nhau 3 km là bình thường nếu chúng cách nhau 4 phút (45 km/h),
 * nhưng là rác nếu chúng cách nhau 5 giây (2160 km/h). Chỉ có tốc độ mới phân
 * biệt được "xe chạy nhanh trên cao tốc" với "thiết bị bắn toạ độ rác".
 */
export function cleanTrack(
  input: readonly RoutePoint[],
  options: Partial<CleanOptions> = {},
): CleanResult {
  const opt = { ...DEFAULT_CLEAN_OPTIONS, ...options };

  if (input.length < 2) {
    return { points: [...input], removedOutliers: 0, removedJitter: 0, gaps: [] };
  }

  const maxSpeedMs = (opt.maxSpeedKmh * 1000) / 3600;

  const points: RoutePoint[] = [input[0]];
  let removedOutliers = 0;
  let removedJitter = 0;

  for (let i = 1; i < input.length; i++) {
    const prev = points[points.length - 1];
    const cur = input[i];

    const meters = distanceMeters(prev, cur);
    const seconds = secondsBetween(prev, cur);

    // Nhảy cóc: chỉ kết luận khi CÓ mốc thời gian hợp lệ. Thiếu timestamp thì
    // không có cơ sở tính tốc độ -> giữ điểm lại, thà thừa còn hơn xoá nhầm.
    if (seconds > 0 && meters / seconds > maxSpeedMs) {
      removedOutliers++;
      continue;
    }

    // Nhiễu khi đứng yên: gộp vào điểm trước. KHÔNG xoá hẳn thông tin thời gian —
    // điểm sau sẽ mang mốc thời gian mới nhất, nhờ vậy phần "phát hiện dừng đỗ"
    // vẫn biết xe đã đứng ở đây bao lâu.
    if (meters < opt.minSpacingMeters) {
      removedJitter++;
      continue;
    }

    points.push(cur);
  }

  return { points, removedOutliers, removedJitter, gaps: findGaps(points, opt.gapSeconds) };
}

/** Tìm các chỗ track bị đứt quãng thời gian. */
export function findGaps(points: readonly RoutePoint[], gapSeconds: number): TrackGap[] {
  const gaps: TrackGap[] = [];

  for (let i = 1; i < points.length; i++) {
    const seconds = secondsBetween(points[i - 1], points[i]);
    if (seconds <= gapSeconds) continue;

    gaps.push({
      index: i - 1,
      fromIso: timeOf(points[i - 1]) ?? '',
      toIso: timeOf(points[i]) ?? '',
      minutes: Math.round(seconds / 60),
      meters: Math.round(distanceMeters(points[i - 1], points[i])),
    });
  }

  return gaps;
}

// ------------------------------------------------------------------ tốc độ

/**
 * Tính tốc độ từng điểm TỪ TOẠ ĐỘ + THỜI GIAN, không tin số `speedKmh` thiết bị gửi.
 *
 * Lý do: trường tốc độ của thiết bị là tốc độ tức thời tại đúng khoảnh khắc lấy
 * mẫu — xe dừng đèn đỏ đúng lúc bắn log thì báo 0 km/h dù cả phút vừa rồi chạy
 * 40 km/h. Muốn KPI "tốc độ trung bình đoạn" đúng thì phải tính từ quãng
 * đường / thời gian giữa hai điểm.
 */
export function speedProfileKmh(points: readonly RoutePoint[]): number[] {
  const speeds: number[] = new Array(points.length).fill(0);

  for (let i = 1; i < points.length; i++) {
    const seconds = secondsBetween(points[i - 1], points[i]);
    if (seconds <= 0) {
      speeds[i] = speeds[i - 1];
      continue;
    }
    speeds[i] = (distanceMeters(points[i - 1], points[i]) / seconds) * 3.6;
  }

  // Điểm đầu không có điểm trước để so -> mượn tốc độ của điểm thứ hai.
  if (points.length > 1) speeds[0] = speeds[1];

  return speeds;
}

// -------------------------------------------------------------- dừng đỗ

export interface StopEvent {
  /** Chỉ số điểm bắt đầu / kết thúc trong mảng track. */
  fromIndex: number;
  toIndex: number;
  center: LatLng;
  startIso: string;
  endIso: string;
  minutes: number;
  /** Bán kính vùng xe loanh quanh trong lúc dừng (mét). */
  radiusMeters: number;
}

export interface DetectStopOptions {
  /** Dưới tốc độ này coi như không di chuyển (km/h). */
  idleSpeedKmh: number;
  /** Đứng lâu hơn ngần này phút mới tính là một lần dừng. */
  minMinutes: number;
  /** Loanh quanh trong bán kính này vẫn coi là đứng một chỗ (mét). */
  radiusMeters: number;
}

export const DEFAULT_STOP_OPTIONS: DetectStopOptions = {
  idleSpeedKmh: 3,
  minMinutes: 5,
  radiusMeters: 60,
};

/**
 * ============ PHÁT HIỆN ĐIỂM DỪNG ============
 *
 * Đây là dữ liệu mà mọi hệ thống giám sát vận tải đều phải có: xe đã dừng ở đâu,
 * lúc mấy giờ, bao lâu. Từ đó mới đối chiếu được:
 *
 *  - Dừng ở đúng điểm giao hàng -> thời gian giao thực tế bao lâu.
 *  - Dừng ở chỗ KHÔNG có điểm giao nào -> tài xế ghé việc riêng, cần giải trình.
 *  - Dừng quá lâu -> hỏng xe, kẹt xe, hoặc bỏ ca.
 *
 * THUẬT TOÁN (dạng cửa sổ trượt theo cụm không gian - thời gian):
 * duyệt tuần tự, gom các điểm liên tiếp nằm trong `radiusMeters` quanh tâm cụm
 * hiện tại. Khi có điểm ra khỏi bán kính thì đóng cụm; cụm nào kéo dài quá
 * `minMinutes` thì tính là một lần dừng.
 *
 * VÌ SAO KHÔNG CHỈ DỰA VÀO `speed == 0`: nhiễu GPS khi đứng yên vẫn tạo ra
 * chuyển dịch vài mét mỗi lần lấy mẫu, tính ra 2–5 km/h liên tục. Lọc theo tốc
 * độ đơn thuần sẽ chia một lần dừng 30 phút thành hàng chục mẩu vụn.
 */
export function detectStops(
  points: readonly RoutePoint[],
  options: Partial<DetectStopOptions> = {},
): StopEvent[] {
  const opt = { ...DEFAULT_STOP_OPTIONS, ...options };
  if (points.length < 2) return [];

  const stops: StopEvent[] = [];

  let anchorIndex = 0;

  for (let i = 1; i <= points.length; i++) {
    const outOfCluster =
      i === points.length || distanceMeters(points[anchorIndex], points[i]) > opt.radiusMeters;

    if (!outOfCluster) continue;

    const lastIndex = i - 1;
    if (lastIndex > anchorIndex) {
      const minutes = secondsBetween(points[anchorIndex], points[lastIndex]) / 60;

      if (minutes >= opt.minMinutes) {
        const cluster = points.slice(anchorIndex, lastIndex + 1);
        const center = centroid(cluster);

        stops.push({
          fromIndex: anchorIndex,
          toIndex: lastIndex,
          center,
          startIso: timeOf(points[anchorIndex]) ?? '',
          endIso: timeOf(points[lastIndex]) ?? '',
          minutes: Math.round(minutes),
          radiusMeters: Math.round(
            cluster.reduce((max, p) => Math.max(max, distanceMeters(center, p)), 0),
          ),
        });
      }
    }

    anchorIndex = i;
  }

  return stops;
}

/** Tâm hình học của một cụm điểm (trung bình cộng — đủ chính xác ở phạm vi vài chục mét). */
export function centroid(points: readonly LatLng[]): LatLng {
  if (!points.length) return { lat: 0, lng: 0 };

  const sum = points.reduce(
    (acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }),
    { lat: 0, lng: 0 },
  );

  return { lat: sum.lat / points.length, lng: sum.lng / points.length };
}

// ------------------------------------------------------- chất lượng tổng thể

export interface TrackQuality {
  totalPoints: number;
  /** Giãn cách lấy mẫu trung vị (giây) — dùng trung vị vì trung bình bị gap kéo lệch. */
  medianIntervalSeconds: number;
  durationMinutes: number;
  distanceMeters: number;
  gaps: number;
  removedOutliers: number;
  removedJitter: number;
}

export function summarizeTrack(raw: readonly RoutePoint[], cleaned: CleanResult): TrackQuality {
  const points = cleaned.points;

  const intervals: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const s = secondsBetween(points[i - 1], points[i]);
    if (s > 0) intervals.push(s);
  }

  let meters = 0;
  for (let i = 1; i < points.length; i++) meters += distanceMeters(points[i - 1], points[i]);

  const first = timeOf(points[0]);
  const last = timeOf(points[points.length - 1]);

  return {
    totalPoints: raw.length,
    medianIntervalSeconds: Math.round(median(intervals)),
    durationMinutes:
      first && last ? Math.round((new Date(last).getTime() - new Date(first).getTime()) / 60_000) : 0,
    distanceMeters: Math.round(meters),
    gaps: cleaned.gaps.length,
    removedOutliers: cleaned.removedOutliers,
    removedJitter: cleaned.removedJitter,
  };
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Mốc thời gian của điểm — dữ liệu thật đến từ nhiều API nên tên trường không thống nhất. */
export function timeOf(point?: RoutePoint | null): string | null {
  if (!point) return null;
  return point.createDate ?? point.createdAt ?? point.create_date ?? null;
}

/** Khoảng cách thời gian giữa 2 điểm (giây). Trả 0 khi thiếu/hỏng mốc thời gian. */
export function secondsBetween(a: RoutePoint, b: RoutePoint): number {
  const ta = timeOf(a);
  const tb = timeOf(b);
  if (!ta || !tb) return 0;

  const diff = (new Date(tb).getTime() - new Date(ta).getTime()) / 1000;
  return Number.isFinite(diff) && diff > 0 ? diff : 0;
}

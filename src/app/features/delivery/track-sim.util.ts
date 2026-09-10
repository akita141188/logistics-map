import { LatLng } from '../../core/map/map.types';
import { bearingDegrees, destinationPoint, distanceMeters } from '../../core/map/geo.util';
import { cumulativeAlong } from '../../core/map/navigation.util';

/**
 * ============ MÔ PHỎNG GPS LOG CỦA MỘT CHUYẾN GIAO HÀNG ============
 *
 * Toàn bộ file này là HÀM THUẦN: vào hình học + mốc thời gian, ra chuỗi điểm GPS.
 * Không gọi mạng, không phụ thuộc Angular, nên kiểm chứng được bằng unit test.
 *
 * VÌ SAO PHẢI NGHIÊM TÚC VỚI DỮ LIỆU GIẢ LẬP:
 * màn Giám sát lộ trình không hiển thị GPS log, nó hiển thị **kết luận rút ra từ
 * GPS log** — quá tốc độ, dừng đỗ bất thường, lệch tuyến, km thực tế, ETA. Một
 * bộ dữ liệu giả lập cẩu thả không làm màn hình "hơi kém đẹp", nó làm mọi kết
 * luận trên màn hình trở thành vô nghĩa mà vẫn trông rất thuyết phục.
 *
 * Ba nguyên tắc được giữ ở đây:
 *
 *  1. **Hình học chỉ được THÊM, không được BỚT.** Xe chạy trên đúng polyline mà
 *     dịch vụ định tuyến trả về; điểm GPS là điểm NẰM TRÊN polyline đó.
 *  2. **Thời gian phải khả thi về mặt vật lý.** Giờ tới từng điểm được SUY RA từ
 *     thời gian lăn bánh thật của dịch vụ định tuyến cộng thời gian đứng giao
 *     hàng — chứ không phải gõ tay rồi hy vọng nó khớp với quãng đường.
 *  3. **Nhiễu GPS phải TỰ TƯƠNG QUAN.** Xem `applyGpsNoise`.
 */

/** Một mẫu GPS đã mô phỏng xong phần hình học + thời gian. */
export interface SimSample {
  point: LatLng;
  timeMs: number;
  /** Tốc độ tức thời tại mẫu này (km/h) — suy từ mô hình, không phải hậu kiểm. */
  speedKmh: number;
  /** `true` khi xe đang đỗ giao hàng (dùng để gắn tốc độ 0 và mô phỏng nhiễu đứng yên). */
  parked: boolean;
}

/** Một điểm giao ĐÃ xử lý xong, đã quy về mốc quãng đường trên đường ĐÃ ĐI. */
export interface SimStopPlan {
  /** Quãng đường dọc đường đã đi tới điểm này (mét). Phải tăng dần. */
  alongMeters: number;
  /** Số giây tài xế nán lại giao hàng. */
  dwellSeconds: number;
  /** Số giây lăn bánh của chặng dẫn TỚI điểm này. */
  driveSeconds: number;
}

export interface SimulateTrackOptions {
  /** Hình học đã đi, đã làm dày. Mọi mốc `alongMeters` tính trên chính mảng này. */
  path: readonly LatLng[];
  /** Các điểm giao đã xử lý, theo thứ tự ghé thăm. */
  stops: readonly SimStopPlan[];
  /** Mốc rời kho (epoch ms). */
  departureMs: number;
  /** Số giây lăn bánh của khúc đuôi: từ điểm cuối đã xử lý tới vị trí hiện tại. */
  tailDriveSeconds: number;
  /** Khoảng cách giữa hai mẫu GPS khi xe đang đỗ (giây). */
  parkedSampleSeconds: number;
}

/**
 * Độ THẲNG của tuyến tại từng đỉnh, trong khoảng 0 (ngoặt 90° trở lên) đến 1
 * (thẳng tuyệt đối).
 *
 * VÌ SAO CẦN: nếu rải thời gian đều theo quãng đường thì xe chạy đúng một tốc độ
 * từ đầu tới cuối chuyến. Khi đó mọi cảnh báo dựa trên tốc độ đều chết lâm sàng —
 * không bao giờ có đoạn nào vượt ngưỡng, cũng không bao giờ có đoạn nào bò chậm.
 * Đó chính là tình trạng của bộ dữ liệu demo trước đây: mọi điểm đều ~8 km/h.
 *
 * ====== HAI CÁCH ĐO SAI, VÀ CÁCH ĐO ĐÚNG ======
 *
 *  - **Góc giữa hai đoạn liền kề**: polyline định tuyến đặt đỉnh rất dày ở khúc
 *    cua, nên mỗi đoạn chỉ bẻ vài độ. Đo kiểu này thì khúc ngoặt gắt nào cũng ra
 *    "thẳng tắp".
 *  - **Góc giữa hai DÂY CUNG bắc qua cửa sổ**: đỡ hơn nhưng vẫn hụt một nửa. Dây
 *    cung bắc qua một cung tròn có hướng bằng tiếp tuyến ở GIỮA cung, nên góc đo
 *    được chỉ bằng một nửa góc mà xe thật sự phải bẻ lái. Đo một cung 90° trải
 *    trên 320 m bằng cửa sổ 160 m chỉ ra 22,5° — gần như không bị phạt.
 *
 * Cách dùng ở đây: **cộng dồn trị tuyệt đối góc bẻ của từng đỉnh** nằm trong cửa
 * sổ. Tổng này không phụ thuộc mật độ đỉnh (chia một khúc cua thành 5 hay 500
 * đoạn đều cho cùng một tổng) và nó chính là lượng đánh lái mà tài xế phải thực
 * hiện quanh chỗ đó — thứ quyết định người ta đi nhanh hay chậm.
 */
export function straightnessProfile(path: readonly LatLng[], windowMeters: number): number[] {
  const n = path.length;
  if (n < 3) return new Array(Math.max(n, 0)).fill(1);

  const cum = cumulativeAlong(path);
  const half = Math.max(windowMeters / 2, 1);

  // Góc bẻ tại từng đỉnh (độ). Hai đầu mút không có góc.
  const turn: number[] = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    let delta = Math.abs(
      bearingDegrees(path[i], path[i + 1]) - bearingDegrees(path[i - 1], path[i]),
    );
    delta %= 360;
    if (delta > 180) delta = 360 - delta;
    turn[i] = delta;
  }

  // Cộng dồn để lấy tổng góc bẻ trong cửa sổ bằng một phép trừ.
  const prefix: number[] = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + turn[i];

  const out: number[] = new Array(n).fill(1);

  for (let i = 0; i < n; i++) {
    let back = i;
    while (back > 0 && cum[i] - cum[back - 1] <= half) back--;
    let fwd = i;
    while (fwd < n - 1 && cum[fwd + 1] - cum[i] <= half) fwd++;

    const total = Math.min(prefix[fwd + 1] - prefix[back], 180);
    // cos: 0° = 1 (thẳng), 90° = 0, >90° kẹp sàn về 0 (ngoặt gắt/quay đầu).
    out[i] = Math.max(0, Math.cos((total * Math.PI) / 180));
  }

  return out;
}

/** Giới hạn dưới của hệ số tốc độ — khúc cua gắt nhất vẫn phải nhúc nhích. */
const MIN_SPEED_WEIGHT = 0.18;

/**
 * Hệ số tốc độ TƯƠNG ĐỐI của từng đoạn (`path.length - 1` phần tử).
 *
 * Đây chỉ là hình dạng của biểu đồ tốc độ, chưa có đơn vị. `distributeSeconds`
 * sẽ co giãn nó để tổng thời gian khớp đúng con số mà dịch vụ định tuyến trả về —
 * nhờ vậy tốc độ vừa biến thiên hợp lý vừa không bịa ra thời gian chạy.
 */
export function segmentSpeedWeights(path: readonly LatLng[], windowMeters = 140): number[] {
  if (path.length < 2) return [];

  const straight = straightnessProfile(path, windowMeters);
  const weights: number[] = [];

  for (let i = 1; i < path.length; i++) {
    const s = (straight[i - 1] + straight[i]) / 2;
    // Mũ 1.5: phạt khúc cua nặng hơn tuyến tính, cho ra dải tốc độ giống thực tế
    // hơn (đứng ở ngã tư gần như dừng hẳn, đường thẳng dài thì bốc lên).
    weights.push(MIN_SPEED_WEIGHT + (1 - MIN_SPEED_WEIGHT) * Math.pow(s, 1.5));
  }

  return weights;
}

/**
 * Rải `totalSeconds` lên các đoạn của `path` theo hệ số tốc độ.
 *
 * @returns thời gian cộng dồn (giây) tại từng đỉnh, `[0] = 0`.
 */
export function distributeSeconds(
  path: readonly LatLng[],
  weights: readonly number[],
  totalSeconds: number,
): number[] {
  const out: number[] = [0];
  if (path.length < 2) return out;

  // Thời gian của một đoạn tỉ lệ THUẬN với chiều dài và NGHỊCH với hệ số tốc độ.
  const cost: number[] = [];
  let sum = 0;
  for (let i = 1; i < path.length; i++) {
    const w = weights[i - 1] || MIN_SPEED_WEIGHT;
    const c = distanceMeters(path[i - 1], path[i]) / w;
    cost.push(c);
    sum += c;
  }

  // Tuyến dài 0 m (mọi đỉnh trùng nhau): chia đều, tránh 0/0.
  const scale = sum > 0 ? totalSeconds / sum : totalSeconds / Math.max(1, cost.length);

  let acc = 0;
  for (const c of cost) {
    acc += sum > 0 ? c * scale : scale;
    out.push(acc);
  }

  return out;
}

/**
 * NHIỄU GPS TỰ TƯƠNG QUAN, chỉ lệch NGANG so với hướng xe chạy.
 *
 * ====== VÌ SAO KHÔNG DÙNG NHIỄU TRẮNG CỘNG THẲNG VÀO lat/lng ======
 *
 * Cách cũ (`lat + random()*0.0001`) sai ở hai điểm, và cả hai đều làm hỏng số liệu
 * chứ không chỉ làm xấu hình:
 *
 *  1. **Nhiễu trắng có thành phần DỌC đường.** Một điểm bị đẩy tới trước 10 m,
 *     điểm sau bị kéo lui 10 m — quãng đường cộng dồn và tốc độ tức thời lập tức
 *     nhảy loạn, dù xe chạy đều. Sai số dọc đường là sai số ĐƯỢC CỘNG DỒN, nên nó
 *     luôn thổi phồng số km thực tế. Nhiễu ngang thì gần như triệt tiêu khi cộng dồn.
 *  2. **Sai số GPS đời thực KHÔNG độc lập giữa các lần đo.** Nguồn sai số chính
 *     (tầng điện ly, đa đường do nhà cao tầng, hình học vệ tinh) biến thiên theo
 *     đơn vị chục giây tới vài phút. Hai lần đo cách nhau 10 giây có sai số gần
 *     như y hệt nhau. Vẽ nhiễu trắng lên polyline dày là ra một đường răng cưa —
 *     thứ không thiết bị nào bắn về.
 *
 * Ở đây: độ lệch là hàm TRƠN của quãng đường (tổng ba dao động có bước sóng không
 * chia hết cho nhau), đặt vuông góc với hướng xe. Kết quả: đường GPS là một đường
 * cong mềm men theo mặt đường, lúc lệch trái lúc lệch phải — đúng như bản ghi thật.
 */
export function applyGpsNoise(
  path: readonly LatLng[],
  amplitudeMeters: number,
  seed = 0,
): LatLng[] {
  if (path.length < 2 || amplitudeMeters <= 0) return path.map((p) => ({ ...p }));

  const cum = cumulativeAlong(path);

  return path.map((p, i) => {
    // Hướng xe tại đỉnh này. Hai đầu mút chỉ có một phía để nhìn nên lấy chính
    // đoạn liền kề; ở giữa thì lấy hướng bắc cầu qua đỉnh để đỡ giật ở khúc cua.
    const behind = path[Math.max(0, i - 1)];
    const ahead = path[Math.min(path.length - 1, i + 1)];
    const heading = bearingDegrees(behind, ahead);

    const offset = smoothNoise(cum[i], seed) * amplitudeMeters;

    // +90° = bên phải hướng đi; `offset` âm thì thành bên trái.
    return destinationPoint(p, heading + 90, offset);
  });
}

/**
 * Dao động trơn trong khoảng [-1, 1], tất định theo quãng đường.
 *
 * Ba bước sóng 173/67/31 m cố tình không chia hết cho nhau nên tổng không lặp lại
 * trong phạm vi một chuyến — trông ngẫu nhiên nhưng tái lập được y hệt sau mỗi
 * lần F5, điều kiện bắt buộc để so sánh được hai lần chạy.
 */
export function smoothNoise(alongMeters: number, seed = 0): number {
  const phase = seed * 1.37;
  return (
    0.55 * Math.sin(alongMeters / 173 + 1.7 + phase) +
    0.3 * Math.sin(alongMeters / 67 + 4.2 + phase * 2.1) +
    0.15 * Math.sin(alongMeters / 31 + 0.9 + phase * 3.3)
  );
}

/**
 * Dựng chuỗi mẫu GPS cho cả chuyến: chạy — đỗ giao hàng — chạy tiếp.
 *
 * Mốc thời gian được NEO tại từng điểm giao. Giữa hai mốc, thời gian rải theo
 * biểu đồ tốc độ (`segmentSpeedWeights`), nên xe vừa tới đúng giờ vừa không chạy
 * đều tăm tắp một tốc độ.
 */
export function simulateTrack(options: SimulateTrackOptions): SimSample[] {
  const { path, stops, departureMs, tailDriveSeconds, parkedSampleSeconds } = options;
  if (path.length < 2) return [];

  const cum = cumulativeAlong(path);
  const total = cum[cum.length - 1];
  const weights = segmentSpeedWeights(path);

  // Ranh giới các pha chạy: [0 -> stop1], [stop1 -> stop2], ..., [stopN -> hiện tại].
  const bounds: { from: number; to: number; seconds: number; dwellSeconds: number }[] = [];
  let prevAlong = 0;

  for (const stop of stops) {
    const to = Math.min(Math.max(stop.alongMeters, prevAlong), total);
    bounds.push({
      from: prevAlong,
      to,
      seconds: stop.driveSeconds,
      dwellSeconds: stop.dwellSeconds,
    });
    prevAlong = to;
  }

  if (prevAlong < total) {
    bounds.push({ from: prevAlong, to: total, seconds: tailDriveSeconds, dwellSeconds: 0 });
  }

  const samples: SimSample[] = [];
  let clockMs = departureMs;

  for (const phase of bounds) {
    // Các đỉnh nằm trong pha này. Lấy cả đỉnh mốc đầu để hai pha dính liền nhau.
    const startIdx = lowerBound(cum, phase.from);
    const endIdx = lowerBound(cum, phase.to);
    const slice = path.slice(startIdx, Math.max(endIdx + 1, startIdx + 2));

    if (slice.length >= 2) {
      const sliceWeights = weights.slice(startIdx, startIdx + slice.length - 1);
      const seconds = distributeSeconds(slice, sliceWeights, Math.max(phase.seconds, 1));

      for (let i = 0; i < slice.length; i++) {
        // Bỏ đỉnh đầu của pha sau: nó trùng đỉnh cuối của pha trước.
        if (i === 0 && samples.length) continue;

        const dt = i === 0 ? 0 : seconds[i] - seconds[i - 1];
        const meters = i === 0 ? 0 : distanceMeters(slice[i - 1], slice[i]);

        samples.push({
          point: { ...slice[i] },
          timeMs: clockMs + seconds[i] * 1000,
          speedKmh: dt > 0 ? (meters / dt) * 3.6 : 0,
          parked: false,
        });
      }

      clockMs += seconds[seconds.length - 1] * 1000;
    }

    // Xe đỗ giao hàng: thiết bị vẫn bắn log, toạ độ đứng yên.
    if (phase.dwellSeconds > 0 && samples.length) {
      const anchor = samples[samples.length - 1].point;
      const ticks = Math.max(1, Math.round(phase.dwellSeconds / parkedSampleSeconds));

      for (let k = 1; k <= ticks; k++) {
        samples.push({
          point: { ...anchor },
          timeMs: clockMs + (phase.dwellSeconds * 1000 * k) / ticks,
          speedKmh: 0,
          parked: true,
        });
      }

      clockMs += phase.dwellSeconds * 1000;
    }
  }

  return samples;
}

/** Chỉ số đỉnh cuối cùng có `cum[i] <= target`. Mảng `cum` luôn không giảm. */
function lowerBound(cum: readonly number[], target: number): number {
  let lo = 0;
  let hi = cum.length - 1;

  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= target) lo = mid;
    else hi = mid - 1;
  }

  return lo;
}

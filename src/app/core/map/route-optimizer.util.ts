import { LatLng } from './map.types';
import { distanceMeters } from './geo.util';

/**
 * =============== TỐI ƯU THỨ TỰ ĐIỂM DỪNG (bài toán TSP) ===============
 *
 * Sắp xếp lại các điểm TRUNG GIAN sao cho tổng quãng đường ngắn nhất, GIỮ NGUYÊN
 * điểm đầu và điểm cuối (điểm xuất phát và điểm đến do người dùng chỉ định).
 *
 * Vì sao tự viết mà không gọi API:
 *  - Google Routes API có `optimizeWaypointOrder: true` nhưng **tính tiền thêm**
 *    và chỉ có ở gói trả phí.
 *  - OSRM có endpoint `/trip` giải TSP, nhưng server demo công cộng thường
 *    chặn/giới hạn endpoint này.
 *  - Với số điểm của một tuyến giao hàng thực tế (5–30 điểm), heuristic dưới đây
 *    chạy dưới 1ms và cho kết quả cách tối ưu tuyệt đối chỉ vài %.
 *
 * THUẬT TOÁN: Nearest Neighbour dựng lời giải ban đầu, rồi 2-opt cải thiện.
 *  - Nearest Neighbour: O(n²), luôn chọn điểm gần nhất chưa đi.
 *  - 2-opt: lặp lại việc đảo ngược một đoạn con nếu làm tổng đường ngắn hơn —
 *    chính là thao tác gỡ các đoạn đường "bắt chéo" nhau.
 *
 * LƯU Ý: hàm dùng khoảng cách ĐƯỜNG CHIM BAY (Haversine) để so sánh, không phải
 * quãng đường theo phố. Với đô thị dày đường thì hai đại lượng này tỉ lệ thuận
 * nên kết quả rất sát; ở địa hình có sông/núi chia cắt thì nên dùng ma trận
 * khoảng cách thật (`/table` của OSRM) thay cho `distanceMeters`.
 */
export function optimizeWaypointOrder<T extends LatLng>(points: readonly T[]): T[] {
  // < 4 điểm thì không có gì để hoán vị (đầu + cuối cố định).
  if (points.length < 4) return [...points];

  const start = points[0];
  const end = points[points.length - 1];
  const middle = points.slice(1, -1);

  const nearest = nearestNeighbour(start, middle);
  const improved = twoOpt([start, ...nearest, end]);

  return improved;
}

/** Tổng quãng đường (đường chim bay) của một thứ tự điểm. */
export function tourLengthMeters(points: readonly LatLng[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distanceMeters(points[i - 1], points[i]);
  return total;
}

/** Kết quả cân nhắc chèn một điểm mới vào tuyến đang có. */
export interface InsertionCandidate {
  /** Chèn vào TRƯỚC vị trí này trong mảng gốc (1 .. path.length - 1). */
  index: number;
  /** Quãng đường ĐỘI THÊM so với tuyến cũ (mét). */
  extraMeters: number;
}

/**
 * ============ CHÈN MỘT ĐIỂM MỚI VÀO TUYẾN SẴN CÓ (cheapest insertion) ============
 *
 * Bài toán khác hẳn `optimizeWaypointOrder`: ở đây tuyến đã chạy được một phần,
 * KHÔNG được phép xáo trộn thứ tự các điểm còn lại (tài xế đã báo khách giờ hẹn),
 * chỉ được nhét điểm mới vào một khe giữa hai điểm liên tiếp.
 *
 * Chi phí chèn vào khe `(i-1, i)`:
 *      d(prev, new) + d(new, next) - d(prev, next)
 * tức là phần đường "đội thêm" do phải vòng qua điểm mới. Chọn khe rẻ nhất.
 *
 * Đây chính là cách các hệ TMS xử lý "đơn phát sinh trong ngày": không chạy lại
 * toàn bộ bài toán tuyến, chỉ tìm chỗ nhét rẻ nhất vào tuyến đang chạy.
 *
 * @param path  tuyến hiện tại, đã bao gồm điểm đầu (vị trí xe/kho) và điểm cuối
 *              (thường là kho về). Cần >= 2 phần tử.
 * @param point điểm giao mới.
 * @param minIndex khe nhỏ nhất được phép chèn — dùng để KHOÁ phần tuyến đã đi qua.
 */
export function bestInsertion(
  path: readonly LatLng[],
  point: LatLng,
  minIndex = 1,
): InsertionCandidate {
  if (path.length < 2) return { index: Math.max(minIndex, 1), extraMeters: 0 };

  const from = Math.min(Math.max(minIndex, 1), path.length - 1);

  let best: InsertionCandidate = { index: from, extraMeters: Number.POSITIVE_INFINITY };

  for (let i = from; i < path.length; i++) {
    const extra = insertionCostMeters(path, point, i);
    if (extra < best.extraMeters) best = { index: i, extraMeters: extra };
  }

  return best;
}

/** Quãng đường đội thêm nếu chèn `point` vào trước vị trí `index`. */
export function insertionCostMeters(
  path: readonly LatLng[],
  point: LatLng,
  index: number,
): number {
  const prev = path[index - 1];
  const next = path[index];

  // Chèn vào sau điểm cuối cùng: chỉ tốn thêm đoạn đi ra điểm mới.
  if (!next) return distanceMeters(prev, point);

  return distanceMeters(prev, point) + distanceMeters(point, next) - distanceMeters(prev, next);
}

function nearestNeighbour<T extends LatLng>(start: LatLng, points: readonly T[]): T[] {
  const remaining = [...points];
  const ordered: T[] = [];
  let current: LatLng = start;

  while (remaining.length) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let i = 0; i < remaining.length; i++) {
      const d = distanceMeters(current, remaining[i]);
      if (d < bestDistance) {
        bestDistance = d;
        bestIndex = i;
      }
    }

    const [next] = remaining.splice(bestIndex, 1);
    ordered.push(next);
    current = next;
  }

  return ordered;
}

/**
 * 2-opt: thử đảo ngược mọi đoạn con `[i..k]`, giữ lại nếu ngắn hơn.
 * `i` bắt đầu từ 1 và `k` dừng ở `length - 2` để KHÔNG đụng vào điểm đầu/cuối.
 */
function twoOpt<T extends LatLng>(tour: T[]): T[] {
  let best = [...tour];
  let bestLength = tourLengthMeters(best);
  let improved = true;

  // Chặn số vòng lặp để không treo UI với danh sách điểm lớn bất thường.
  let guard = 0;

  while (improved && guard++ < 50) {
    improved = false;

    for (let i = 1; i < best.length - 2; i++) {
      for (let k = i + 1; k < best.length - 1; k++) {
        const candidate = [
          ...best.slice(0, i),
          ...best.slice(i, k + 1).reverse(),
          ...best.slice(k + 1),
        ];
        const length = tourLengthMeters(candidate);

        if (length < bestLength - 1) {
          best = candidate;
          bestLength = length;
          improved = true;
        }
      }
    }
  }

  return best;
}

import { AnyRoutePoint, LatLng, LngLatTuple, RoutePoint } from './map.types';

/**
 * Các hàm thuần tuý xử lý toạ độ — tách khỏi mọi SDK để unit-test được ngay,
 * không cần jsdom cũng không cần mock `window.vtmapgl`.
 */

const EARTH_RADIUS_M = 6371000;

const toRad = (value: number): number => (value * Math.PI) / 180;
const toDeg = (value: number): number => (value * 180) / Math.PI;

/** Toạ độ hợp lệ? Giữ nguyên logic "0 cũng bị coi là không hợp lệ" của bản gốc. */
export function isValidLatLng(lng: unknown, lat: unknown): boolean {
  if (!lat || !lng) return false;
  return !!Number(lat) && !!Number(lng);
}

/**
 * Khoảng cách Haversine giữa 2 điểm, trả về **MÉT**.
 * Thống nhất tất cả về mét để không còn chỗ nào phải nhớ nhân/chia 1000 —
 * dùng `metersToKm()` khi cần hiển thị.
 */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);

  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);

  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Tổng chiều dài một chuỗi điểm (mét) — tự cộng, không gọi dịch vụ định tuyến. */
export function totalDistanceMeters(points: readonly LatLng[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += distanceMeters(points[i - 1], points[i]);
  }
  return total;
}

export const metersToKm = (meters: number, fractionDigits = 3): number =>
  Number((meters / 1000).toFixed(fractionDigits));

/** Góc phương vị a -> b (độ, 0 = Bắc) — dùng để xoay icon xe khi playback. */
export function bearingDegrees(a: LatLng, b: LatLng): number {
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Điểm cách `from` đúng `meters` theo hướng `bearingDeg` (0 = Bắc).
 * Dùng để dựng dữ liệu mô phỏng: đẩy xe lệch sang bên phải tuyến 80 m để thử
 * cơ chế phát hiện đi sai đường, hoặc rải nhiễu GPS quanh một vị trí.
 */
export function destinationPoint(from: LatLng, bearingDeg: number, meters: number): LatLng {
  const angular = meters / EARTH_RADIUS_M;
  const bearing = toRad(bearingDeg);
  const lat1 = toRad(from.lat);
  const lng1 = toRad(from.lng);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    );

  return { lat: toDeg(lat2), lng: ((toDeg(lng2) + 540) % 360) - 180 };
}

/** Nội suy tuyến tính giữa 2 điểm (t từ 0 -> 1). */
export function interpolate(a: LatLng, b: LatLng, t: number): LatLng {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

/**
 * Lấy điểm nằm tại `ratio` (0..1) trên một polyline, tính theo QUÃNG ĐƯỜNG
 * chứ không theo chỉ số mảng — nhờ vậy xe chạy đều, không giật ở đoạn nhiều điểm.
 */
export function pointAtRatio(path: readonly LatLng[], ratio: number): LatLng | null {
  if (!path.length) return null;
  if (path.length === 1) return path[0];

  const clamped = Math.min(Math.max(ratio, 0), 1);
  const target = totalDistanceMeters(path) * clamped;

  let travelled = 0;
  for (let i = 1; i < path.length; i++) {
    const segment = distanceMeters(path[i - 1], path[i]);
    if (travelled + segment >= target) {
      const t = segment === 0 ? 0 : (target - travelled) / segment;
      return interpolate(path[i - 1], path[i], t);
    }
    travelled += segment;
  }
  return path[path.length - 1];
}

/**
 * Làm DÀY một polyline: chèn thêm điểm sao cho không đoạn nào dài quá
 * `maxSpacingMeters`, nhưng **giữ nguyên 100% đỉnh gốc**.
 *
 * ====== VÌ SAO KHÔNG ĐƯỢC LẤY MẪU THEO CHỈ SỐ MẢNG ======
 *
 * Cách hay gặp — và sai — là `path.filter((_, i) => i % step === 0)`. Nó coi mọi
 * đỉnh có giá trị như nhau, trong khi đỉnh của một tuyến đường KHÔNG hề rải đều:
 * dịch vụ định tuyến đặt đỉnh dày ở chỗ đường cong và thưa ở đoạn thẳng dài.
 * Đo trên chính tuyến demo Hà Nội (Google Routes, 1240 đỉnh / 35,6 km):
 * khoảng cách giữa hai đỉnh liền nhau p50 = 20 m nhưng max = 254 m.
 *
 * Bỏ 3 trên 4 đỉnh ở khúc cua là cắt thẳng qua khúc cua đó. Cũng trên tuyến ấy,
 * `step = 4` đẩy đường vẽ ra xa mặt đường tới **105 m**, 33 đỉnh lệch quá 20 m,
 * và tạo ra một dây cung dài **403 m** cắt ngang khu phố. Trên bản đồ, đó đúng
 * là hiện tượng "đường xe chạy không bám đường nét đứt".
 *
 * Hàm này đi ngược lại: chỉ THÊM, không bao giờ BỚT. Sai số hình học bằng 0 theo
 * đúng nghĩa đen, vì mọi đỉnh mới đều nằm trên đoạn thẳng nối hai đỉnh cũ. Tham
 * số `maxSpacingMeters` vì thế không ảnh hưởng tới độ chính xác — nó chỉ quyết
 * định xe chạy mượt tới đâu khi tua lại hành trình.
 */
export function resampleAlongPath(
  path: readonly LatLng[],
  maxSpacingMeters: number,
): LatLng[] {
  if (path.length < 2 || !(maxSpacingMeters > 0)) return [...path];

  const result: LatLng[] = [path[0]];

  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const meters = distanceMeters(a, b);

    // `Math.ceil` chứ không `round`: phải BẢO ĐẢM mọi đoạn <= ngưỡng, không phải
    // trung bình quanh ngưỡng.
    const pieces = Math.max(1, Math.ceil(meters / maxSpacingMeters));

    // Bắt đầu từ 1 và kết thúc đúng ở `pieces` -> `b` được đưa vào nguyên vẹn
    // (t = 1 cho lại chính `b`), nên không đỉnh gốc nào bị mất.
    for (let k = 1; k <= pieces; k++) result.push(interpolate(a, b, k / pieces));
  }

  return result;
}

/**
 * Khoảng cách từ điểm `p` tới ĐOẠN THẲNG `a-b` (mét).
 * Dùng để tính "độ lệch tuyến": GPS thực tế cách lộ trình dự kiến bao xa.
 * Xấp xỉ mặt phẳng — sai số không đáng kể ở phạm vi vài km.
 */
export function distanceToSegmentMeters(p: LatLng, a: LatLng, b: LatLng): number {
  const scale = Math.cos(toRad(p.lat));
  const px = p.lng * scale;
  const ax = a.lng * scale;
  const bx = b.lng * scale;

  const dx = bx - ax;
  const dy = b.lat - a.lat;

  if (dx === 0 && dy === 0) return distanceMeters(p, a);

  const t = Math.min(
    Math.max(((px - ax) * dx + (p.lat - a.lat) * dy) / (dx * dx + dy * dy), 0),
    1,
  );

  return distanceMeters(p, { lat: a.lat + dy * t, lng: (ax + dx * t) / scale });
}

/** Khoảng cách nhỏ nhất từ điểm tới cả polyline (mét). */
export function distanceToPathMeters(p: LatLng, path: readonly LatLng[]): number {
  if (path.length === 0) return Number.POSITIVE_INFINITY;
  if (path.length === 1) return distanceMeters(p, path[0]);

  let min = Number.POSITIVE_INFINITY;
  for (let i = 1; i < path.length; i++) {
    min = Math.min(min, distanceToSegmentMeters(p, path[i - 1], path[i]));
  }
  return min;
}

/** Chuẩn hoá đầu vào hỗn hợp về `RoutePoint[]`. */
export function normalizePoints(input: readonly AnyRoutePoint[] | null | undefined): RoutePoint[] {
  return (input ?? []).map((p, i) => toRoutePoint(p, i)).filter((p): p is RoutePoint => !!p);
}

function toRoutePoint(item: AnyRoutePoint, index: number): RoutePoint | null {
  if (Array.isArray(item)) {
    const [lng, lat] = item.map(Number);
    return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat, _originIdx: index } : null;
  }

  if (item && typeof item === 'object') {
    const raw = item as Record<string, unknown>;
    const lng = Number(raw['lng'] ?? raw['lon'] ?? raw['longitude']);
    const lat = Number(raw['lat'] ?? raw['latitude']);

    if (Number.isFinite(lng) && Number.isFinite(lat)) {
      return { ...(item as RoutePoint), lng, lat, _originIdx: index };
    }

    const nested = raw['location'] as Record<string, unknown> | undefined;
    if (nested) {
      const nLng = Number(nested['lng'] ?? nested['lon'] ?? nested['longitude']);
      const nLat = Number(nested['lat'] ?? nested['latitude']);
      if (Number.isFinite(nLng) && Number.isFinite(nLat)) {
        return { ...(item as RoutePoint), lng: nLng, lat: nLat, _originIdx: index };
      }
    }
  }

  return null;
}

/**
 * Bỏ các điểm GPS TRÙNG LIÊN TIẾP (máy đứng yên vẫn bắn log).
 * `epsilon = 0.00001` ≈ 1m. GPS nhiễu nhiều thì tăng lên 0.0001 (~10m).
 */
export function dedupeConsecutive(points: readonly RoutePoint[], epsilon: number): RoutePoint[] {
  if (!points.length) return [];

  const result: RoutePoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = result[result.length - 1];
    const cur = points[i];
    if (Math.abs(cur.lng - prev.lng) < epsilon && Math.abs(cur.lat - prev.lat) < epsilon) continue;
    result.push(cur);
  }
  return result;
}

/**
 * Lấy mẫu thưa để số điểm <= `maxPoints`, LUÔN giữ điểm cuối.
 * Lý do tồn tại: dịch vụ định tuyến nhận điểm qua query string, gửi vài nghìn
 * điểm GPS thô sẽ dính `414 URI Too Long`.
 */
export function decimatePoints<T>(points: readonly T[], maxPoints: number): T[] {
  if (points.length <= maxPoints) return [...points];

  const step = Math.ceil(points.length / maxPoints);
  const result: T[] = [];
  for (let i = 0; i < points.length; i += step) result.push(points[i]);

  const last = points[points.length - 1];
  if (result[result.length - 1] !== last) result.push(last);

  return result;
}

/** Bỏ điểm trùng toạ độ (không cần liên tiếp) — dùng cho lộ trình DỰ KIẾN. */
export function dedupeByCoordinate(points: readonly LngLatTuple[]): LngLatTuple[] {
  return points.filter(
    (v, idx, self) => self.findIndex((a) => a[0] === v[0] && a[1] === v[1]) === idx,
  );
}

export const toLatLng = ([lng, lat]: LngLatTuple): LatLng => ({ lat, lng });
export const toLngLatTuple = ({ lat, lng }: LatLng): LngLatTuple => [lng, lat];

/** `2026-09-09T07:05:00` -> `09/09/2026 07:05:00` (nội dung popup điểm GPS). */
export function formatDateTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;

  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** `2026-09-09T07:05:00` -> `07:05` (nhãn hiển thị trên marker). */
export function formatTimeLabel(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';

  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `1234` -> `1,2 km` ; `850` -> `850 m`. */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return '0 m';
  return meters < 1000
    ? `${Math.round(meters)} m`
    : `${(meters / 1000).toFixed(1).replace('.', ',')} km`;
}

/** `3720` -> `1 giờ 2 phút`. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 phút';
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m} phút`;
  return m ? `${h} giờ ${m} phút` : `${h} giờ`;
}

/** Deep-link mở app/web Google Maps tại một toạ độ (chỉ XEM vị trí). */
export function googleMapsPointUrl(lat?: number | string, lng?: number | string): string {
  if (lat == null || lng == null || lat === '' || lng === '') return '';
  return `https://maps.google.com/?q=${encodeURIComponent(String(lat))},${encodeURIComponent(String(lng))}`;
}

/**
 * Deep-link CHỈ ĐƯỜNG THẬT (turn-by-turn) — Google Maps URLs API.
 * Mở trên điện thoại sẽ nhảy thẳng vào app Google Maps ở chế độ dẫn đường.
 */
export function googleMapsDirectionUrl(
  origin: LatLng,
  destination: LatLng,
  waypoints: readonly LatLng[] = [],
  travelMode: 'driving' | 'walking' | 'bicycling' | 'two-wheeler' = 'driving',
): string {
  const params = new URLSearchParams({
    api: '1',
    origin: `${origin.lat},${origin.lng}`,
    destination: `${destination.lat},${destination.lng}`,
    travelmode: travelMode,
  });

  if (waypoints.length) {
    params.set('waypoints', waypoints.map((w) => `${w.lat},${w.lng}`).join('|'));
  }

  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

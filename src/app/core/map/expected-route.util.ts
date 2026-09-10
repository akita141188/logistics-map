import { LngLatTuple } from './map.types';
import { dedupeByCoordinate } from './geo.util';

/** Khách hàng trên tuyến, lấy từ API `/routing/map`. */
export interface RouteCustomer {
  customerId?: string | number;
  /** Thứ tự ghé thăm. `0`/`null` = chưa thiết lập. */
  seq?: number | string | null;
  lat?: number | string;
  lng?: number | string;
}

export interface ExpectedRouteContext {
  /** Toạ độ checkpoint của NPP (nếu đã khai báo). */
  distributorCheckpoint?: { lat: number | string; lng: number | string } | null;
  /** Vị trí hiện tại của nhân viên — dùng làm fallback điểm xuất phát. */
  staffPosition?: { lat: number | string; lng: number | string } | null;
}

/** Tuyến đã thiết lập thứ tự ghé thăm chưa? */
export function hasVisitSequence(customers: readonly RouteCustomer[]): boolean {
  return customers.some((c) => Number(c?.seq) > 0);
}

/**
 * Dựng danh sách điểm cho **LỘ TRÌNH DỰ KIẾN (MH06)**.
 * Port `buildExpectedRoutePointList()` trong `detailInfo.service.ts`.
 *
 * KHÁC BẢN VUE: hàm gốc là `async` và tự gọi API `getUnitById` để lấy checkpoint
 * NPP. Ở đây tách phần I/O ra ngoài (`context`) để hàm trở thành PURE FUNCTION —
 * unit-test được mà không cần mock HTTP. Caller chịu trách nhiệm nạp dữ liệu.
 *
 * Quy tắc nghiệp vụ (giữ nguyên):
 *  1. Tuyến chưa thiết lập thứ tự ghé thăm -> KHÔNG vẽ đường (chỉ hiện marker).
 *  2. Sắp theo `seq` tăng dần, loại khách chưa có seq.
 *  3. Bỏ điểm trùng toạ độ (nhiều khách cùng một địa chỉ).
 *  4. Chèn điểm xuất phát: checkpoint NPP, fallback = vị trí nhân viên.
 *  5. Lộ trình KHÉP VÒNG về NPP -> chèn lại checkpoint ở cuối.
 *     CHỈ khép vòng khi đúng là checkpoint NPP; nếu chỉ có vị trí nhân viên thì
 *     không khép (nhân viên không bắt buộc quay về chỗ xuất phát).
 */
export function buildExpectedRoutePoints(
  customers: readonly RouteCustomer[],
  context: ExpectedRouteContext = {},
): LngLatTuple[] {
  if (!hasVisitSequence(customers)) return [];

  const sorted = [...customers]
    .filter((c) => Number(c?.seq) > 0)
    .sort((a, b) => Number(a.seq) - Number(b.seq));

  const points = dedupeByCoordinate(
    sorted
      .map((c): LngLatTuple => [Number(c.lng), Number(c.lat)])
      .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat)),
  );

  const checkpoint = context.distributorCheckpoint;
  const staff = context.staffPosition;

  let start: LngLatTuple | null = null;
  let isDistributorCheckpoint = false;

  if (checkpoint && Number.isFinite(Number(checkpoint.lat))) {
    start = [Number(checkpoint.lng), Number(checkpoint.lat)];
    isDistributorCheckpoint = true;
  } else if (staff && Number.isFinite(Number(staff.lat))) {
    start = [Number(staff.lng), Number(staff.lat)];
  }

  if (!start) return points;

  const result: LngLatTuple[] = [start, ...points];
  if (isDistributorCheckpoint) result.push([...start] as LngLatTuple);

  return result;
}

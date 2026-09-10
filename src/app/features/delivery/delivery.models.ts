import { LatLng, RoutePoint } from '../../core/map';

/** Trạng thái một điểm giao trong chuyến. */
export type StopStatus = 'delivered' | 'failed' | 'pending';

/** Một điểm giao hàng (tương ứng 1 đơn hàng cần giao). */
export interface DeliveryStop extends LatLng {
  id: string;
  /** Thứ tự ghé thăm theo kế hoạch — chính là `seq` của tuyến bên DMS. */
  seq: number;
  orderCode: string;
  customerName: string;
  address: string;
  /** Giờ dự kiến có mặt (ISO). */
  plannedArrival: string;
  /** Giờ thực tế tài xế check-in (ISO). `null` nếu chưa tới. */
  actualArrival: string | null;
  status: StopStatus;
  /** Giá trị đơn (VND). */
  amount: number;
  note?: string;
  /**
   * Điểm PHÁT SINH — điều phối viên chèn thêm trong lúc xe đang chạy, không nằm
   * trong kế hoạch đầu ngày. Loại này không có `plannedArrival` gốc để đối chiếu,
   * mọi con số giờ giấc của nó đều là ETA tính lại.
   */
  isAdHoc?: boolean;
}

/** Thông tin kho/NPP xuất phát. */
export interface Depot extends LatLng {
  name: string;
  address: string;
}

/** Một chuyến giao hàng trong ngày. */
export interface DeliveryTrip {
  id: string;
  code: string;
  date: string;
  driverName: string;
  driverPhone: string;
  vehiclePlate: string;
  depot: Depot;
  stops: DeliveryStop[];
  /**
   * GPS log thực tế của xe. Ở hệ thống thật đây là dữ liệu từ API
   * `staffPositionLog` (app tài xế bắn về mỗi 30–60 giây).
   */
  track: RoutePoint[];
}

/** Số liệu tổng hợp hiển thị ở thanh KPI của màn giám sát. */
export interface TripStats {
  plannedDistanceMeters: number;
  actualDistanceMeters: number;
  /** Số điểm đã giao thành công / tổng số điểm. */
  deliveredCount: number;
  failedCount: number;
  totalStops: number;
  /** Số điểm tới muộn hơn giờ kế hoạch quá 15 phút. */
  lateCount: number;
  /** Số điểm GPS nằm cách lộ trình dự kiến quá ngưỡng cho phép. */
  deviationCount: number;
  /** Khoảng lệch xa nhất so với lộ trình dự kiến (mét). */
  maxDeviationMeters: number;
  /** Tổng doanh thu đã thu được của các điểm đã giao. */
  collectedAmount: number;
}

/**
 * Giờ dự kiến tới của MỘT điểm còn lại, tính lại từ vị trí GPS mới nhất của xe.
 * Khác `DeliveryStop.plannedArrival` ở chỗ: cái kia là kế hoạch cứng lập từ đầu
 * ngày, cái này là dự báo động, đổi mỗi khi tuyến bị sửa.
 */
export interface StopEta {
  stopId: string;
  /** Giờ dự kiến tới (ISO). */
  eta: string;
  /** Lệch so với kế hoạch gốc (phút, dương = muộn hơn kế hoạch). */
  shiftMinutes: number;
}

/** Tác động của việc sửa tuyến, so kế hoạch hiện tại với kế hoạch gốc. */
export interface PlanImpact {
  /** Có ai đó đã sửa tuyến chưa. */
  changed: boolean;
  addedStops: number;
  removedStops: number;
  /** Quãng đường đội thêm (mét, âm = tiết kiệm được). */
  extraDistanceMeters: number;
  /** Thời gian chạy đội thêm (giây). */
  extraDurationSeconds: number;
  /** Số điểm còn lại bị đẩy lịch quá 5 phút. */
  shiftedStops: number;
  /** Điểm bị đẩy lịch nhiều nhất (phút). */
  maxShiftMinutes: number;
  /** Giờ dự kiến xe về tới kho (ISO), tính lại theo tuyến hiện tại. */
  backToDepotEta: string;
}

/** Dữ liệu người dùng nhập ở form "Thêm điểm giao". */
export interface StopDraft {
  customerName: string;
  address: string;
  amount: number;
  note: string;
  point: LatLng | null;
  /**
   * `auto` = để hệ thống tìm khe rẻ nhất; số = chèn vào trước điểm thứ N
   * (index trong mảng stops).
   */
  position: 'auto' | number;
}

export const EMPTY_DRAFT: StopDraft = {
  customerName: '',
  address: '',
  amount: 0,
  note: '',
  point: null,
  position: 'auto',
};

export const STOP_STATUS_LABEL: Record<StopStatus, string> = {
  delivered: 'Đã giao',
  failed: 'Giao thất bại',
  pending: 'Chưa tới',
};

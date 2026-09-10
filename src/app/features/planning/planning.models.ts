import { LatLng } from '../../core/map';

/** Một đơn hàng chờ phân xe. */
export interface DeliveryOrder extends LatLng {
  id: string;
  code: string;
  customerName: string;
  address: string;
  /** Khối lượng quy đổi (kg) — cùng đơn vị với `PlanningVehicle.capacityKg`. */
  weightKg: number;
  amount: number;
  /**
   * Khung giờ khách nhận hàng, dạng giờ trong ngày (7.5 = 07:30).
   * Đây là ràng buộc mềm: vi phạm thì cảnh báo chứ không loại đơn khỏi tuyến.
   */
  windowFrom: number;
  windowTo: number;
  priority: 'normal' | 'high';
  /** Phút đứng lại giao tại điểm này. */
  serviceMinutes: number;
}

export interface PlanningVehicle {
  id: string;
  plate: string;
  driverName: string;
  capacityKg: number;
  /** Trần số điểm mỗi chuyến theo giờ công tài xế. */
  maxStops: number;
  /** Chi phí vận hành mỗi km (VND) — để quy tuyến ra tiền. */
  costPerKm: number;
  color: string;
  /** Tài xế nghỉ / xe bảo dưỡng -> không đưa vào bài toán. */
  available: boolean;
}

export interface PlanningDepot extends LatLng {
  id: string;
  name: string;
  address: string;
  /** Giờ xe bắt đầu rời kho (7.25 = 07:15). */
  departHour: number;
}

/** Một điểm dừng trong tuyến đã lập, kèm giờ dự kiến tính từ ma trận thật. */
export interface PlannedStop {
  order: DeliveryOrder;
  seq: number;
  /** Giờ dự kiến tới (ms epoch trong ngày hôm nay). */
  etaMs: number;
  /** Tới ngoài khung giờ khách hẹn. */
  windowViolation: 'early' | 'late' | null;
  legDistanceMeters: number;
  legDurationSeconds: number;
}

/** Kết quả lập tuyến cho MỘT xe. */
export interface PlannedRoute {
  vehicle: PlanningVehicle;
  stops: PlannedStop[];
  distanceMeters: number;
  durationSeconds: number;
  loadKg: number;
  utilization: number;
  costVnd: number;
  /** Giờ dự kiến về tới kho (ms). */
  backToDepotMs: number;
  /** Hình học đường đi thật (bám phố) — điền sau khi định tuyến xong. */
  path: LatLng[];
  windowViolations: number;
}

export interface PlanSummary {
  routes: number;
  assignedOrders: number;
  unassignedOrders: number;
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  totalCostVnd: number;
  totalWeightKg: number;
  averageUtilization: number;
  windowViolations: number;
  /** Quãng đường nếu mỗi đơn đi một chuyến riêng — mốc so sánh. */
  naiveDistanceMeters: number;
  /** Ma trận chi phí lấy từ đường thật hay ước lượng chim bay. */
  realMatrix: boolean;
}

export const ORDER_PRIORITY_LABEL: Record<DeliveryOrder['priority'], string> = {
  normal: 'Thường',
  high: 'Ưu tiên',
};

/** `7.5` -> `07:30`. */
export function hourToLabel(hour: number): string {
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

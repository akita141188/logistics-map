import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MapMarker, MapSurfaceComponent, formatDistance, formatDuration } from '../../core/map';
import { PLAN_PHASE_LABEL, PlanningStore } from './planning.store';
import {
  DeliveryOrder,
  ORDER_PRIORITY_LABEL,
  PlannedRoute,
  hourToLabel,
} from './planning.models';

/**
 * ============ MÀN LẬP KẾ HOẠCH & PHÂN XE (dispatch planning) ============
 *
 * Công việc buổi sáng của người điều vận: có một đống đơn và một số xe, phải
 * quyết định xe nào chở đơn nào, đi theo thứ tự nào.
 *
 * Màn hình được dựng quanh một nguyên tắc: **máy đề xuất, người quyết định**.
 * Thuật toán đưa ra phương án trong 2 giây, nhưng mọi thứ đều sửa được bằng tay
 * và sửa tới đâu số liệu cập nhật tới đó — vì người điều vận biết những thứ dữ
 * liệu không có (khách này khó tính, đường kia đang cấm, tài xế nọ quen tuyến).
 */
@Component({
  selector: 'app-planning',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MapSurfaceComponent],
  providers: [PlanningStore],
  templateUrl: './planning.page.html',
  styleUrl: './planning.page.scss',
})
export class PlanningPage {
  protected readonly store = inject(PlanningStore);

  protected readonly phaseLabel = PLAN_PHASE_LABEL;
  protected readonly priorityLabel = ORDER_PRIORITY_LABEL;
  protected readonly hourToLabel = hourToLabel;
  protected readonly formatDistance = formatDistance;
  protected readonly formatDuration = formatDuration;

  /**
   * Tổng tải trọng đội xe đang bật, so với tổng khối lượng đơn đang chọn.
   *
   * Hai con số này đặt cạnh nhau ngay trên form vì chúng trả lời trước câu hỏi
   * "bấm tối ưu xong có xếp hết không" — không cần chạy thuật toán mới biết
   * thiếu tải. Tránh cho người dùng chờ 3 giây rồi mới nhận tin xấu.
   */
  protected readonly sumCapacity = computed(() =>
    this.store.availableVehicles().reduce((sum, v) => sum + v.capacityKg, 0),
  );

  protected readonly sumWeight = computed(() =>
    this.store.selectedOrders().reduce((sum, o) => sum + o.weightKg, 0),
  );

  /**
   * Bị từ chối (quá tải / quá số điểm) thì phải TRẢ Ô CHỌN VỀ GIÁ TRỊ CŨ.
   * Không trả về thì `<select>` vẫn hiển thị biển số xe mới trong khi kế hoạch
   * không hề đổi — người dùng tin là đã chuyển xong.
   */
  protected onMoveOrder(orderId: string, event: Event): void {
    const select = event.target as HTMLSelectElement;
    const previous = this.currentVehicleOf(orderId) ?? '';
    const value = select.value;

    if (!this.store.moveOrder(orderId, value || null)) {
      select.value = previous;
    }
  }

  private currentVehicleOf(orderId: string): string | null {
    return this.store.routes().find((r) => r.stops.some((s) => s.order.id === orderId))?.vehicle.id
      ?? null;
  }

  protected onMarkerClick(marker: MapMarker): void {
    const order = this.store.orders().find((o) => o.id === marker.key);
    if (order) this.store.focusOrder(order);
  }

  protected money(vnd: number): string {
    if (!vnd) return '0 ₫';
    if (vnd >= 1_000_000) return `${(vnd / 1_000_000).toFixed(1).replace('.', ',')} tr ₫`;
    return `${Math.round(vnd / 1000)}k ₫`;
  }

  protected percent(ratio: number): string {
    return `${Math.round(ratio * 100)}%`;
  }

  protected trackRoute = (_: number, r: PlannedRoute) => r.vehicle.id;
  protected trackOrder = (_: number, o: DeliveryOrder) => o.id;
}

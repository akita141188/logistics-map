import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  ALERT_ICON,
  ALERT_LABEL,
  FleetAlert,
} from '../delivery/alerts.util';
import {
  MapMarker,
  MapSurfaceComponent,
  formatDistance,
  formatTimeLabel,
} from '../../core/map';
import { CLOCK_SPEEDS, ClockSpeed, FleetStore, VEHICLE_STATUS_LABEL, VehicleState } from './fleet.store';

/**
 * ================== BẢNG ĐIỀU HÀNH ĐỘI XE ==================
 *
 * Màn hình dành cho người trực phòng điều độ: nhìn một lần thấy cả đội đang ở
 * đâu, ai đang trễ, ai đang có vấn đề.
 *
 * BỐ CỤC theo đúng thứ tự ưu tiên khi có sự cố:
 *   trái  — số liệu tổng + danh sách xe (chọn xe để soi kỹ)
 *   giữa  — bản đồ toàn đội + thanh thời gian
 *   phải  — dòng cảnh báo, nặng nhất nằm trên cùng
 *
 * Store được provide ở CẤP COMPONENT (không phải `root`): rời màn là đồng hồ mô
 * phỏng dừng theo, không có timer chạy ngầm ăn CPU khi người dùng đã sang màn khác.
 */
@Component({
  selector: 'app-fleet-board',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MapSurfaceComponent, RouterLink],
  providers: [FleetStore],
  templateUrl: './fleet-board.page.html',
  styleUrl: './fleet-board.page.scss',
})
export class FleetBoardPage {
  protected readonly store = inject(FleetStore);

  protected readonly speeds = CLOCK_SPEEDS;
  protected readonly statusLabel = VEHICLE_STATUS_LABEL;
  protected readonly alertLabel = ALERT_LABEL;
  protected readonly alertIcon = ALERT_ICON;

  protected readonly formatDistance = formatDistance;
  protected readonly formatTime = formatTimeLabel;

  protected setSpeed(value: ClockSpeed): void {
    this.store.setSpeed(value);
  }

  protected onSeek(event: Event): void {
    this.store.seek(Number((event.target as HTMLInputElement).value));
  }

  protected onMarkerClick(marker: MapMarker): void {
    // Marker xe dùng chính `tripId` làm key -> bấm lên xe là chọn xe đó.
    if (this.store.trips().some((t) => t.id === marker.key)) {
      this.store.selectTrip(marker.key);
    }
  }

  protected trackVehicle = (_: number, v: VehicleState) => v.trip.id;
  protected trackAlert = (_: number, a: FleetAlert) => a.id;

  /** `12345678` -> `12,3 tr` — bảng điều hành không có chỗ cho số đầy đủ. */
  protected money(amount: number): string {
    if (!amount) return '0';
    if (amount >= 1_000_000_000) return `${(amount / 1_000_000_000).toFixed(1).replace('.', ',')} tỷ`;
    if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1).replace('.', ',')} tr`;
    return `${Math.round(amount / 1000)} k`;
  }

  protected percent(ratio: number): string {
    return `${Math.round(ratio * 100)}%`;
  }
}

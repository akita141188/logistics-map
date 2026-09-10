import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import {
  LatLng,
  MapSurfaceComponent,
  formatDistance,
  formatDuration,
  formatTimeLabel,
  googleMapsDirectionUrl,
  maneuverIcon,
} from '../../core/map';
import { NAV_SPEEDS, NavSpeed, NavigationStore } from './navigation.store';

/**
 * ================== MÀN DẪN ĐƯỜNG (góc nhìn tài xế) ==================
 *
 * Toàn bộ logic nằm ở `NavigationStore` + `core/map/navigation.util.ts`.
 * Component này chỉ làm ba việc: đọc signal, đổ ra template, và chuyển sự kiện
 * DOM thành lệnh của store.
 *
 * VÌ SAO BỐ CỤC ĐẶT BĂNG CHỈ DẪN ĐÈ LÊN BẢN ĐỒ THAY VÌ Ở CỘT BÊN:
 * Người dùng màn này là tài xế đang cầm vô-lăng, mỗi lần liếc màn hình chỉ có
 * dưới một giây. Thông tin sống còn (rẽ đâu, còn bao nhiêu mét) phải nằm ở nơi
 * mắt nhìn tới đầu tiên và phải to; mọi thứ khác (danh sách điểm, nhật ký) đẩy
 * hết sang cột phải cho điều phối viên xem.
 */
@Component({
  selector: 'dms-navigate-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [NavigationStore],
  imports: [MapSurfaceComponent],
  templateUrl: './navigate.page.html',
  styleUrl: './navigate.page.scss',
})
export class NavigatePage {
  protected readonly store = inject(NavigationStore);
  protected readonly speeds = NAV_SPEEDS;

  protected readonly formatDistance = formatDistance;
  protected readonly formatDuration = formatDuration;
  protected readonly formatTime = formatTimeLabel;
  protected readonly maneuverIcon = maneuverIcon;

  /** `?trip=TRIP-HN-01` — router tự gán nhờ `withComponentInputBinding()`. */
  readonly trip = input<string | undefined>();

  constructor() {
    effect(() => {
      const id = this.trip();
      if (id && id !== this.store.tripId()) this.store.selectTrip(id);
    });
  }

  /** Khung nhìn ban đầu: kho của chuyến đang chọn. */
  protected readonly center = computed<LatLng>(() => {
    const depot = this.store.trip()?.depot;
    return depot ? { lat: depot.lat, lng: depot.lng } : { lat: 21.0278, lng: 105.8342 };
  });

  /**
   * Khi nào được phép fit lại khung nhìn.
   *
   * ĐANG BÁM XE thì CHỈ fit lúc đổi chuyến. Token cũ có cả `rerouteCount` và
   * `routePath().length`, nên mỗi lần định tuyến lại (kể cả tự động khi đi lệch)
   * bản đồ lại giật ra ôm toàn tuyến rồi bị `flyTo` của chế độ bám xe kéo về —
   * hai cơ chế khung nhìn đánh nhau, đúng thứ làm màn hình dẫn đường nhảy loạn.
   *
   * TẮT BÁM XE thì người xem đang ở vai điều phối, muốn thấy toàn tuyến: lúc đó
   * mới cho `rerouteCount` vào token để mỗi tuyến mới được fit lại một lần.
   */
  protected readonly fitToken = computed(() =>
    this.store.follow()
      ? `trip-${this.store.tripId()}`
      : `route-${this.store.tripId()}-${this.store.rerouteCount()}`,
  );

  /** Deep-link mở dẫn đường thật trên điện thoại cho phần đường còn lại. */
  protected readonly handoffUrl = computed(() => {
    const waypoints = this.store.waypoints();
    if (!waypoints.length) return '';

    const destination = waypoints[waypoints.length - 1].point;
    const via = waypoints.slice(0, -1).map((w) => w.point);

    return googleMapsDirectionUrl(this.store.position(), destination, via, 'driving');
  });

  protected onSelectTrip(event: Event): void {
    this.store.selectTrip((event.target as HTMLSelectElement).value);
  }

  protected onSpeed(event: Event): void {
    this.store.setSpeed(Number((event.target as HTMLSelectElement).value) as NavSpeed);
  }

  /** Bấm bản đồ khi đang dẫn đường không có tác dụng gì — chặn ở đây cho rõ ý. */
  protected onMapClick(_: LatLng): void {}
}

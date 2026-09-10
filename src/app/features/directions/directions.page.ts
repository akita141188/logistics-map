import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import {
  GeocodeResult,
  LatLng,
  MapSurfaceComponent,
  RouteResult,
  RouteStep,
  formatDistance,
  formatDuration,
} from '../../core/map';
import { DirectionsStore, TRAVEL_MODES, Waypoint } from './directions.store';

/**
 * ===================== MÀN CHỈ ĐƯỜNG =====================
 *
 * Cho phép dựng một lộ trình nhiều điểm dừng rồi xem đường đi thật trên phố:
 *  - thêm điểm bằng tìm kiếm địa chỉ (Nominatim) hoặc bấm thẳng lên bản đồ,
 *  - đổi thứ tự / đảo chiều / tự tối ưu thứ tự (2-opt),
 *  - đổi phương tiện (ô tô, xe máy, xe đạp, đi bộ),
 *  - xem tổng quãng đường, thời gian, giờ tới dự kiến,
 *  - xem chỉ dẫn rẽ từng chặng, bấm vào là bản đồ bay tới đúng ngã rẽ,
 *  - đẩy sang app Google Maps để dẫn đường thật khi ra đường.
 */
@Component({
  selector: 'dms-directions-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [DirectionsStore],
  imports: [MapSurfaceComponent],
  templateUrl: './directions.page.html',
  styleUrl: './directions.page.scss',
})
export class DirectionsPage {
  protected readonly store = inject(DirectionsStore);
  protected readonly travelModes = TRAVEL_MODES;

  protected readonly formatDistance = formatDistance;
  protected readonly formatDuration = formatDuration;

  protected readonly hasRoute = computed(() => this.store.routePath().length > 1);

  protected readonly searchItems = computed<GeocodeResult[]>(
    () => this.store.searchResults.value() ?? [],
  );

  protected onQuery(event: Event): void {
    this.store.setQuery((event.target as HTMLInputElement).value);
  }

  protected onPickResult(item: GeocodeResult): void {
    this.store.addWaypoint({ lat: item.lat, lng: item.lng }, item.shortName, item.displayName);
  }

  protected onMapClick(point: LatLng): void {
    this.store.addWaypointFromMap(point);
  }

  protected trackStep(index: number, _step: RouteStep): number {
    return index;
  }

  protected waypointRole(index: number, total: number): string {
    if (index === 0) return 'Điểm đi';
    if (index === total - 1) return 'Điểm đến';
    return `Điểm dừng ${index}`;
  }

  protected stepIcon(step: RouteStep): string {
    switch (step.modifier) {
      case 'left':
      case 'sharp left':
      case 'slight left':
        return '↰';
      case 'right':
      case 'sharp right':
      case 'slight right':
        return '↱';
      case 'uturn':
        return '⤺';
      default:
        return step.maneuver === 'arrive' ? '⚑' : '↑';
    }
  }

  protected focusWaypoint(w: Waypoint): void {
    this.store.focusWaypoint(w);
  }

  /**
   * So một phương án với phương án tốt nhất: "+4 phút · +1,2 km".
   *
   * So bằng THỜI GIAN trước, quãng đường sau — với người lái, đi vòng xa hơn mà
   * nhanh hơn vẫn là lựa chọn đúng.
   */
  protected compareToBest(alt: RouteResult): string {
    const best = this.store.alternatives()[0];
    if (!best || best === alt) return '';

    const dt = Math.round(((alt.durationSeconds ?? 0) - (best.durationSeconds ?? 0)) / 60);
    const dd = alt.distanceMeters - best.distanceMeters;

    const time = dt === 0 ? 'cùng giờ' : `${dt > 0 ? '+' : ''}${dt}′`;
    const dist = `${dd > 0 ? '+' : '−'}${formatDistance(Math.abs(dd))}`;

    return `${time} · ${dist}`;
  }
}

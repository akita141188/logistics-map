import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import {
  GeocodeResult,
  LatLng,
  MapSurfaceComponent,
  formatDistance,
  formatDuration,
  formatTimeLabel,
  googleMapsDirectionUrl,
  googleMapsPointUrl,
} from '../../core/map';
import { ALERT_ICON, ALERT_LABEL, FleetAlert } from './alerts.util';
import {
  DeliveryMonitorStore,
  PLAYBACK_SPEEDS,
  PlaybackSpeed,
  SERVICE_MINUTES_PER_STOP,
} from './delivery-monitor.store';
import { DeliveryStop, STOP_STATUS_LABEL } from './delivery.models';

/**
 * ============== MÀN GIÁM SÁT LỘ TRÌNH GIAO HÀNG ==============
 *
 * Trả lời 5 câu hỏi mà điều phối viên cần:
 *  1. Xe đang ở đâu?                          -> marker xe + đồng hồ thời gian
 *  2. Đi có đúng lộ trình dự kiến không?       -> đường tím nét đứt vs đường xanh liền,
 *                                                đoạn lệch tô đỏ + cảnh báo
 *  3. Giao được bao nhiêu điểm, trễ mấy điểm?  -> thanh KPI + bảng điểm giao
 *  4. Lúc 9h30 xe ở chỗ nào?                   -> thanh tua lại hành trình (playback)
 *  5. Nhận thêm đơn phát sinh có kịp không?    -> form "Thêm điểm giao" + bảng tác động
 *
 * Câu số 5 mới là phần đáng chú ý: nó biến màn hình từ "xem báo cáo" thành
 * "công cụ điều phối". Xem chi tiết ở `delivery-monitor.store.ts`.
 */
@Component({
  selector: 'dms-delivery-monitor-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [DeliveryMonitorStore],
  imports: [MapSurfaceComponent, DecimalPipe],
  templateUrl: './delivery-monitor.page.html',
  styleUrl: './delivery-monitor.page.scss',
})
export class DeliveryMonitorPage {
  protected readonly store = inject(DeliveryMonitorStore);
  protected readonly speeds = PLAYBACK_SPEEDS;
  protected readonly statusLabel = STOP_STATUS_LABEL;
  protected readonly serviceMinutes = SERVICE_MINUTES_PER_STOP;
  protected readonly alertLabel = ALERT_LABEL;
  protected readonly alertIcon = ALERT_ICON;
  /** Template không truy cập được global; phải phơi ra qua field của class. */
  protected readonly Math = Math;

  protected readonly formatDistance = formatDistance;
  protected readonly formatDuration = formatDuration;
  protected readonly formatTime = formatTimeLabel;

  /**
   * `?trip=TRIP-HN-01` — nhận được nhờ `withComponentInputBinding()` đã bật ở
   * `app.config.ts`: router tự gán query param vào input cùng tên, không cần
   * `ActivatedRoute` + `subscribe`.
   */
  readonly trip = input<string | undefined>();

  constructor() {
    effect(() => this.store.applyTripFromRoute(this.trip()));
  }

  protected trackAlert = (_: number, a: FleetAlert) => a.id;

  /**
   * Ép bản đồ fit lại khung nhìn khi đổi chuyến hoặc khi tuyến đổi hình dạng.
   * Có thêm số điểm giao: chèn/xoá điểm là fit lại, vì khung nhìn cũ có thể
   * không chứa điểm mới.
   */
  protected readonly fitToken = computed(
    () =>
      `${this.store.tripId()}-${this.store.plannedPath().length}-${this.store.trip()?.stops.length ?? 0}`,
  );

  protected readonly progressPercent = computed(() => {
    const len = this.store.trackLength();
    return len < 2 ? 0 : Math.round((this.store.cursor() / (len - 1)) * 100);
  });

  /** Chênh lệch quãng đường thực tế so với kế hoạch. */
  protected readonly distanceDelta = computed(() => {
    const s = this.store.stats();
    // So với phần kế hoạch TƯƠNG ỨNG, không so với cả tuyến — xem
    // `DeliveryMonitorStore.plannedSoFarMeters`.
    return s.actualDistanceMeters - s.plannedSoFarMeters;
  });

  protected readonly searchItems = computed<GeocodeResult[]>(
    () => this.store.searchResults.value() ?? [],
  );

  /** Danh sách vị trí chèn cho ô select "Chèn vào" (chỉ phần chưa giao). */
  protected readonly insertOptions = computed(() => {
    const stops = this.store.trip()?.stops ?? [];
    const locked = this.store.lockedCount();

    const options = stops
      .slice(locked)
      .map((stop, i) => ({ value: locked + i, label: `Trước điểm ${stop.seq} — ${stop.customerName}` }));

    return [...options, { value: stops.length, label: 'Cuối tuyến (trước khi về kho)' }];
  });

  /** Link mở chỉ đường thật trên Google Maps cho phần chặng còn lại. */
  protected readonly remainingDirectionUrl = computed(() => {
    const trip = this.store.trip();
    const current = this.store.lastPoint();
    if (!trip || !current) return '';

    const remaining = this.store.pendingStops();
    if (!remaining.length) return '';

    // Điểm cuối là kho — tài xế giao xong phải quay về nhập quỹ/trả vỏ.
    return googleMapsDirectionUrl(
      { lat: current.lat, lng: current.lng },
      { lat: trip.depot.lat, lng: trip.depot.lng },
      remaining.map((s) => ({ lat: s.lat, lng: s.lng })),
      'driving',
    );
  });

  protected stopMapUrl(stop: DeliveryStop): string {
    return googleMapsPointUrl(stop.lat, stop.lng);
  }

  protected onSeek(event: Event): void {
    this.store.seek(Number((event.target as HTMLInputElement).value));
  }

  protected onSpeed(event: Event): void {
    this.store.setSpeed(Number((event.target as HTMLSelectElement).value) as PlaybackSpeed);
  }

  protected onSelectTrip(event: Event): void {
    this.store.selectTrip((event.target as HTMLSelectElement).value);
  }

  /**
   * Bấm vào một dòng trong bảng -> highlight marker tương ứng.
   * Bấm lại dòng đang chọn -> bỏ chọn.
   */
  protected onRowClick(stop: DeliveryStop): void {
    this.store.selectStop(this.store.selectedStopId() === stop.id ? null : stop.id);
  }

  protected lateText(stop: DeliveryStop): string {
    if (!stop.actualArrival) {
      const eta = this.store.etaOf(stop);
      if (!eta) return '—';
      if (stop.isAdHoc) return 'Phát sinh';
      if (eta.shiftMinutes > 0) return `+${eta.shiftMinutes}′`;
      return 'Đúng lịch';
    }

    const minutes = this.store.lateMinutes(stop);
    if (minutes > 0) return `Trễ ${minutes}′`;
    if (minutes < 0) return `Sớm ${Math.abs(minutes)}′`;
    return 'Đúng giờ';
  }

  /** Cột "TT": đã tới thì hiện giờ thật, chưa tới thì hiện ETA tính lại. */
  protected arrivalText(stop: DeliveryStop): string {
    if (stop.actualArrival) return formatTimeLabel(stop.actualArrival);
    const eta = this.store.etaOf(stop);
    return eta ? `~${formatTimeLabel(eta.eta)}` : '—';
  }

  // ------------------------------------------------------- form thêm điểm giao

  protected onQuery(event: Event): void {
    this.store.setQuery((event.target as HTMLInputElement).value);
  }

  protected onPickResult(item: GeocodeResult): void {
    this.store.pickFromSearch(item, item.shortName, item.displayName);
  }

  protected onMapClick(point: LatLng): void {
    this.store.pickFromMap(point);
  }

  protected onDraftText(field: 'customerName' | 'address' | 'note', event: Event): void {
    this.store.patchDraft({ [field]: (event.target as HTMLInputElement).value });
  }

  protected onDraftAmount(event: Event): void {
    this.store.patchDraft({ amount: Number((event.target as HTMLInputElement).value) || 0 });
  }

  protected onDraftPosition(event: Event): void {
    const raw = (event.target as HTMLSelectElement).value;
    this.store.patchDraft({ position: raw === 'auto' ? 'auto' : Number(raw) });
  }
}

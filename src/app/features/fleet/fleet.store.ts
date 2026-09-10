import { DestroyRef, Injectable, computed, effect, inject, resource, signal } from '@angular/core';
import {
  CleanResult,
  LatLng,
  MAP_COLORS,
  MAP_ROUTING_CONFIG,
  MapCircle,
  MapMarker,
  MapPath,
  RoutePoint,
  cleanTrack,
  distanceMeters,
  distanceToPathMeters,
  formatTimeLabel,
  interpolate,
  speedProfileKmh,
  timeOf,
  totalDistanceMeters,
} from '../../core/map';
import { DeliveryMockApi } from '../delivery/delivery-mock.api';
import { DeliveryStop, DeliveryTrip } from '../delivery/delivery.models';
import { FleetAlert, buildTripAlerts, lateMinutesOf } from '../delivery/alerts.util';

/** Nhịp đồng hồ mô phỏng (ms thực tế giữa 2 lần cập nhật). */
const TICK_MS = 1000;

/** Hệ số tua nhanh — 1 giây thật = ngần này phút mô phỏng. */
export const CLOCK_SPEEDS = [0, 1, 5, 15, 60] as const;
export type ClockSpeed = (typeof CLOCK_SPEEDS)[number];

export type VehicleStatus = 'running' | 'stopped' | 'finished' | 'notstarted';

export const VEHICLE_STATUS_LABEL: Record<VehicleStatus, string> = {
  running: 'Đang chạy',
  stopped: 'Đang dừng',
  finished: 'Đã xong tuyến',
  notstarted: 'Chưa xuất phát',
};

/** Trạng thái tức thời của một xe tại thời điểm đồng hồ đang chỉ. */
export interface VehicleState {
  trip: DeliveryTrip;
  position: LatLng;
  /** Chỉ số điểm GPS ngay trước vị trí nội suy. */
  index: number;
  status: VehicleStatus;
  speedKmh: number;
  /** Tỉ lệ hoàn thành quãng đường GPS (0..1). */
  progress: number;
  /** Khoảng cách tới lộ trình dự kiến ngay lúc này (mét). */
  deviationMeters: number;
  deliveredCount: number;
  totalStops: number;
  lateCount: number;
  /** Điểm giao kế tiếp chưa xử lý. */
  nextStop: DeliveryStop | null;
  batteryPercent: number;
  lastFixIso: string;
}

/** Số liệu tổng của cả đội. */
export interface FleetKpi {
  vehicles: number;
  running: number;
  stopped: number;
  finished: number;
  totalStops: number;
  deliveredStops: number;
  failedStops: number;
  lateStops: number;
  /** Tỉ lệ giao đúng hạn trên các điểm ĐÃ xử lý (0..1). */
  onTimeRate: number;
  distanceMeters: number;
  collectedAmount: number;
  pendingAmount: number;
  highAlerts: number;
}

/**
 * ============== STATE BẢNG ĐIỀU HÀNH ĐỘI XE ==============
 *
 * Đây là màn hình "phòng điều độ": xem CẢ ĐỘI cùng lúc, không đi sâu vào một
 * chuyến. Khác hẳn màn Giám sát (một chuyến, có tua lại, có sửa tuyến).
 *
 * ĐIỂM KHÁC BIỆT KỸ THUẬT QUAN TRỌNG NHẤT — CÁCH XÁC ĐỊNH VỊ TRÍ XE:
 *
 * Màn Giám sát định vị xe bằng **chỉ số mảng** (`track[cursor]`) vì nó tua lại
 * lịch sử theo từng bản ghi GPS. Ở đây thì không được: ba chuyến có số điểm GPS
 * khác nhau, giờ xuất phát khác nhau, nhịp lấy mẫu khác nhau. Lấy chỉ số thứ 50
 * của cả ba xe là so sánh ba mốc thời gian hoàn toàn khác nhau — bảng điều hành
 * sẽ hiển thị một hiện thực không tồn tại.
 *
 * Nên ở đây định vị bằng **ĐỒNG HỒ CHUNG**: có một mốc thời gian duy nhất cho cả
 * đội, mỗi xe tự tra xem tại thời điểm đó nó đang ở đâu (nội suy giữa hai bản ghi
 * GPS gần nhất). Đó cũng đúng là cách hệ thống thật hoạt động — server nhận log
 * rời rạc từ nhiều thiết bị, màn hình dựng lại trạng thái tại một thời điểm.
 */
@Injectable()
export class FleetStore {
  private readonly api = inject(DeliveryMockApi);
  private readonly config = inject(MAP_ROUTING_CONFIG);
  private readonly destroyRef = inject(DestroyRef);

  // -------------------------------------------------------------- tải dữ liệu

  private readonly tripsResource = resource({
    loader: async () => {
      const trips = await this.api.getAllTrips();

      const planned = new Map<string, LatLng[]>();
      for (const trip of trips) planned.set(trip.id, await this.api.getPlannedPath(trip.id));

      return { trips, planned };
    },
  });

  readonly loading = computed(() => this.tripsResource.isLoading());
  readonly trips = computed<DeliveryTrip[]>(() => this.tripsResource.value()?.trips ?? []);

  private readonly plannedPaths = computed<Map<string, LatLng[]>>(
    () => this.tripsResource.value()?.planned ?? new Map(),
  );

  /**
   * GPS đã làm sạch của từng chuyến — tính MỘT LẦN, dùng lại ở mọi nơi.
   *
   * Cực kỳ quan trọng về hiệu năng: `cleanTrack` chạy O(n) trên vài trăm điểm,
   * không nặng, nhưng nếu để nó nằm trong một computed phụ thuộc vào đồng hồ thì
   * nó chạy lại MỖI GIÂY cho cả ba xe. Tách riêng ở đây để nó chỉ phụ thuộc vào
   * dữ liệu chuyến.
   */
  private readonly cleanedTracks = computed<Map<string, CleanResult>>(() => {
    const result = new Map<string, CleanResult>();

    for (const trip of this.trips()) {
      result.set(
        trip.id,
        cleanTrack(trip.track, {
          maxSpeedKmh: this.config.maxPlausibleSpeedKmh,
          gapSeconds: 15 * 60,
        }),
      );
    }

    return result;
  });

  private readonly speedProfiles = computed<Map<string, number[]>>(() => {
    const result = new Map<string, number[]>();
    for (const [id, cleaned] of this.cleanedTracks()) {
      result.set(id, speedProfileKmh(cleaned.points));
    }
    return result;
  });

  // ------------------------------------------------------------ đồng hồ chung

  private readonly _clockMs = signal(0);
  private readonly _speed = signal<ClockSpeed>(5);
  private readonly _selectedTripId = signal<string | null>(null);
  private readonly _focus = signal<LatLng | null>(null);
  private readonly _showPlanned = signal(true);
  private readonly _showTracks = signal(true);
  private readonly _showGeofence = signal(false);
  private readonly _alertFilter = signal<'all' | 'high'>('all');

  readonly clockMs = this._clockMs.asReadonly();
  readonly speed = this._speed.asReadonly();
  readonly selectedTripId = this._selectedTripId.asReadonly();
  readonly focus = this._focus.asReadonly();
  readonly showPlanned = this._showPlanned.asReadonly();
  readonly showTracks = this._showTracks.asReadonly();
  readonly showGeofence = this._showGeofence.asReadonly();
  readonly alertFilter = this._alertFilter.asReadonly();

  readonly clockLabel = computed(() => {
    const ms = this._clockMs();
    if (!ms) return '--:--';
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  });

  /** Khoảng thời gian toàn đội hoạt động — dùng cho thanh trượt thời gian. */
  readonly timeline = computed<{ start: number; end: number }>(() => {
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;

    for (const cleaned of this.cleanedTracks().values()) {
      const points = cleaned.points;
      if (!points.length) continue;

      const first = this.msOf(points[0]);
      const last = this.msOf(points[points.length - 1]);
      if (first) start = Math.min(start, first);
      if (last) end = Math.max(end, last);
    }

    return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : { start: 0, end: 0 };
  });

  constructor() {
    // Dữ liệu tải xong -> đặt đồng hồ ở 72% dòng thời gian, tức là "hiện tại"
    // của ca làm việc: đã có lịch sử để xem, vẫn còn điểm chưa giao.
    effect(() => {
      const { start, end } = this.timeline();
      if (!start || !end || this._clockMs()) return;
      this._clockMs.set(start + (end - start) * 0.72);
    });

    // Đồng hồ chạy. `speed = 0` là tạm dừng -> không tạo interval nào cả.
    effect((onCleanup) => {
      const speed = this._speed();
      if (!speed) return;

      const { end } = this.timeline();

      const timer = setInterval(() => {
        const next = this._clockMs() + speed * 60_000;
        // Chạm cuối dòng thời gian thì dừng lại chứ không quay vòng: quay vòng
        // làm xe đang ở kho đột nhiên nhảy về điểm xuất phát, nhìn như lỗi.
        if (end && next >= end) {
          this._clockMs.set(end);
          this._speed.set(0);
          return;
        }
        this._clockMs.set(next);
      }, TICK_MS);

      onCleanup(() => clearInterval(timer));
    });

    this.destroyRef.onDestroy(() => this._speed.set(0));
  }

  // -------------------------------------------------- trạng thái từng xe

  /**
   * Trạng thái tức thời của cả đội tại mốc `clockMs`.
   *
   * Đây là computed "nóng" nhất màn hình — chạy lại mỗi giây. Vì vậy mọi thứ
   * NẶNG (làm sạch GPS, tính profile tốc độ, định tuyến) đều đã được tính sẵn ở
   * các computed phía trên; ở đây chỉ còn tra cứu nhị phân + nội suy.
   */
  readonly vehicles = computed<VehicleState[]>(() => {
    const clock = this._clockMs();
    const planned = this.plannedPaths();
    const profiles = this.speedProfiles();

    return this.trips().map((trip) => {
      const points = this.cleanedTracks().get(trip.id)?.points ?? [];
      const located = this.locate(points, clock);
      const speeds = profiles.get(trip.id) ?? [];

      const speedKmh = Math.round(speeds[located.index] ?? 0);
      const path = planned.get(trip.id) ?? [];

      // Cùng luật với KPI toàn đội: chỉ đếm những gì ĐÃ xảy ra so với đồng hồ.
      // Nếu không, tua về 08:00 mà thẻ xe vẫn ghi "đã giao 12/12 điểm".
      const handled = trip.stops.filter((s) => this.isHandledAt(s, clock));
      const delivered = handled.filter((s) => s.status === 'delivered');

      return {
        trip,
        position: located.point,
        index: located.index,
        status: located.status,
        speedKmh: located.status === 'running' ? speedKmh : 0,
        progress: located.progress,
        deviationMeters: path.length > 1 ? Math.round(distanceToPathMeters(located.point, path)) : 0,
        deliveredCount: delivered.length,
        totalStops: trip.stops.length,
        lateCount: delivered.filter((s) => lateMinutesOf(s) > 15).length,
        // "Điểm kế tiếp" = điểm đầu tiên CHƯA xử lý tính tới lúc này, theo thứ
        // tự ghé thăm — không phải điểm `pending` đầu tiên của cả ngày.
        nextStop:
          [...trip.stops]
            .sort((a, b) => a.seq - b.seq)
            .find((s) => !this.isHandledAt(s, clock)) ?? null,
        batteryPercent: Math.round(Number(points[located.index]?.battery ?? 0)),
        lastFixIso: timeOf(points[located.index]) ?? '',
      } satisfies VehicleState;
    });
  });

  readonly selectedVehicle = computed<VehicleState | null>(() => {
    const id = this._selectedTripId();
    return this.vehicles().find((v) => v.trip.id === id) ?? null;
  });

  /**
   * Tìm vị trí xe tại một mốc thời gian.
   *
   * Dùng **tìm kiếm nhị phân** thay vì duyệt tuyến tính: hàm này chạy mỗi giây
   * cho mỗi xe, trên track vài trăm điểm. Tuyến tính vẫn chạy được nhưng đây là
   * chỗ duy nhất trong màn hình có vòng lặp theo nhịp đồng hồ, để nó rẻ nhất có thể.
   *
   * Nội suy giữa hai bản ghi để xe TRƯỢT mượt thay vì nhảy cóc từ điểm GPS này
   * sang điểm GPS kia — thiết bị chỉ bắn log mỗi 30–60 giây, nhảy cóc theo đúng
   * dữ liệu thô thì nhìn như xe bị giật.
   */
  private locate(
    points: readonly RoutePoint[],
    clock: number,
  ): { point: LatLng; index: number; progress: number; status: VehicleStatus } {
    if (!points.length) {
      return { point: { lat: 0, lng: 0 }, index: 0, progress: 0, status: 'notstarted' };
    }

    const first = this.msOf(points[0]);
    const last = this.msOf(points[points.length - 1]);

    if (!first || !last || clock <= first) {
      return { point: points[0], index: 0, progress: 0, status: 'notstarted' };
    }

    if (clock >= last) {
      const idx = points.length - 1;
      return { point: points[idx], index: idx, progress: 1, status: 'finished' };
    }

    let lo = 0;
    let hi = points.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((this.msOf(points[mid]) ?? 0) <= clock) lo = mid;
      else hi = mid;
    }

    const t0 = this.msOf(points[lo]) ?? 0;
    const t1 = this.msOf(points[hi]) ?? t0;
    const ratio = t1 > t0 ? (clock - t0) / (t1 - t0) : 0;

    const point = interpolate(points[lo], points[hi], ratio);
    const moved = distanceMeters(points[lo], points[hi]);
    const gapSeconds = (t1 - t0) / 1000;

    return {
      point,
      index: lo,
      progress: (clock - first) / (last - first),
      // Dưới ngưỡng tốc độ tối thiểu -> "đang dừng" (giao hàng, kẹt xe, nghỉ).
      status:
        gapSeconds > 0 && (moved / gapSeconds) * 3.6 >= this.config.idleSpeedKmh
          ? 'running'
          : 'stopped',
    };
  }

  private msOf(point?: RoutePoint | null): number | null {
    const iso = timeOf(point);
    if (!iso) return null;
    const ms = new Date(iso).getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  // ------------------------------------------------------------------- KPI

  /**
   * ================= KPI TÍNH THEO ĐỒNG HỒ, KHÔNG PHẢI THEO CẢ NGÀY =================
   *
   * Bảng điều hành này có một thanh tua thời gian. Tua về 08:00 thì mọi con số
   * phải là "tình hình lúc 08:00" — nếu không, màn hình vừa nói xe đang ở giữa
   * đường, vừa nói đã thu đủ tiền cả ngày và chạy xong toàn bộ km. Bản cũ đúng
   * là như vậy: vị trí xe nội suy theo đồng hồ, còn KPI thì đọc thẳng trạng thái
   * CUỐI CÙNG của chuyến.
   *
   * Luật: một điểm giao chỉ được tính vào KPI khi `actualArrival` ĐÃ XẢY RA so
   * với đồng hồ. Điểm chưa tới giờ vẫn nằm ở nhóm "còn phải giao", đúng như
   * người điều vận nhìn thấy tại thời điểm đó.
   */
  readonly kpi = computed<FleetKpi>(() => {
    const clock = this._clockMs();
    const vehicles = this.vehicles();
    const allStops = this.trips().flatMap((t) => t.stops);

    const handledStops = allStops.filter((s) => this.isHandledAt(s, clock));
    const delivered = handledStops.filter((s) => s.status === 'delivered');
    const failed = handledStops.filter((s) => s.status === 'failed');

    /*
     * ============ ĐÚNG HẸN: TỬ SỐ VÀ MẪU SỐ PHẢI CÙNG MỘT TẬP ============
     *
     * Công thức cũ: `(delivered - late) / (delivered + failed)`, trong đó `late`
     * đếm trên MỌI điểm. Một điểm giao thất bại lúc muộn giờ bị tính hai lần:
     * một lần vào mẫu số (failed), một lần trừ vào tử số (late) — trong khi nó
     * không hề nằm trong `delivered`. Đủ nhiều điểm như vậy là tỉ lệ ra SỐ ÂM.
     *
     * Định nghĩa lại cho khớp tên gọi "tỉ lệ giao đúng hẹn":
     *   số điểm GIAO THÀNH CÔNG và đúng hẹn / số điểm GIAO THÀNH CÔNG.
     * Cùng một tập, luôn nằm trong [0, 1].
     */
    const lateDelivered = delivered.filter((s) => lateMinutesOf(s) > 15);

    return {
      vehicles: vehicles.length,
      running: vehicles.filter((v) => v.status === 'running').length,
      stopped: vehicles.filter((v) => v.status === 'stopped').length,
      finished: vehicles.filter((v) => v.status === 'finished').length,
      totalStops: allStops.length,
      deliveredStops: delivered.length,
      failedStops: failed.length,
      lateStops: lateDelivered.length,
      onTimeRate: delivered.length
        ? (delivered.length - lateDelivered.length) / delivered.length
        : 0,
      // Km đã chạy TỚI đồng hồ, không phải km cả ngày.
      distanceMeters: this.vehicles().reduce(
        (sum, v) => sum + this.travelledMetersAt(v.trip.id, v.index, v.position),
        0,
      ),
      collectedAmount: delivered.reduce((sum, s) => sum + s.amount, 0),
      // Còn phải thu = mọi điểm chưa xử lý tính tới lúc này (kể cả điểm mà cuối
      // ngày mới giao) — đó mới là việc còn lại trước mắt người điều vận.
      pendingAmount: allStops
        .filter((s) => !this.isHandledAt(s, clock))
        .reduce((sum, s) => sum + s.amount, 0),
      highAlerts: this.alerts().filter((a) => a.severity === 'high').length,
    };
  });

  /**
   * Điểm giao này đã được xử lý tính tới mốc `clock` chưa.
   *
   * Không có `actualArrival` (đơn `pending`) thì mãi mãi là chưa xử lý. Có giờ
   * check-in nhưng còn ở tương lai so với đồng hồ thì cũng là chưa — đây chính
   * là chỗ chặn "KPI nhìn thấy tương lai".
   */
  private isHandledAt(stop: DeliveryStop, clock: number): boolean {
    if (stop.status === 'pending' || !stop.actualArrival) return false;
    const at = new Date(stop.actualArrival).getTime();
    return Number.isNaN(at) ? false : at <= clock;
  }

  /** Quãng đường một xe đã chạy tính tới vị trí hiện tại trên đồng hồ. */
  private travelledMetersAt(tripId: string, index: number, position: LatLng): number {
    const points = this.cleanedTracks().get(tripId)?.points ?? [];
    if (points.length < 2) return 0;

    // Cộng trọn các đoạn đã đi qua, rồi cộng nốt phần lẻ tới vị trí nội suy.
    const walked = totalDistanceMeters(points.slice(0, index + 1));
    return walked + distanceMeters(points[index], position);
  }

  // --------------------------------------------------------------- cảnh báo

  /**
   * Cảnh báo của cả đội.
   *
   * KHÔNG phụ thuộc vào đồng hồ: cảnh báo được tính trên TOÀN BỘ track đã có,
   * không phải "những gì đã xảy ra tính tới giây này". Nếu để nó chạy theo đồng
   * hồ thì mỗi giây phải quét lại toàn bộ GPS của cả đội — vừa tốn, vừa làm danh
   * sách nhảy loạn trong lúc người dùng đang đọc.
   */
  readonly alerts = computed<FleetAlert[]>(() => {
    const planned = this.plannedPaths();
    const result: FleetAlert[] = [];

    for (const trip of this.trips()) {
      const cleaned = this.cleanedTracks().get(trip.id);
      if (!cleaned) continue;

      result.push(
        ...buildTripAlerts(trip, cleaned.points, planned.get(trip.id) ?? [], {
          overspeedKmh: this.config.overspeedKmh,
          idleMinutes: this.config.idleMinutes,
          deviationThresholdMeters: this.config.deviationThresholdMeters,
        }),
      );
    }

    const weight = { high: 0, medium: 1, low: 2 } as const;
    return result.sort(
      (a, b) => weight[a.severity] - weight[b.severity] || b.atIso.localeCompare(a.atIso),
    );
  });

  readonly visibleAlerts = computed<FleetAlert[]>(() => {
    const list = this.alerts();
    return this._alertFilter() === 'high' ? list.filter((a) => a.severity === 'high') : list;
  });

  // ------------------------------------------------------- dữ liệu cho bản đồ

  readonly vehicleMarkers = computed<MapMarker[]>(() =>
    this.vehicles().map((v) => ({
      key: v.trip.id,
      lat: v.position.lat,
      lng: v.position.lng,
      label: v.status === 'finished' ? '🏁' : v.status === 'stopped' ? '⏸' : '🚚',
      title: `${v.trip.vehiclePlate} — ${v.trip.driverName}`,
      description: [
        `Chuyến ${v.trip.code}`,
        `${VEHICLE_STATUS_LABEL[v.status]} · ${v.speedKmh} km/h`,
        `Đã giao ${v.deliveredCount}/${v.totalStops} điểm`,
        v.nextStop ? `Điểm kế tiếp: ${v.nextStop.customerName}` : 'Không còn điểm chờ',
        `Cập nhật ${formatTimeLabel(v.lastFixIso)}`,
      ].join('<br/>'),
      color: this.statusColor(v.status),
      active: v.trip.id === this._selectedTripId(),
    })),
  );

  /** Điểm giao của chuyến ĐANG CHỌN. Vẽ hết cả đội thì bản đồ thành rừng marker. */
  readonly markers = computed<MapMarker[]>(() => {
    const selected = this.selectedVehicle();

    // Chưa chọn xe nào -> chỉ hiện kho, đủ để định vị vùng hoạt động.
    if (!selected) {
      const depots = new Map<string, MapMarker>();
      for (const trip of this.trips()) {
        depots.set(trip.depot.name, {
          key: `depot-${trip.depot.name}`,
          lat: trip.depot.lat,
          lng: trip.depot.lng,
          label: '⌂',
          title: trip.depot.name,
          description: trip.depot.address,
          color: '#0f172a',
        });
      }
      return [...depots.values()];
    }

    const trip = selected.trip;
    return [
      {
        key: `depot-${trip.id}`,
        lat: trip.depot.lat,
        lng: trip.depot.lng,
        label: '⌂',
        title: trip.depot.name,
        description: trip.depot.address,
        color: '#0f172a',
      },
      ...trip.stops.map((stop) => ({
        key: stop.id,
        lat: stop.lat,
        lng: stop.lng,
        label: String(stop.seq),
        title: `${stop.seq}. ${stop.customerName}`,
        description: [
          stop.address,
          `Đơn ${stop.orderCode}`,
          stop.actualArrival
            ? `Tới lúc ${formatTimeLabel(stop.actualArrival)}`
            : `Kế hoạch ${formatTimeLabel(stop.plannedArrival)}`,
        ].join('<br/>'),
        color: this.stopColor(stop),
      })),
    ];
  });

  readonly paths = computed<MapPath[]>(() => {
    const result: MapPath[] = [];
    const selectedId = this._selectedTripId();

    for (const trip of this.trips()) {
      const isSelected = trip.id === selectedId;
      // Chọn một xe -> làm mờ các xe khác thay vì ẩn hẳn, để vẫn thấy bối cảnh
      // cả đội đang ở đâu.
      const dim = selectedId && !isSelected;

      if (this._showPlanned()) {
        const planned = this.plannedPaths().get(trip.id) ?? [];
        if (planned.length > 1) {
          result.push({
            key: `planned-${trip.id}`,
            points: planned,
            color: MAP_COLORS.expected,
            weight: isSelected ? 4 : 2,
            opacity: dim ? 0.15 : 0.7,
            dashed: true,
          });
        }
      }

      if (this._showTracks()) {
        const travelled = this.travelledOf(trip.id);
        if (travelled.length > 1) {
          result.push({
            key: `track-${trip.id}`,
            points: travelled,
            color: MAP_COLORS.real,
            weight: isSelected ? 5 : 3,
            opacity: dim ? 0.2 : 0.9,
          });
        }
      }
    }

    return result;
  });

  /** Geofence quanh các điểm giao của chuyến đang chọn. */
  readonly circles = computed<MapCircle[]>(() => {
    if (!this._showGeofence()) return [];

    const selected = this.selectedVehicle();
    if (!selected) return [];

    return selected.trip.stops.map((stop) => ({
      key: `fence-${stop.id}`,
      center: { lat: stop.lat, lng: stop.lng },
      radiusMeters: this.config.geofenceRadiusMeters,
      color: this.stopColor(stop),
      fillOpacity: 0.06,
      dashed: true,
      title: `${stop.customerName} — bán kính ${this.config.geofenceRadiusMeters} m`,
    }));
  });

  readonly fitToken = computed(() => `${this._selectedTripId() ?? 'all'}-${this.trips().length}`);

  /**
   * Phần track đã đi TÍNH TỚI mốc đồng hồ.
   *
   * Cache theo `tripId + index` để không cắt lại mảng mỗi giây khi xe vẫn nằm
   * giữa hai bản ghi GPS cũ — `slice` trả mảng mới mỗi lần gọi, mà component bản
   * đồ lại so sánh THAM CHIẾU để quyết định có vẽ lại polyline hay không.
   * Không cache thì mỗi giây cả 3 đường bị dựng lại từ đầu.
   */
  private readonly travelledCache = new Map<string, { index: number; points: LatLng[] }>();

  private travelledOf(tripId: string): LatLng[] {
    const points = this.cleanedTracks().get(tripId)?.points ?? [];
    const state = this.vehicles().find((v) => v.trip.id === tripId);
    const index = state?.index ?? 0;

    const cached = this.travelledCache.get(tripId);
    if (cached && cached.index === index) return cached.points;

    const slice = points.slice(0, index + 1).map((p) => ({ lat: p.lat, lng: p.lng }));
    this.travelledCache.set(tripId, { index, points: slice });
    return slice;
  }

  private statusColor(status: VehicleStatus): string {
    switch (status) {
      case 'running':
        return MAP_COLORS.done;
      case 'stopped':
        return MAP_COLORS.late;
      case 'finished':
        return '#0f172a';
      default:
        return MAP_COLORS.pending;
    }
  }

  stopColor(stop: DeliveryStop): string {
    if (stop.status === 'failed') return MAP_COLORS.deviation;
    if (stop.status === 'pending') return MAP_COLORS.pending;
    return lateMinutesOf(stop) > 15 ? MAP_COLORS.late : MAP_COLORS.done;
  }

  // ------------------------------------------------------------------- lệnh

  selectTrip(id: string | null): void {
    this._selectedTripId.set(id);

    const vehicle = this.vehicles().find((v) => v.trip.id === id);
    this._focus.set(vehicle ? { ...vehicle.position } : null);
  }

  setSpeed(speed: ClockSpeed): void {
    this._speed.set(speed);
  }

  seek(ms: number): void {
    this._clockMs.set(ms);
  }

  /** Nhảy tới cuối dòng thời gian — nút "về hiện tại" của bảng điều hành. */
  jumpToNow(): void {
    this._clockMs.set(this.timeline().end);
    this._speed.set(0);
  }

  togglePlanned(): void {
    this._showPlanned.update((v) => !v);
  }

  toggleTracks(): void {
    this._showTracks.update((v) => !v);
  }

  toggleGeofence(): void {
    this._showGeofence.update((v) => !v);
  }

  setAlertFilter(filter: 'all' | 'high'): void {
    this._alertFilter.set(filter);
  }

  focusAlert(alert: FleetAlert): void {
    this._selectedTripId.set(alert.tripId);
    if (alert.location) this._focus.set({ ...alert.location });
  }
}

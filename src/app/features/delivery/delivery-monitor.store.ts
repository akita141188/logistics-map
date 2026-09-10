import { DestroyRef, Injectable, computed, effect, inject, resource, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import {
  CleanResult,
  GeocodeFacade,
  LatLng,
  MAP_COLORS,
  MAP_ROUTING_CONFIG,
  MapCircle,
  MapMarker,
  MapPath,
  MapProviderService,
  MatchResult,
  RouteLeg,
  RoutePoint,
  RoutingFacade,
  StopEvent,
  TrackQuality,
  bestInsertion,
  cleanTrack,
  detectStops,
  distanceMeters,
  distanceToPathMeters,
  formatTimeLabel,
  optimizeWaypointOrder,
  summarizeTrack,
  totalDistanceMeters,
} from '../../core/map';
import { FleetAlert, buildTripAlerts } from './alerts.util';
import { DeliveryMockApi } from './delivery-mock.api';
import {
  DeliveryStop,
  DeliveryTrip,
  EMPTY_DRAFT,
  PlanImpact,
  StopDraft,
  StopEta,
  TripStats,
} from './delivery.models';

/** Tốc độ tua lại hành trình. */
export const PLAYBACK_SPEEDS = [1, 2, 4, 8, 16] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

/** Nhịp cập nhật vị trí xe khi tua (ms). */
const TICK_MS = 220;

/** Thời gian đứng tại mỗi điểm để giao hàng (phút) — dùng khi tính lại ETA. */
export const SERVICE_MINUTES_PER_STOP = 10;

/** Tốc độ trung bình dùng để ước lượng khi dịch vụ định tuyến chết (km/h). */
const FALLBACK_SPEED_KMH = 24;

/** Điểm còn lại bị đẩy lịch quá ngần này phút thì mới coi là "bị ảnh hưởng". */
const SHIFT_ALERT_MINUTES = 5;

/**
 * ============ STATE MÀN GIÁM SÁT LỘ TRÌNH GIAO HÀNG ============
 *
 * Provide ở CẤP ROUTE (`providers: [DeliveryMonitorStore]`), không phải
 * `providedIn: 'root'` — rời màn là state chết theo, không còn timer playback
 * chạy ngầm và không "nhớ" chuyến cũ khi quay lại.
 *
 * Kiến trúc dữ liệu:
 *
 *   tripId ──► tripResource ──► trip GỐC (kế hoạch đầu ngày, KHÔNG bao giờ bị sửa)
 *                                   │
 *                   _stopsOverride ─┴──► trip HIỆN HÀNH (kế hoạch đang áp dụng)
 *                                            │
 *          ┌─────────────────────────────────┼─────────────────────────────┐
 *          ▼                                 ▼                             ▼
 *   plannedResource                  remainingResource              baselineResource
 *   (cả tuyến, để vẽ &               (từ vị trí xe hiện tại →       (chỉ chạy khi có
 *    tính lệch tuyến)                 các điểm còn lại → kho,        sửa tuyến, để đo
 *                                     để tính ETA từng điểm)         phần đội thêm)
 *
 * ĐIỂM MẤU CHỐT CỦA TÍNH NĂNG "THÊM ĐIỂM GIAO":
 * Sửa `_stopsOverride` là XONG. Không có một dòng lệnh nào gọi "vẽ lại bản đồ",
 * "tính lại KPI" hay "cập nhật cảnh báo" — toàn bộ chuỗi
 * `tuyến → đường vẽ → độ lệch → KPI → ETA → cảnh báo` đều là `computed`/`resource`
 * treo trên cùng một signal, nên tự chạy lại theo đúng thứ tự phụ thuộc.
 *
 * BA THỨ TUYỆT ĐỐI KHÔNG ĐƯỢC ĐỘNG VÀO KHI SỬA TUYẾN:
 *  1. `track` (GPS đã bắn về)   — quá khứ đã xảy ra, không sửa được.
 *  2. Các điểm đã giao/thất bại — đã có `actualArrival`, sửa là làm giả số liệu.
 *  3. `plannedArrival` gốc      — phải giữ để còn đối chiếu "trễ hơn kế hoạch".
 */
@Injectable()
export class DeliveryMonitorStore {
  private readonly api = inject(DeliveryMockApi);
  private readonly routing = inject(RoutingFacade);
  private readonly geocode = inject(GeocodeFacade);
  private readonly mapProvider = inject(MapProviderService);
  private readonly config = inject(MAP_ROUTING_CONFIG);
  private readonly destroyRef = inject(DestroyRef);

  readonly trips = this.api.listTrips();

  private readonly _tripId = signal(this.trips[0].id);

  /**
   * Mở đúng chuyến được chỉ định qua `?trip=...`.
   *
   * Dùng để bấm "Mở giám sát chi tiết" từ bảng điều hành đội xe mà vẫn giữ được
   * đường dẫn chia sẻ được (copy URL gửi cho người khác là họ thấy đúng chuyến).
   * Bỏ qua giá trị lạ thay vì báo lỗi — URL do người dùng gõ tay không đáng tin.
   */
  applyTripFromRoute(tripId: string | null | undefined): void {
    if (!tripId) return;
    if (!this.trips.some((t) => t.id === tripId)) return;
    this._tripId.set(tripId);
  }
  private readonly _selectedStopId = signal<string | null>(null);
  private readonly _showPlanned = signal(true);
  private readonly _showActual = signal(true);
  private readonly _showGpsPoints = signal(false);
  private readonly _showRemaining = signal(true);
  private readonly _focus = signal<LatLng | null>(null);

  readonly tripId = this._tripId.asReadonly();
  readonly selectedStopId = this._selectedStopId.asReadonly();
  readonly showPlanned = this._showPlanned.asReadonly();
  readonly showActual = this._showActual.asReadonly();
  readonly showGpsPoints = this._showGpsPoints.asReadonly();
  readonly showRemaining = this._showRemaining.asReadonly();
  readonly focus = this._focus.asReadonly();

  // ------------------------------------------------------------- tải dữ liệu

  private readonly tripResource = resource({
    params: () => ({ id: this._tripId() }),
    loader: ({ params }) => this.api.getTrip(params.id),
  });

  /** Kế hoạch GỐC do hệ thống lập đầu ngày — chỉ đọc, dùng để đối chiếu. */
  readonly originalTrip = computed<DeliveryTrip | undefined>(() => this.tripResource.value());

  /**
   * Danh sách điểm giao sau khi điều phối viên can thiệp.
   * `null` = chưa ai sửa gì, dùng nguyên kế hoạch gốc.
   */
  private readonly _stopsOverride = signal<DeliveryStop[] | null>(null);

  /** Chuyến đang hiển thị = kế hoạch gốc + phần đã sửa. */
  readonly trip = computed<DeliveryTrip | undefined>(() => {
    const base = this.originalTrip();
    if (!base) return undefined;

    const override = this._stopsOverride();
    return override ? { ...base, stops: override } : base;
  });

  readonly loadingTrip = computed(() => this.tripResource.isLoading());

  readonly hasEdits = computed(() => this._stopsOverride() !== null);

  /**
   * Lộ trình DỰ KIẾN — phải gọi dịch vụ định tuyến mới ra đường bám phố.
   * `params` có cả `provider`: đổi nhà cung cấp bản đồ thì tự tính lại bằng
   * dịch vụ định tuyến tương ứng.
   */
  private readonly plannedResource = resource({
    params: () => {
      const trip = this.trip();
      if (!trip) return undefined;
      return { trip, provider: this.mapProvider.provider() };
    },
    loader: async ({ params }) => {
      const waypoints = this.api.buildPlannedWaypoints(params.trip);
      const result = await this.routing.computeRoute({
        points: waypoints,
        travelMode: 'driving',
      });
      return {
        path: result.path.length > 1 ? result.path : waypoints,
        distanceMeters: result.distanceMeters,
        durationSeconds: result.durationSeconds ?? 0,
      };
    },
  });

  // `hasValue()` trước `value()`: `resource.value()` NÉM LẠI LỖI khi loader hỏng,
  // nên đọc thẳng là kéo sập cả màn hình thay vì hiện thông báo lỗi.
  readonly plannedPath = computed<LatLng[]>(() =>
    this.plannedResource.hasValue() ? (this.plannedResource.value()?.path ?? []) : [],
  );
  readonly loadingPlanned = computed(() => this.plannedResource.isLoading());
  readonly routingError = computed(() => {
    const err = this.plannedResource.error();
    return err ? (err as Error).message : null;
  });

  /**
   * Kế hoạch GỐC, định tuyến lại để so sánh.
   *
   * `params` trả `undefined` khi chưa ai sửa gì -> resource nằm im, KHÔNG tốn
   * thêm một request nào cho trường hợp thường gặp nhất (chỉ xem, không sửa).
   */
  private readonly baselineResource = resource({
    params: () => {
      const original = this.originalTrip();
      if (!original || !this.hasEdits()) return undefined;
      return { trip: original, provider: this.mapProvider.provider() };
    },
    loader: async ({ params }) => {
      const result = await this.routing.computeRoute({
        points: this.api.buildPlannedWaypoints(params.trip),
        travelMode: 'driving',
      });
      return {
        distanceMeters: result.distanceMeters,
        durationSeconds: result.durationSeconds ?? 0,
      };
    },
  });

  // ============================================================================
  //                      LÀM SẠCH GPS — nền của mọi con số
  // ============================================================================

  /** GPS THÔ đúng như thiết bị bắn về. Chỉ dùng để so sánh, không dùng để tính. */
  readonly rawTrack = computed<RoutePoint[]>(() => this.trip()?.track ?? []);

  /**
   * GPS đã lọc nhiễu.
   *
   * VÌ SAO PHẢI LÀM TRƯỚC MỌI THỨ KHÁC: quãng đường thực tế được cộng dồn từ
   * khoảng cách giữa các điểm liên tiếp. Nhiễu khi xe đứng yên (toạ độ lang thang
   * trong bán kính 10 m) và điểm nhảy cóc lúc mất sóng đều bị cộng vào như thể xe
   * đã chạy thật. Với một chuyến 40 km, phần "đường ma" này thường 2–5 km.
   *
   * Nếu doanh nghiệp trả lương/khoán xăng theo số km này thì đó là tiền thật —
   * nên đây không phải chi tiết kỹ thuật, mà là yêu cầu nghiệp vụ.
   */
  private readonly cleaned = computed<CleanResult>(() =>
    cleanTrack(this.rawTrack(), {
      maxSpeedKmh: this.config.maxPlausibleSpeedKmh,
      minSpacingMeters: 8,
      gapSeconds: 15 * 60,
    }),
  );

  /** Chất lượng dữ liệu GPS — hiển thị để người dùng biết số liệu đáng tin tới đâu. */
  readonly trackQuality = computed<TrackQuality>(() =>
    summarizeTrack(this.rawTrack(), this.cleaned()),
  );

  /** Quãng đường tính trên GPS THÔ — chỉ để cho thấy phần chênh do nhiễu. */
  readonly rawDistanceMeters = computed(() =>
    totalDistanceMeters(this.rawTrack().map((p) => ({ lat: p.lat, lng: p.lng }))),
  );

  // ------------------------------------------------- phân vùng quá khứ / tương lai

  /** Track dùng cho MỌI tính toán và hiển thị — luôn là bản đã làm sạch. */
  readonly track = computed(() => this.cleaned().points);
  readonly trackLength = computed(() => this.track().length);

  /** Vị trí GPS MỚI NHẤT của xe — mốc để tính mọi thứ thuộc về tương lai. */
  readonly lastPoint = computed(() => this.track()[this.trackLength() - 1] ?? null);

  /**
   * Số điểm đầu danh sách đã bị KHOÁ (đã giao hoặc đã giao hỏng).
   * Không được xoá, không được đổi thứ tự, không được chèn điểm mới lên trước —
   * xe đã đi qua rồi, sửa là bịa lại lịch sử.
   */
  readonly lockedCount = computed(() => {
    const stops = this.trip()?.stops ?? [];
    let locked = 0;
    stops.forEach((stop, i) => {
      if (stop.actualArrival) locked = i + 1;
    });
    return locked;
  });

  /** Các điểm chưa tới — phần DUY NHẤT được phép can thiệp. */
  readonly pendingStops = computed(() => (this.trip()?.stops ?? []).slice(this.lockedCount()));

  canEditStop(stop: DeliveryStop): boolean {
    return !stop.actualArrival;
  }

  // ----------------------------------------------- chặng còn lại & ETA từng điểm

  /**
   * Định tuyến CHẶNG CÒN LẠI: từ vị trí GPS mới nhất -> các điểm chưa giao -> về kho.
   *
   * VÌ SAO KHÔNG DÙNG `currentPoint()` (con trỏ tua) LÀM ĐIỂM ĐẦU:
   * `currentPoint` đổi mỗi 220ms khi bấm play -> mỗi tick là một request định
   * tuyến, vừa spam server vừa làm ETA nhảy loạn. Chặng còn lại là chuyện của
   * hiện tại, phải tính từ vị trí thật mới nhất chứ không phải từ chỗ người dùng
   * đang kéo thanh trượt tới.
   */
  private readonly remainingResource = resource({
    params: () => {
      const trip = this.trip();
      const from = this.lastPoint();
      const pending = this.pendingStops();
      if (!trip || !from || !pending.length) return undefined;

      return {
        origin: { lat: from.lat, lng: from.lng },
        stops: pending.map((s) => ({ lat: s.lat, lng: s.lng })),
        depot: { lat: trip.depot.lat, lng: trip.depot.lng },
        provider: this.mapProvider.provider(),
      };
    },
    loader: ({ params }) =>
      this.routing.computeRoute({
        points: [params.origin, ...params.stops, params.depot],
        travelMode: 'driving',
      }),
  });

  readonly remainingPath = computed<LatLng[]>(() =>
    this.remainingResource.hasValue() ? (this.remainingResource.value()?.path ?? []) : [],
  );
  readonly loadingRemaining = computed(() => this.remainingResource.isLoading());

  /**
   * Thời gian từng chặng của phần còn lại.
   * Dịch vụ định tuyến chết hoặc trả thiếu leg -> ước lượng bằng đường chim bay
   * chia cho tốc độ trung bình, để màn hình vẫn có số chứ không hiện "—".
   */
  private readonly remainingLegs = computed<RouteLeg[]>(() => {
    const trip = this.trip();
    const from = this.lastPoint();
    const pending = this.pendingStops();
    if (!trip || !from || !pending.length) return [];

    const waypoints: LatLng[] = [
      { lat: from.lat, lng: from.lng },
      ...pending.map((s) => ({ lat: s.lat, lng: s.lng })),
      { lat: trip.depot.lat, lng: trip.depot.lng },
    ];

    const legs = this.remainingResource.hasValue() ? (this.remainingResource.value()?.legs ?? []) : [];

    return waypoints.slice(1).map((to, i) => {
      const real = legs[i];
      if (real?.durationSeconds) return real;

      const meters = distanceMeters(waypoints[i], to);
      return { distanceMeters: meters, durationSeconds: meters / ((FALLBACK_SPEED_KMH * 1000) / 3600) };
    });
  });

  /**
   * ETA của từng điểm chưa giao, tính lại theo tuyến HIỆN HÀNH.
   * Đây là con số đổi ngay khi chèn thêm điểm — thứ mà điều phối viên cần thấy
   * để quyết định có nhận đơn phát sinh hay không.
   */
  readonly etaByStop = computed<Map<string, StopEta>>(() => {
    const result = new Map<string, StopEta>();
    const pending = this.pendingStops();
    const from = this.lastPoint();
    if (!pending.length || !from) return result;

    const legs = this.remainingLegs();
    const serviceMs = SERVICE_MINUTES_PER_STOP * 60_000;

    // GPS thiếu/hỏng `createDate` -> `new Date(...).getTime()` ra NaN, và
    // `new Date(NaN).toISOString()` NÉM RangeError làm chết cả computed.
    // Rơi về "bây giờ" để màn hình vẫn có số thay vì trắng bảng.
    const startedAt = new Date(from.createDate ?? Date.now()).getTime();
    let clock = Number.isNaN(startedAt) ? Date.now() : startedAt;

    pending.forEach((stop, i) => {
      clock += (legs[i]?.durationSeconds ?? 0) * 1000;

      const eta = new Date(clock).toISOString();
      // Điểm phát sinh không có kế hoạch gốc -> không có gì để so, độ lệch = 0.
      const plannedAt = stop.plannedArrival ? new Date(stop.plannedArrival).getTime() : NaN;
      const shiftMinutes =
        stop.isAdHoc || Number.isNaN(plannedAt) ? 0 : Math.round((clock - plannedAt) / 60_000);

      result.set(stop.id, { stopId: stop.id, eta, shiftMinutes });

      // Đứng lại giao hàng rồi mới đi tiếp.
      clock += serviceMs;
    });

    return result;
  });

  /** Giờ dự kiến xe về tới kho. */
  readonly backToDepotEta = computed(() => {
    const pending = this.pendingStops();
    const from = this.lastPoint();
    if (!from) return '';

    const legs = this.remainingLegs();
    if (!pending.length) return '';

    const last = this.etaByStop().get(pending[pending.length - 1].id);
    if (!last) return '';

    const returnLeg = legs[pending.length]?.durationSeconds ?? 0;
    return new Date(
      new Date(last.eta).getTime() + SERVICE_MINUTES_PER_STOP * 60_000 + returnLeg * 1000,
    ).toISOString();
  });

  /** Tổng hợp "sửa tuyến thì mất thêm bao nhiêu". */
  readonly impact = computed<PlanImpact>(() => {
    const original = this.originalTrip();
    const current = this.trip();
    const baseline = this.baselineResource.hasValue() ? this.baselineResource.value() : undefined;
    const planned = this.plannedResource.hasValue() ? this.plannedResource.value() : undefined;
    const etas = this.etaByStop();

    const shifts = [...etas.values()].map((e) => e.shiftMinutes);

    return {
      changed: this.hasEdits(),
      addedStops: (current?.stops ?? []).filter((s) => s.isAdHoc).length,
      removedStops: Math.max(
        0,
        (original?.stops ?? []).filter(
          (o) => !(current?.stops ?? []).some((c) => c.id === o.id),
        ).length,
      ),
      extraDistanceMeters:
        baseline && planned ? planned.distanceMeters - baseline.distanceMeters : 0,
      extraDurationSeconds:
        baseline && planned ? planned.durationSeconds - baseline.durationSeconds : 0,
      shiftedStops: shifts.filter((m) => m > SHIFT_ALERT_MINUTES).length,
      maxShiftMinutes: shifts.length ? Math.max(...shifts) : 0,
      backToDepotEta: this.backToDepotEta(),
    };
  });

  // ------------------------------------------------------ form thêm điểm giao

  private readonly _formOpen = signal(false);
  private readonly _draft = signal<StopDraft>({ ...EMPTY_DRAFT });
  private readonly _pickMode = signal(false);
  private readonly _query = signal('');
  private readonly _debouncedQuery = signal('');

  readonly formOpen = this._formOpen.asReadonly();
  readonly draft = this._draft.asReadonly();
  readonly pickMode = this._pickMode.asReadonly();
  readonly query = this._query.asReadonly();

  readonly searchResults = rxResource({
    params: () => ({ term: this._debouncedQuery(), provider: this.mapProvider.provider() }),
    stream: ({ params }) => (params.term.length < 3 ? of([]) : this.geocode.search(params.term)),
  });

  readonly geocodeProviderLabel = computed(() => {
    this.mapProvider.provider();
    return this.geocode.providerLabel();
  });

  readonly canSubmitDraft = computed(() => {
    const draft = this._draft();
    return !!draft.point && draft.customerName.trim().length > 1;
  });

  /**
   * Xem trước: nếu chèn điểm đang nhập thì tuyến đội thêm bao nhiêu km.
   * Tính bằng đường chim bay (không gọi mạng) — người dùng đang gõ dở, gọi định
   * tuyến ở đây là spam server mà cũng không chính xác hơn về mặt quyết định.
   */
  readonly draftPreview = computed(() => {
    const draft = this._draft();
    const trip = this.trip();
    if (!draft.point || !trip) return null;

    const anchors = this.insertionAnchors();
    if (anchors.length < 2) return null;

    const minIndex = 1;
    const best = bestInsertion(anchors, draft.point, minIndex);

    // `anchors[0]` là vị trí xe, nên khe thứ i tương ứng điểm pending thứ i-1.
    const stopIndex = this.lockedCount() + best.index - 1;
    const target = this.trip()?.stops[stopIndex];

    return {
      extraMeters: best.extraMeters,
      /** Chèn vào TRƯỚC điểm nào (undefined = chèn cuối, ngay trước khi về kho). */
      beforeStop: target,
      stopIndex,
    };
  });

  /**
   * Chuỗi mốc để tính chỗ chèn: [vị trí xe hiện tại, ...các điểm chưa giao, kho].
   * KHÔNG lấy từ kho như lộ trình dự kiến — xe đang ở giữa đường rồi, chèn điểm
   * phải rẻ nhất tính từ CHỖ XE ĐANG ĐỨNG.
   */
  private readonly insertionAnchors = computed<LatLng[]>(() => {
    const trip = this.trip();
    const from = this.lastPoint();
    if (!trip) return [];

    const head: LatLng = from
      ? { lat: from.lat, lng: from.lng }
      : { lat: trip.depot.lat, lng: trip.depot.lng };

    return [
      head,
      ...this.pendingStops().map((s) => ({ lat: s.lat, lng: s.lng })),
      { lat: trip.depot.lat, lng: trip.depot.lng },
    ];
  });

  // ---------------------------------------------------------------- playback

  private readonly _cursor = signal(0);
  private readonly _playing = signal(false);
  private readonly _speed = signal<PlaybackSpeed>(4);

  readonly cursor = this._cursor.asReadonly();
  readonly playing = this._playing.asReadonly();
  readonly speed = this._speed.asReadonly();

  /** Điểm GPS đang đứng ở vị trí con trỏ tua. */
  readonly currentPoint = computed(() => this.track()[this._cursor()] ?? null);

  readonly currentTime = computed(() => formatTimeLabel(this.currentPoint()?.createDate));

  constructor() {
    // Đổi chuyến -> tua lại từ đầu, dừng, và VỨT BỎ mọi chỉnh sửa của chuyến cũ.
    effect(() => {
      this._tripId();
      this._cursor.set(0);
      this._playing.set(false);
      this._selectedStopId.set(null);
      this._stopsOverride.set(null);
      // Kết quả khớp đường thuộc về track của chuyến CŨ. Giữ lại là vẽ đường của
      // xe khác lên bản đồ chuyến mới — sai nghiêm trọng mà nhìn rất hợp lý.
      this._matchResult.set(null);
      this._matchProgress.set(0);
      this.closeForm();
    });

    // Dữ liệu tải xong -> nhảy thẳng tới vị trí mới nhất (đúng như bảng điều
    // khiển thật: mở lên là thấy xe đang ở đâu, muốn xem lại thì mới tua).
    effect(() => {
      const len = this.trackLength();
      if (len) this._cursor.set(len - 1);
    });

    // Bộ đếm playback. Đặt trong effect để tự dọn khi component destroy.
    effect((onCleanup) => {
      if (!this._playing()) return;

      const stepsPerTick = this._speed();
      const timer = setInterval(() => {
        const next = this._cursor() + stepsPerTick;
        if (next >= this.trackLength() - 1) {
          this._cursor.set(Math.max(0, this.trackLength() - 1));
          this._playing.set(false);
          return;
        }
        this._cursor.set(next);
      }, TICK_MS);

      onCleanup(() => clearInterval(timer));
    });

    // Debounce ô tìm địa chỉ 400ms — Nominatim chặn ở 1 request/giây.
    effect((onCleanup) => {
      const value = this._query();
      const timer = setTimeout(() => this._debouncedQuery.set(value), 400);
      onCleanup(() => clearTimeout(timer));
    });

    this.destroyRef.onDestroy(() => this._playing.set(false));
  }

  // ------------------------------------------------------------ lệnh: xem

  selectTrip(id: string): void {
    this._tripId.set(id);
  }

  selectStop(id: string | null): void {
    this._selectedStopId.set(id);

    const stop = this.trip()?.stops.find((s) => s.id === id);
    // Tạo object mới mỗi lần để signal luôn báo đổi, kể cả khi chọn lại đúng điểm cũ.
    this._focus.set(stop ? { lat: stop.lat, lng: stop.lng } : null);
  }

  togglePlanned(): void {
    this._showPlanned.update((v) => !v);
  }

  toggleActual(): void {
    this._showActual.update((v) => !v);
  }

  toggleGpsPoints(): void {
    this._showGpsPoints.update((v) => !v);
  }

  toggleRemaining(): void {
    this._showRemaining.update((v) => !v);
  }

  play(): void {
    // Đang ở cuối mà bấm play -> tua lại từ đầu.
    if (this._cursor() >= this.trackLength() - 1) this._cursor.set(0);
    this._playing.set(true);
  }

  pause(): void {
    this._playing.set(false);
  }

  togglePlay(): void {
    this._playing() ? this.pause() : this.play();
  }

  seek(index: number): void {
    this._cursor.set(Math.min(Math.max(index, 0), Math.max(0, this.trackLength() - 1)));
  }

  setSpeed(speed: PlaybackSpeed): void {
    this._speed.set(speed);
  }

  // ------------------------------------------------------- lệnh: sửa tuyến

  openForm(): void {
    this._formOpen.set(true);
  }

  closeForm(): void {
    this._formOpen.set(false);
    this._pickMode.set(false);
    this._draft.set({ ...EMPTY_DRAFT });
    this._query.set('');
    this._debouncedQuery.set('');
  }

  toggleForm(): void {
    this._formOpen() ? this.closeForm() : this.openForm();
  }

  setQuery(value: string): void {
    this._query.set(value);
  }

  patchDraft(patch: Partial<StopDraft>): void {
    this._draft.update((d) => ({ ...d, ...patch }));
  }

  togglePickMode(): void {
    this._formOpen.set(true);
    this._pickMode.update((v) => !v);
  }

  /** Chọn điểm từ kết quả tìm địa chỉ. */
  pickFromSearch(point: LatLng, shortName: string, displayName: string): void {
    this._draft.update((d) => ({
      ...d,
      point: { lat: point.lat, lng: point.lng },
      address: displayName,
      customerName: d.customerName || shortName,
    }));
    this._query.set('');
    this._debouncedQuery.set('');
    this._focus.set({ lat: point.lat, lng: point.lng });
  }

  /**
   * Chọn điểm bằng cách bấm lên bản đồ.
   * Toạ độ có ngay, địa chỉ reverse geocode xong thì vá vào sau — không bắt
   * người dùng chờ mạng mới thấy điểm hiện lên.
   */
  pickFromMap(point: LatLng): void {
    if (!this._pickMode()) return;

    this._draft.update((d) => ({
      ...d,
      point,
      address: `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`,
    }));
    this._pickMode.set(false);

    this.geocode.reverse(point).subscribe((address) => {
      this._draft.update((d) =>
        // Người dùng có thể đã chọn điểm khác trong lúc chờ mạng -> chỉ vá khi
        // vẫn đúng điểm vừa bấm.
        d.point && d.point.lat === point.lat && d.point.lng === point.lng
          ? { ...d, address, customerName: d.customerName || address.split(',')[0] }
          : d,
      );
    });
  }

  /**
   * CHÈN ĐIỂM GIAO MỚI.
   *
   * Sau lệnh này, tự động đổi theo (không cần gọi gì thêm):
   *  - lộ trình dự kiến vẽ trên bản đồ (`plannedResource` chạy lại),
   *  - độ lệch tuyến của toàn bộ GPS đã đi (vì "chuẩn" để so đã đổi),
   *  - quãng đường kế hoạch, chênh lệch so với thực tế (`stats`),
   *  - ETA của mọi điểm phía sau (`remainingResource` + `etaByStop`),
   *  - link chỉ đường Google Maps cho phần còn lại.
   */
  addStop(): void {
    const draft = this._draft();
    const trip = this.trip();
    if (!draft.point || !trip) return;

    const insertAt =
      draft.position === 'auto' ? (this.draftPreview()?.stopIndex ?? trip.stops.length) : draft.position;

    // Chặn cứng: không được chèn vào phần đã đi qua.
    const index = Math.min(Math.max(insertAt, this.lockedCount()), trip.stops.length);

    const stop: DeliveryStop = {
      id: `adhoc-${Date.now()}`,
      seq: 0, // gán lại ở `resequence`
      orderCode: `PS-${String(Date.now()).slice(-5)}`,
      customerName: draft.customerName.trim(),
      address: draft.address || `${draft.point.lat.toFixed(5)}, ${draft.point.lng.toFixed(5)}`,
      lat: draft.point.lat,
      lng: draft.point.lng,
      // Điểm phát sinh KHÔNG có giờ kế hoạch gốc — giờ của nó là ETA tính động,
      // đặt bừa một `plannedArrival` ở đây sẽ đẻ ra số liệu "trễ/sớm" giả.
      plannedArrival: '',
      actualArrival: null,
      status: 'pending',
      amount: Number(draft.amount) || 0,
      note: draft.note.trim() || 'Đơn phát sinh, chèn trong ngày',
      isAdHoc: true,
    };

    const next = [...trip.stops];
    next.splice(index, 0, stop);

    this._stopsOverride.set(this.resequence(next));
    this._selectedStopId.set(stop.id);
    this._focus.set({ lat: stop.lat, lng: stop.lng });
    this.closeForm();
  }

  /** Bỏ một điểm chưa giao khỏi tuyến (khách huỷ đơn, chuyển sang chuyến khác). */
  removeStop(id: string): void {
    const trip = this.trip();
    if (!trip) return;

    const stop = trip.stops.find((s) => s.id === id);
    if (!stop || !this.canEditStop(stop)) return;

    this._stopsOverride.set(this.resequence(trip.stops.filter((s) => s.id !== id)));
    if (this._selectedStopId() === id) this._selectedStopId.set(null);
  }

  /** Đổi thứ tự ghé thăm — chỉ trong phạm vi các điểm chưa giao. */
  moveStop(id: string, direction: -1 | 1): void {
    const trip = this.trip();
    if (!trip) return;

    const stops = trip.stops;
    const index = stops.findIndex((s) => s.id === id);
    const target = index + direction;

    if (index < 0 || target < this.lockedCount() || target >= stops.length) return;
    if (!this.canEditStop(stops[index]) || !this.canEditStop(stops[target])) return;

    const next = [...stops];
    [next[index], next[target]] = [next[target], next[index]];
    this._stopsOverride.set(this.resequence(next));
  }

  /**
   * Sắp xếp lại CÁC ĐIỂM CHƯA GIAO cho tổng đường ngắn nhất.
   * Phần đã giao giữ nguyên tuyệt đối; điểm neo đầu là vị trí xe hiện tại,
   * điểm neo cuối là kho.
   */
  optimizeRemaining(): void {
    const trip = this.trip();
    const from = this.lastPoint();
    if (!trip || this.pendingStops().length < 3) return;

    const head = from
      ? { lat: from.lat, lng: from.lng, id: '__from__' }
      : { lat: trip.depot.lat, lng: trip.depot.lng, id: '__from__' };
    const tail = { lat: trip.depot.lat, lng: trip.depot.lng, id: '__depot__' };

    const ordered = optimizeWaypointOrder([head, ...this.pendingStops(), tail])
      // Bỏ 2 điểm neo, giữ lại đúng các điểm giao theo thứ tự mới.
      .filter((p): p is DeliveryStop => 'orderCode' in p);

    this._stopsOverride.set(
      this.resequence([...trip.stops.slice(0, this.lockedCount()), ...ordered]),
    );
  }

  /** Vứt toàn bộ chỉnh sửa, quay lại kế hoạch đầu ngày. */
  resetPlan(): void {
    this._stopsOverride.set(null);
    this.closeForm();
  }

  /** Đánh số lại `seq` theo đúng thứ tự trong mảng. */
  private resequence(stops: DeliveryStop[]): DeliveryStop[] {
    return stops.map((s, i) => ({ ...s, seq: i + 1 }));
  }

  // ------------------------------------------------------- dữ liệu cho bản đồ

  /** Phần GPS track đã "chạy tới" theo con trỏ tua. */
  readonly travelledPath = computed<LatLng[]>(() =>
    this.track()
      .slice(0, this._cursor() + 1)
      .map((p) => ({ lat: p.lat, lng: p.lng })),
  );

  /**
   * Chỉ số các điểm GPS bị coi là LỆCH TUYẾN.
   * Tính bằng khoảng cách vuông góc từ điểm tới polyline dự kiến — không phải
   * khoảng cách tới điểm gần nhất, vì lộ trình dự kiến có đoạn dài ít điểm.
   *
   * LƯU Ý NGHIỆP VỤ: chèn thêm điểm giao làm polyline dự kiến đổi, nên phần GPS
   * ĐÃ ĐI có thể đột nhiên bị tính là lệch tuyến. Đó không phải lỗi — đúng bản
   * chất: xe đã đi theo kế hoạch cũ, giờ kế hoạch đổi thì nó lệch thật. Muốn
   * chấm điểm tài xế thì phải chấm theo kế hoạch tại thời điểm xe chạy, chứ
   * không phải kế hoạch sau khi điều phối sửa.
   */
  readonly deviationFlags = computed<boolean[]>(() => {
    const planned = this.plannedPath();
    if (planned.length < 2) return this.track().map(() => false);

    const threshold = this.config.deviationThresholdMeters;
    return this.track().map((p) => distanceToPathMeters(p, planned) > threshold);
  });

  /** Các đoạn liên tiếp bị lệch tuyến — tô đỏ đè lên đường xanh. */
  private readonly deviationSegments = computed<LatLng[][]>(() => {
    const flags = this.deviationFlags();
    const path = this.travelledPath();

    const segments: LatLng[][] = [];
    let current: LatLng[] = [];

    for (let i = 0; i < path.length; i++) {
      if (flags[i]) {
        // Nối thêm điểm liền trước để đoạn đỏ dính liền vào đường xanh,
        // không bị hở một khúc trắng ở chỗ bắt đầu lệch.
        if (!current.length && i > 0) current.push(path[i - 1]);
        current.push(path[i]);
      } else if (current.length) {
        current.push(path[i]);
        segments.push(current);
        current = [];
      }
    }
    if (current.length > 1) segments.push(current);

    return segments;
  });

  // ============================================================================
  //          KHỚP ĐƯỜNG (MAP MATCHING) — giảm sai số hiển thị GPS
  // ============================================================================

  private readonly _matching = signal(false);
  private readonly _matchProgress = signal(0);
  private readonly _matchResult = signal<MatchResult | null>(null);
  private readonly _showMatched = signal(true);

  readonly matching = this._matching.asReadonly();
  readonly matchProgress = this._matchProgress.asReadonly();
  readonly matchResult = this._matchResult.asReadonly();
  readonly showMatched = this._showMatched.asReadonly();

  /** Đường GPS đã bám vào tim phố. Rỗng khi chưa chạy khớp đường. */
  readonly matchedPath = computed<LatLng[]>(() => this._matchResult()?.path ?? []);

  /**
   * Quãng đường sau khi khớp đường — con số ĐÁNG TIN NHẤT trong màn hình này.
   *
   * Thứ tự độ tin cậy tăng dần:
   *   GPS thô  <  GPS đã lọc nhiễu  <  GPS đã khớp vào mạng đường
   *
   * Bản khớp đường là quãng đường đi trên PHỐ THẬT, không còn phụ thuộc vào việc
   * thiết bị lấy mẫu thưa hay dày.
   */
  readonly matchedDistanceMeters = computed(() => totalDistanceMeters(this.matchedPath()));

  /**
   * Chạy khớp đường cho track hiện tại.
   *
   * ĐỂ NGƯỜI DÙNG BẤM chứ không tự chạy: server OSRM công cộng giới hạn `/match`
   * ở 10 toạ độ mỗi request, nên một track phải cắt thành hơn chục request nối
   * tiếp. Tự động chạy mỗi lần mở màn hình là vừa chậm vừa dễ bị chặn IP.
   * Self-host OSRM thì bỏ giới hạn và có thể chạy tự động.
   */
  async runMapMatching(): Promise<void> {
    const points = this.track().map((p) => ({ lat: p.lat, lng: p.lng }));
    if (points.length < 2 || this._matching()) return;

    /*
     * ============ VÌ SAO PHẢI CÓ "VÉ" (token) Ở ĐÂY ============
     *
     * Khớp đường một track thật là hơn chục request nối tiếp, mất vài giây. Trong
     * mấy giây đó người điều vận hoàn toàn có thể bấm sang chuyến khác.
     *
     * Bản cũ không kiểm tra gì khi promise về, nên kịch bản này xảy ra thật:
     *   1. bấm khớp đường chuyến A
     *   2. đổi sang chuyến B (effect đã dọn `_matchResult`)
     *   3. request của A về sau -> `_matchResult.set(result)`
     *   4. đường đi của XE A hiện lên bản đồ chuyến B
     *
     * Nhìn không có gì bất thường — vẫn là một đường bám phố đẹp. Đó là thứ làm
     * nó nguy hiểm.
     *
     * `token` chụp lại danh tính chuyến tại thời điểm bắt đầu; mọi lần ghi state
     * sau `await` (kể cả callback tiến độ) đều phải hỏi lại "còn đúng chuyến
     * không". Không cần huỷ request — chỉ cần vứt kết quả lạc chỗ.
     */
    const token = this._tripId();
    const isCurrent = () => this._tripId() === token;

    this._matching.set(true);
    this._matchProgress.set(0);

    try {
      const result = await this.routing.matchTrack(points, {
        radiusMeters: 25,
        maxPoints: 120,
        onProgress: (done, total) => {
          // Tiến độ của chuyến cũ không được đẩy thanh loading của chuyến mới.
          if (isCurrent()) this._matchProgress.set(total ? done / total : 0);
        },
      });
      if (isCurrent()) this._matchResult.set(result);
    } catch {
      if (isCurrent()) this._matchResult.set(null);
    } finally {
      // `_matching` là cờ của LẦN CHẠY này, luôn phải hạ xuống — nếu không, đổi
      // chuyến rồi quay lại sẽ không bấm khớp đường được nữa.
      this._matching.set(false);
      if (!isCurrent()) this._matchProgress.set(0);
    }
  }

  toggleMatched(): void {
    this._showMatched.update((v) => !v);
  }

  // ============================================================================
  //                   ĐỐI SOÁT ĐIỂM GIAO BẰNG GEOFENCE
  // ============================================================================

  private readonly _showGeofence = signal(false);
  readonly showGeofence = this._showGeofence.asReadonly();

  /** Phơi ra cho template — ngưỡng "coi như đã tới nơi". */
  readonly geofenceRadius = this.config.geofenceRadiusMeters;

  toggleGeofence(): void {
    this._showGeofence.update((v) => !v);
  }

  /**
   * Với mỗi điểm giao: GPS có thật sự vào tới nơi không?
   *
   * ĐÂY LÀ CÂU HỎI ĐỐI SOÁT QUAN TRỌNG NHẤT của giám sát giao hàng. Tài xế bấm
   * "đã giao" trên app là dữ liệu do CON NGƯỜI nhập — bấm được từ bất cứ đâu.
   * GPS là dữ liệu do MÁY sinh. Đối chiếu hai nguồn:
   *
   *  - báo đã giao + GPS có vào vùng  -> khớp, không cần làm gì.
   *  - báo đã giao + GPS KHÔNG vào vùng -> nghi vấn giao khống, cần kiểm tra.
   *  - chưa báo + GPS đã vào vùng     -> tài xế quên bấm, nhắc cập nhật.
   *
   * Ngưỡng bán kính (`geofenceRadiusMeters`) không được để quá chặt: toạ độ điểm
   * giao trong CSDL thường được nhập bằng cách kéo ghim trên bản đồ, sai lệch
   * 50–100 m so với cửa hàng thật là bình thường.
   */
  readonly stopVerification = computed<
    Map<string, { entered: boolean; closestMeters: number; enteredAtIso: string }>
  >(() => {
    const result = new Map<string, { entered: boolean; closestMeters: number; enteredAtIso: string }>();
    const track = this.track();
    const radius = this.config.geofenceRadiusMeters;

    for (const stop of this.trip()?.stops ?? []) {
      let closest = Number.POSITIVE_INFINITY;
      let enteredAt = '';

      for (const point of track) {
        const d = distanceMeters(point, stop);
        if (d < closest) {
          closest = d;
          if (d <= radius && !enteredAt) enteredAt = point.createDate ?? '';
        }
      }

      result.set(stop.id, {
        entered: closest <= radius,
        closestMeters: Number.isFinite(closest) ? Math.round(closest) : 0,
        enteredAtIso: enteredAt,
      });
    }

    return result;
  });

  /** Điểm giao báo đã xong nhưng GPS không hề vào vùng — cần kiểm tra. */
  readonly suspiciousStops = computed(() =>
    (this.trip()?.stops ?? []).filter((s) => {
      if (s.status === 'pending') return false;
      return !this.stopVerification().get(s.id)?.entered;
    }),
  );

  readonly circles = computed<MapCircle[]>(() => {
    if (!this._showGeofence()) return [];

    return (this.trip()?.stops ?? []).map((stop) => {
      const check = this.stopVerification().get(stop.id);
      return {
        key: `fence-${stop.id}`,
        center: { lat: stop.lat, lng: stop.lng },
        radiusMeters: this.config.geofenceRadiusMeters,
        // Đỏ = báo đã giao nhưng GPS không vào tới nơi.
        color:
          stop.status !== 'pending' && !check?.entered
            ? MAP_COLORS.deviation
            : check?.entered
              ? MAP_COLORS.done
              : MAP_COLORS.pending,
        fillOpacity: 0.07,
        dashed: true,
        title: `${stop.customerName} — gần nhất ${check?.closestMeters ?? '?'} m`,
      };
    });
  });

  // ============================================================================
  //                     ĐIỂM DỪNG & CẢNH BÁO
  // ============================================================================

  /** Các lần xe đứng yên lâu — kể cả tại điểm giao (đó là thời gian giao hàng). */
  readonly stopEvents = computed<StopEvent[]>(() =>
    detectStops(this.track(), {
      idleSpeedKmh: this.config.idleSpeedKmh,
      minMinutes: 5,
      radiusMeters: 60,
    }),
  );

  /** Lần dừng nào ứng với điểm giao nào (null = dừng ngoài kế hoạch). */
  readonly stopEventLabels = computed<(string | null)[]>(() => {
    const stops = this.trip()?.stops ?? [];
    const radius = this.config.geofenceRadiusMeters;

    return this.stopEvents().map((event) => {
      let best: string | null = null;
      let bestDistance = radius;

      for (const stop of stops) {
        const d = distanceMeters(event.center, stop);
        if (d < bestDistance) {
          bestDistance = d;
          best = stop.customerName;
        }
      }

      return best;
    });
  });

  readonly alerts = computed<FleetAlert[]>(() => {
    const trip = this.trip();
    if (!trip) return [];

    return buildTripAlerts(trip, this.track(), this.plannedPath(), {
      overspeedKmh: this.config.overspeedKmh,
      idleMinutes: this.config.idleMinutes,
      deviationThresholdMeters: this.config.deviationThresholdMeters,
    });
  });

  focusAlert(alert: FleetAlert): void {
    if (alert.location) this._focus.set({ ...alert.location });
  }

  // ------------------------------------------------------- dữ liệu cho bản đồ

  readonly paths = computed<MapPath[]>(() => {
    const result: MapPath[] = [];

    if (this._showPlanned() && this.plannedPath().length > 1) {
      result.push({
        key: 'planned',
        points: this.plannedPath(),
        color: MAP_COLORS.expected,
        weight: 4,
        opacity: 0.85,
        dashed: true,
      });
    }

    if (this._showActual() && this.travelledPath().length > 1) {
      const hasMatched = this._showMatched() && this.matchedPath().length > 1;

      result.push({
        key: 'actual',
        points: this.travelledPath(),
        color: MAP_COLORS.real,
        // Có đường khớp rồi thì đường thô lùi xuống làm nền mảnh, để người dùng
        // THẤY ĐƯỢC phần sai số đã được nắn — giấu đi thì không chứng minh được gì.
        weight: hasMatched ? 2 : 5,
        opacity: hasMatched ? 0.45 : 0.95,
      });

      if (hasMatched) {
        result.push({
          key: 'matched',
          points: this.matchedPath(),
          color: '#0284c7',
          weight: 5,
        });
      }

      this.deviationSegments().forEach((points, i) => {
        result.push({ key: `deviation-${i}`, points, color: MAP_COLORS.deviation, weight: 6 });
      });
    }

    // Chặng còn lại: từ chỗ xe đang đứng đi tiếp theo kế hoạch HIỆN HÀNH.
    if (this._showRemaining() && this.remainingPath().length > 1) {
      result.push({
        key: 'remaining',
        points: this.remainingPath(),
        color: MAP_COLORS.late,
        weight: 4,
        opacity: 0.9,
        dashed: true,
      });
    }

    // Đường nối tạm tới điểm đang định chèn — cho thấy ngay nó "kéo" tuyến đi đâu.
    const preview = this.draftPreview();
    const draftPoint = this._draft().point;
    if (draftPoint && preview) {
      const anchors = this.insertionAnchors();
      const best = bestInsertion(anchors, draftPoint, 1);
      const prev = anchors[best.index - 1];
      const next = anchors[best.index];

      result.push({
        key: 'draft-link',
        points: next ? [prev, draftPoint, next] : [prev, draftPoint],
        color: '#db2777',
        weight: 3,
        dashed: true,
      });
    }

    return result;
  });

  readonly markers = computed<MapMarker[]>(() => {
    const trip = this.trip();
    if (!trip) return [];

    const selected = this._selectedStopId();
    const etas = this.etaByStop();

    const markers: MapMarker[] = [
      {
        key: 'depot',
        lat: trip.depot.lat,
        lng: trip.depot.lng,
        label: '⌂',
        title: trip.depot.name,
        description: `${trip.depot.address}<br/>Điểm xuất phát &amp; kết thúc chuyến`,
        color: '#0f172a',
      },
      ...trip.stops.map((stop) => ({
        key: stop.id,
        lat: stop.lat,
        lng: stop.lng,
        label: String(stop.seq),
        title: `${stop.seq}. ${stop.customerName}${stop.isAdHoc ? ' (phát sinh)' : ''}`,
        description: this.stopPopup(stop, etas.get(stop.id)),
        color: this.stopColor(stop),
        active: stop.id === selected,
        data: stop,
      })),
    ];

    // Điểm đang nhập ở form — chưa nằm trong tuyến, đánh dấu bằng dấu cộng.
    const draftPoint = this._draft().point;
    if (draftPoint) {
      markers.push({
        key: 'draft',
        lat: draftPoint.lat,
        lng: draftPoint.lng,
        label: '＋',
        title: this._draft().customerName || 'Điểm giao mới',
        description: this._draft().address,
        color: '#db2777',
        active: true,
      });
    }

    if (this._showGpsPoints()) {
      const flags = this.deviationFlags();
      // Chỉ hiện 1/4 số điểm — vẽ hết vài trăm marker DOM là trình duyệt giật.
      this.track()
        .slice(0, this._cursor() + 1)
        .forEach((p, i) => {
          if (i % 4 !== 0) return;
          markers.push({
            key: `gps-${i}`,
            lat: p.lat,
            lng: p.lng,
            dot: true,
            color: flags[i] ? MAP_COLORS.deviation : MAP_COLORS.real,
            title: formatTimeLabel(p.createDate),
            description: `Tốc độ: ${p.speedKmh ?? 0} km/h &middot; Pin: ${p.battery ?? '--'}%`,
          });
        });
    }

    return markers;
  });

  /** Marker xe đang chạy. */
  readonly vehicle = computed<MapMarker | null>(() => {
    const point = this.currentPoint();
    if (!point) return null;
    return {
      key: 'vehicle',
      lat: point.lat,
      lng: point.lng,
      label: '🚚',
      title: this.trip()?.vehiclePlate ?? '',
    };
  });

  // ---------------------------------------------------------------- thống kê

  readonly stats = computed<TripStats>(() => {
    const trip = this.trip();
    const planned = this.plannedPath();
    const flags = this.deviationFlags();
    const threshold = this.config.deviationThresholdMeters;

    if (!trip) {
      return {
        plannedDistanceMeters: 0,
        actualDistanceMeters: 0,
        deliveredCount: 0,
        failedCount: 0,
        totalStops: 0,
        lateCount: 0,
        deviationCount: 0,
        maxDeviationMeters: 0,
        collectedAmount: 0,
      };
    }

    const maxDeviation = planned.length
      ? this.track().reduce((max, p) => Math.max(max, distanceToPathMeters(p, planned)), 0)
      : 0;

    return {
      plannedDistanceMeters: totalDistanceMeters(planned),
      // Quãng đường thực tế cộng từ chính GPS track, KHÔNG hỏi lại dịch vụ định
      // tuyến — đường thực tế đã là đường đi rồi, định tuyến lại là sai nghiệp vụ.
      actualDistanceMeters: totalDistanceMeters(
        this.track().map((p) => ({ lat: p.lat, lng: p.lng })),
      ),
      deliveredCount: trip.stops.filter((s) => s.status === 'delivered').length,
      failedCount: trip.stops.filter((s) => s.status === 'failed').length,
      totalStops: trip.stops.length,
      lateCount: trip.stops.filter((s) => this.lateMinutes(s) > 15).length,
      deviationCount: flags.filter(Boolean).length,
      maxDeviationMeters: maxDeviation > threshold ? maxDeviation : 0,
      collectedAmount: trip.stops
        .filter((s) => s.status === 'delivered')
        .reduce((sum, s) => sum + s.amount, 0),
    };
  });

  /** Số phút tới trễ so với kế hoạch (âm = tới sớm). */
  lateMinutes(stop: DeliveryStop): number {
    if (!stop.actualArrival || !stop.plannedArrival) return 0;

    const diff =
      (new Date(stop.actualArrival).getTime() - new Date(stop.plannedArrival).getTime()) / 60_000;

    // Dữ liệu giờ hỏng -> trả 0 thay vì để NaN lan ra KPI (NaN so sánh kiểu gì
    // cũng ra false, làm cảnh báo "tới trễ" âm thầm biến mất).
    return Number.isNaN(diff) ? 0 : Math.round(diff);
  }

  /** ETA đã tính lại của một điểm chưa giao. */
  etaOf(stop: DeliveryStop): StopEta | undefined {
    return this.etaByStop().get(stop.id);
  }

  stopColor(stop: DeliveryStop): string {
    if (stop.status === 'failed') return MAP_COLORS.deviation;
    if (stop.isAdHoc) return '#db2777';
    if (stop.status === 'pending') return MAP_COLORS.pending;
    return this.lateMinutes(stop) > 15 ? MAP_COLORS.late : MAP_COLORS.done;
  }

  private stopPopup(stop: DeliveryStop, eta?: StopEta): string {
    const late = this.lateMinutes(stop);
    const lateText = !stop.actualArrival
      ? eta
        ? `Dự kiến tới ${formatTimeLabel(eta.eta)}` +
          (eta.shiftMinutes > SHIFT_ALERT_MINUTES ? ` (muộn hơn kế hoạch ${eta.shiftMinutes}′)` : '')
        : 'Chưa tới'
      : late > 0
        ? `Trễ ${late} phút`
        : `Sớm ${Math.abs(late)} phút`;

    return [
      stop.address,
      `Đơn: ${stop.orderCode}`,
      stop.plannedArrival ? `Kế hoạch: ${formatTimeLabel(stop.plannedArrival)}` : 'Đơn phát sinh',
      lateText,
      stop.note ? `Ghi chú: ${stop.note}` : '',
    ]
      .filter(Boolean)
      .join('<br/>');
  }
}

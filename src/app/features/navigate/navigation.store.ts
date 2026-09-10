import {
  DestroyRef,
  Injectable,
  computed,
  effect,
  inject,
  resource,
  signal,
  untracked,
} from '@angular/core';
import {
  Guidance,
  INITIAL_OFF_ROUTE_STATE,
  LatLng,
  MAP_COLORS,
  MAP_ROUTING_CONFIG,
  MapCircle,
  MapMarker,
  MapPath,
  MapProviderService,
  OffRouteState,
  RouteResult,
  RoutingFacade,
  StepOffset,
  addSeconds,
  bearingAtAlong,
  cumulativeAlong,
  destinationPoint,
  distanceMeters,
  etaSeconds,
  guidanceAt,
  legBoundaries,
  pointAtAlong,
  projectOnPath,
  slicePathByDistance,
  stepOffsets,
  updateOffRoute,
} from '../../core/map';
import { DeliveryMockApi } from '../delivery/delivery-mock.api';
import { DeliveryStop, DeliveryTrip } from '../delivery/delivery.models';

/** Nhịp mô phỏng (ms thực tế giữa 2 bản ghi GPS giả lập). */
const TICK_MS = 500;

/** Hệ số tua: 1 giây thật = ngần này giây mô phỏng. */
export const NAV_SPEEDS = [1, 2, 4, 8, 16] as const;
export type NavSpeed = (typeof NAV_SPEEDS)[number];

/** Bán kính coi là "đã tới cửa hàng" trong lúc dẫn đường (mét). */
const ARRIVAL_RADIUS_METERS = 45;

/** Thời gian đứng giao mỗi điểm — dùng để tính giờ về kho (giây). */
const SERVICE_SECONDS_PER_STOP = 10 * 60;

/** Sai số GPS mô phỏng (mét) — GPS điện thoại trong phố thường 5–15 m. */
const GPS_NOISE_METERS = 9;

/** Xe chạy chậm lại khi sắp tới ngã rẽ — nhân với tốc độ trung bình. */
const SLOWDOWN_NEAR_TURN = 0.55;

/** Đi xa hơn ngần này mét thì mới dời khung nhìn bản đồ theo xe. */
const FOLLOW_STEP_METERS = 120;

/**
 * ============ BẢNG MÀU TUYẾN, LÀM ĐÚNG NHƯ GOOGLE MAPS ============
 *
 * Google Maps khi dẫn đường qua NHIỀU ĐIỂM DỪNG không vẽ cả tuyến cùng một màu.
 * Nó phân ba mức, và ba mức đó trả lời ba câu hỏi khác nhau của tài xế:
 *
 *  - `passed`  — phần ĐÃ ĐI: xám, mảnh, mờ. Không còn giá trị điều hướng, chỉ
 *                để biết mình vừa từ đâu tới.
 *  - `active`  — phần từ vị trí xe tới **ĐIỂM DỪNG KẾ TIẾP**: xanh đậm, dày
 *                nhất, có viền đậm bọc ngoài (casing). Đây là chặng duy nhất
 *                tài xế cần nhìn.
 *  - `later`   — phần **CHƯA TỚI**, tức là sau điểm dừng kế tiếp: xanh NHẠT.
 *                Vẫn phải thấy để hình dung cả chuyến, nhưng không được tranh
 *                sự chú ý với chặng đang chạy.
 *
 * Mã màu lấy đúng bộ của Google Maps (`#1a73e8` xanh chính, `#a8c7fa` xanh nhạt,
 * `#0b57d0` viền đậm, `#9aa0a6` xám). Dùng bộ khác thì phần "nhạt" rất dễ trông
 * như một tuyến thứ hai đang gợi ý thay vì phần đường phía sau điểm dừng.
 */
export const NAV_ROUTE_COLORS = {
  passed: '#9aa0a6',
  active: '#1a73e8',
  activeCasing: '#0b57d0',
  later: '#a8c7fa',
  offRoute: '#d93025',
  offRouteCasing: '#8c1d18',
} as const;

/** Một waypoint trên tuyến dẫn đường: điểm giao, hoặc kho ở cuối. */
export interface NavWaypoint {
  /** `null` = kho (điểm về cuối chuyến). */
  stop: DeliveryStop | null;
  point: LatLng;
  label: string;
  sublabel: string;
}

/**
 * ================== CHẾ ĐỘ DẪN ĐƯỜNG TÀI XẾ ==================
 *
 * Ba màn kia nhìn từ phía VĂN PHÒNG (điều hành đội xe, lập kế hoạch, giám sát
 * lịch sử). Màn này nhìn từ phía CABIN: chỉ có một câu hỏi duy nhất — "giờ tôi
 * phải rẽ đâu, và bao giờ tới nơi".
 *
 * BỐN THỨ PHÂN BIỆT DẪN ĐƯỜNG THẬT VỚI "VẼ MỘT ĐƯỜNG RỒI CHO XE CHẠY DỌC":
 *
 *  1. **Vị trí phải bám đường.** GPS bắn về luôn lệch tim đường vài mét. Vẽ thẳng
 *     toạ độ thô là xe nhảy qua nhảy lại hai bên vạch, nhìn như đang lượn lách.
 *     Ở đây mọi thứ hiển thị đều dùng HÌNH CHIẾU vuông góc xuống tuyến
 *     (`projectOnPath`), còn toạ độ thô chỉ để hiện con số "sai số GPS".
 *  2. **Chỉ dẫn phải chạy theo quãng đường**, không theo chỉ số đỉnh polyline —
 *     xem `navigation.util.ts`.
 *  3. **Phát hiện đi sai đường phải có độ trễ.** Một bản ghi nhiễu không được
 *     phép kích hoạt định tuyến lại (`updateOffRoute`).
 *  4. **Định tuyến lại phải bỏ các điểm ĐÃ GIAO.** Tuyến mới đi từ chỗ xe đang
 *     đứng qua các điểm CÒN LẠI rồi về kho — không phải chạy lại từ đầu tuyến.
 *
 * MÔ PHỎNG NGUỒN GPS: hệ thống thật nhận vị trí từ app tài xế qua WebSocket /
 * polling. Demo không có xe thật nên có một bộ phát giả lập chạy trong
 * `effect()`: mỗi nhịp đẩy xe tiến thêm theo tốc độ của tuyến, cộng nhiễu, và
 * cộng thêm độ lệch nếu người dùng bấm nút "giả lập đi sai đường". Toàn bộ phần
 * còn lại của store KHÔNG biết dữ liệu là giả — thay bộ phát này bằng
 * WebSocket thật thì không phải sửa dòng nào ở dưới.
 */
@Injectable()
export class NavigationStore {
  private readonly api = inject(DeliveryMockApi);
  private readonly routing = inject(RoutingFacade);
  private readonly mapProvider = inject(MapProviderService);
  private readonly config = inject(MAP_ROUTING_CONFIG);
  private readonly destroyRef = inject(DestroyRef);

  readonly trips = this.api.listTrips();
  readonly arrivalRadius = ARRIVAL_RADIUS_METERS;

  private readonly _tripId = signal(this.trips[0]?.id ?? '');
  readonly tripId = this._tripId.asReadonly();

  private readonly tripResource = resource({
    params: () => ({ id: this._tripId() }),
    loader: ({ params }) => this.api.getTrip(params.id),
  });

  readonly trip = computed<DeliveryTrip | undefined>(() => this.tripResource.value());
  readonly loadingTrip = computed(() => this.tripResource.isLoading());

  // ------------------------------------------------------------ tuyến đang chạy

  /** Các điểm đã giao xong TRONG PHIÊN dẫn đường này. */
  private readonly _doneStopIds = signal<ReadonlySet<string>>(new Set());
  readonly doneStopIds = this._doneStopIds.asReadonly();

  /**
   * Điểm xuất phát của tuyến hiện hành.
   * `null` = chưa chạy, lấy kho làm điểm đầu. Mỗi lần định tuyến lại, giá trị này
   * được đặt bằng đúng vị trí xe lúc đó.
   */
  private readonly _origin = signal<LatLng | null>(null);

  /** Tăng lên mỗi lần định tuyến lại — để `resource` chạy lại kể cả khi toạ độ gần trùng. */
  private readonly _routeVersion = signal(0);
  readonly rerouteCount = computed(() => this._routeVersion());

  /** Waypoint của tuyến hiện hành: các điểm chưa giao, rồi về kho. */
  readonly waypoints = computed<NavWaypoint[]>(() => {
    const trip = this.trip();
    if (!trip) return [];

    const done = this._doneStopIds();
    const remaining = [...trip.stops]
      .sort((a, b) => a.seq - b.seq)
      .filter((s) => !done.has(s.id));

    return [
      ...remaining.map((stop) => ({
        stop,
        point: { lat: stop.lat, lng: stop.lng },
        label: stop.customerName,
        sublabel: stop.address,
      })),
      {
        stop: null,
        point: { lat: trip.depot.lat, lng: trip.depot.lng },
        label: `Về ${trip.depot.name}`,
        sublabel: trip.depot.address,
      },
    ];
  });

  /**
   * Định tuyến tuyến dẫn đường.
   *
   * `withSteps: true` là bắt buộc ở đây (và chỉ ở đây) — các màn khác không xin
   * `steps` vì response nặng gấp nhiều lần mà không dùng tới.
   */
  private readonly routeResource = resource({
    params: () => {
      const trip = this.trip();
      const waypoints = this.waypoints();
      if (!trip || waypoints.length < 1) return undefined;

      const origin = this._origin() ?? { lat: trip.depot.lat, lng: trip.depot.lng };

      return {
        origin,
        targets: waypoints.map((w) => w.point),
        version: this._routeVersion(),
        provider: this.mapProvider.provider(),
      };
    },
    loader: ({ params }) =>
      this.routing.computeRoute({
        points: [params.origin, ...params.targets],
        travelMode: 'driving',
        withSteps: true,
        // Màn dẫn đường là chỗ DUY NHẤT bật tính-theo-giao-thông: tài xế đang
        // chạy thật, ETA phải bám tình hình hiện tại và đi vòng tránh tắc là
        // điều mong muốn. Các màn lập kế hoạch/báo cáo thì để tắt, vì ở đó cần
        // quãng đường ổn định — xem `RoutingRequest.trafficAware`.
        trafficAware: true,
      }),
  });

  /**
   * Tuyến gần nhất tính được.
   *
   * VÌ SAO PHẢI GIỮ LẠI: `resource` xoá `value()` về `undefined` ngay khi bắt đầu
   * tải lần mới. Trong lúc chờ định tuyến lại (vài trăm mili-giây), `routePath()`
   * sẽ rỗng — kéo theo vị trí xe rơi về `{0,0}` (giữa Đại Tây Dương) và marker
   * biến mất khỏi bản đồ. Giữ tuyến cũ làm nền thì xe đứng yên tại chỗ chờ tuyến
   * mới, đúng như hành vi của mọi thiết bị dẫn đường.
   *
   * ⚠️ NHƯNG PHẢI GẮN NHÃN CHUYẾN. Giữ tuyến cũ là đúng khi ĐỊNH TUYẾN LẠI
   * TRONG CÙNG MỘT CHUYẾN. Khi người dùng đổi hẳn sang chuyến khác thì trong lúc
   * tuyến mới đang tải, tuyến của chuyến TRƯỚC sẽ loé lên bản đồ — và vì nó cũng
   * là một tuyến bám phố bình thường nên không ai nhận ra là của xe khác.
   *
   * Nhãn `tripId` khiến hai trường hợp đó không thể lẫn nhau: cùng chuyến thì
   * dùng, khác chuyến thì coi như chưa có tuyến.
   */
  private readonly _lastRoute = signal<{ tripId: string; route: RouteResult } | null>(null);

  readonly route = computed<RouteResult | undefined>(() => {
    const fresh = this.routeResource.hasValue() ? this.routeResource.value() : undefined;
    if (fresh) return fresh;

    const cached = this._lastRoute();
    return cached?.tripId === this._tripId() ? cached.route : undefined;
  });
  readonly loadingRoute = computed(() => this.routeResource.isLoading());
  readonly routeError = computed(() => {
    const err = this.routeResource.error();
    return err ? (err as Error).message : null;
  });

  readonly routePath = computed<LatLng[]>(() => this.route()?.path ?? []);

  /** Tính một lần cho mỗi tuyến, dùng lại ở mọi tick — xem `cumulativeAlong`. */
  private readonly cumulative = computed<number[]>(() => cumulativeAlong(this.routePath()));

  readonly routeMeters = computed(() => this.route()?.distanceMeters ?? 0);
  readonly routeSeconds = computed(() => this.route()?.durationSeconds ?? 0);

  private readonly offsets = computed<StepOffset[]>(() => stepOffsets(this.route()?.steps ?? []));

  /** Mốc quãng đường của từng waypoint trên tuyến. */
  private readonly boundaries = computed<number[]>(() => legBoundaries(this.route()?.legs ?? []));

  // ------------------------------------------------------- bộ phát GPS giả lập

  private readonly _running = signal(false);
  private readonly _speed = signal<NavSpeed>(4);
  /** Quãng đường xe đã đi trên tuyến HIỆN HÀNH (mét, theo mô phỏng). */
  private readonly _travelled = signal(0);
  /** Độ lệch ngang đang được cố tình bơm vào để thử cơ chế bắt đi sai đường (mét). */
  private readonly _drift = signal(0);
  private readonly _detour = signal(false);
  private readonly _tick = signal(0);
  private readonly _clock = signal(new Date().toISOString());

  /** Bản đồ có tự bám theo xe không — tài xế xem đường thì bật, điều phối xem tổng thể thì tắt. */
  private readonly _follow = signal(true);

  readonly running = this._running.asReadonly();
  readonly speed = this._speed.asReadonly();
  readonly detour = this._detour.asReadonly();
  readonly clock = this._clock.asReadonly();
  readonly follow = this._follow.asReadonly();

  /** Bản ghi GPS thô "nhận được từ thiết bị" — có nhiễu, có thể lệch tuyến. */
  readonly rawFix = computed<LatLng>(() => {
    const path = this.routePath();
    if (path.length < 2) return path[0] ?? { lat: 0, lng: 0 };

    const cum = this.cumulative();
    const along = this._travelled();
    const base = pointAtAlong(path, along, cum);
    const heading = bearingAtAlong(path, along, cum);

    // Nhiễu tất định theo số tick: F5 lại vẫn ra đúng một đường, dễ so sánh khi
    // sửa code. `Math.random()` ở đây sẽ làm mọi ảnh chụp màn hình khác nhau.
    const seed = this._tick();
    const noiseAngle = (seed * 137.508) % 360;
    const noiseDist = ((Math.sin(seed * 12.9898) + 1) / 2) * GPS_NOISE_METERS;

    const drifted = this._drift() > 0 ? destinationPoint(base, heading + 90, this._drift()) : base;
    return destinationPoint(drifted, noiseAngle, noiseDist);
  });

  /**
   * Chỉ số đoạn của lần chiếu trước — mồi cho lần chiếu sau, xem `projectOnPath`.
   *
   * PHẢI LÀ SIGNAL, KHÔNG ĐƯỢC LÀ FIELD GÁN TRONG `computed`. Bản trước gán
   * `this.lastSegmentIndex = result.index` ngay trong thân `projection` —
   * `computed` là hàm phải THUẦN TUÝ, số lần nó chạy lại do Angular quyết định
   * (và có thể chạy nhiều lần cho cùng một trạng thái). Ghi trạng thái trong đó
   * là mồi tìm kiếm tiến lên theo những nhịp không ai kiểm soát được.
   */
  private readonly _segmentHint = signal(0);

  /**
   * Vị trí đã bám đường + độ lệch tuyến tức thời.
   *
   * ĐÂY LÀ TRUNG TÂM CỦA MÀN HÌNH: mọi con số (còn bao xa, rẽ ở đâu, mấy giờ tới)
   * đều suy ra từ `alongMeters` của phép chiếu này.
   */
  readonly projection = computed(() => {
    const path = this.routePath();
    const fix = this.rawFix();
    if (path.length < 2) {
      return { index: 0, snapped: fix, lateralMeters: 0, alongMeters: 0 };
    }

    // MỒI LẠC: tuyến vừa đổi (định tuyến lại / đổi chuyến) mà mồi còn của tuyến
    // cũ. `projectOnPath` kẹp mồi vào `path.length - 2`, nên mồi to hơn tuyến
    // mới sẽ ép hình chiếu nhảy thẳng tới ĐOẠN CUỐI: xe hiện ở đích, cả tuyến
    // bị tô màu "đã đi". Ở đây phát hiện mồi lạc thì quét lại từ đầu.
    const hint = this._segmentHint();
    const seed = hint <= path.length - 2 ? hint : 0;

    return projectOnPath(fix, path, this.cumulative(), seed);
  });

  /**
   * Quãng đường đã đi dọc tuyến (mét) — **CHỈ TIẾN, KHÔNG LÙI**.
   *
   * VÌ SAO KHÔNG DÙNG THẲNG `projection().alongMeters`:
   * Hình chiếu được tính từ toạ độ GPS THÔ, mà toạ độ thô có nhiễu vài mét theo
   * mọi hướng — trong đó có hướng DỌC đường. Hệ quả nếu dùng trực tiếp:
   *
   *  - Quãng đường còn lại / ETA nhảy tăng-giảm mỗi nhịp.
   *  - Điểm cắt giữa "đã đi" và "còn phải đi" chạy lùi rồi lại tiến -> đường vẽ
   *    trên bản đồ co giật, đúng cảm giác "vẽ linh tinh".
   *  - Đứng chờ đèn đỏ ở khúc đường vòng, nhiễu đủ để hệ thống tưởng xe lùi lại
   *    và phát chỉ dẫn rẽ đã đi qua.
   *
   * Mọi thiết bị dẫn đường đều chốt tiến độ đơn điệu như thế này; chỉ khi kết
   * luận là ĐI SAI ĐƯỜNG mới được phép đặt lại (và lúc đó đặt lại cả tuyến).
   */
  private readonly _progressMeters = signal(0);
  readonly progressMeters = this._progressMeters.asReadonly();

  /**
   * Vị trí vẽ lên bản đồ.
   *
   * Lấy theo TIẾN ĐỘ đơn điệu, không lấy `projection().snapped` của bản ghi
   * hiện tại: hai giá trị này chỉ khác nhau vài mét, nhưng cái sau nhảy tiến/lùi
   * mỗi nhịp nên marker xe rung tại chỗ và animation trượt của marker bị đảo
   * chiều liên tục. Toạ độ thô vẫn được vẽ riêng bằng chấm cam nên người xem
   * không mất thông tin nào.
   */
  readonly position = computed<LatLng>(() => {
    const path = this.routePath();
    if (path.length < 2) return path[0] ?? { lat: 0, lng: 0 };
    return pointAtAlong(path, this._progressMeters(), this.cumulative());
  });

  /** Sai số giữa toạ độ thiết bị báo về và tim đường (mét). */
  readonly gpsErrorMeters = computed(() => Math.round(this.projection().lateralMeters));

  readonly headingDegrees = computed(() =>
    bearingAtAlong(this.routePath(), this._progressMeters(), this.cumulative()),
  );

  /** Tốc độ tức thời (km/h) — mô phỏng theo tốc độ trung bình của tuyến. */
  readonly speedKmh = computed(() => {
    if (!this._running()) return 0;
    return Math.round(this.currentSpeedMps() * 3.6);
  });

  // ------------------------------------------------------------- lệch tuyến

  private readonly _offRoute = signal<OffRouteState>(INITIAL_OFF_ROUTE_STATE);
  readonly offRoute = computed(() => this._offRoute().offRoute);
  readonly offRouteMeters = computed(() => Math.round(this._offRoute().lastLateralMeters));

  // ------------------------------------------------------------- chỉ dẫn rẽ

  readonly guidance = computed<Guidance | null>(() =>
    guidanceAt(this.offsets(), this._progressMeters()),
  );

  /** Vài chỉ dẫn kế tiếp — bảng "đường đi phía trước". */
  readonly upcomingSteps = computed(() => {
    const offsets = this.offsets();
    const g = this.guidance();
    if (!g) return [];

    const along = this._progressMeters();
    return offsets.slice(g.stepIndex + 1, g.stepIndex + 6).map((o) => ({
      step: o.step,
      distanceFromHere: Math.max(o.endMeters - along, 0),
    }));
  });

  // --------------------------------------------------- điểm giao kế tiếp & ETA

  /**
   * Waypoint xe đang hướng tới (chỉ số trong `waypoints()`).
   *
   * VÌ SAO LÀ SIGNAL CHỨ KHÔNG PHẢI `computed` TỪ QUÃNG ĐƯỜNG:
   * Suy ra từ `alongMeters` (kiểu `activeLegIndex(boundaries, along)`) thì mục
   * tiêu tự nhảy sang điểm kế tiếp NGAY KHI xe đi quá mốc — kể cả khi chưa ai
   * xác nhận đã giao xong. Ở tốc độ tua 16× (mỗi nhịp đi 160 m, dài hơn bán kính
   * geofence 45 m) hệ quả là xe lướt qua cửa hàng mà màn hình không hề dừng lại.
   * Đây là bản sao của một lỗi rất hay gặp ở hệ thống thật: thiết bị gửi vị trí
   * 60 giây một lần, xe chạy 50 km/h là mỗi bản ghi cách nhau 830 m, mọi logic
   * "đã tới nơi" dựa trên khoảng cách tức thời đều trượt.
   *
   * Nên mục tiêu chỉ được tiến MỘT BƯỚC, do `checkArrival()` quyết định.
   */
  private readonly _legIndex = signal(0);

  private readonly targetIndex = computed(() =>
    Math.min(this._legIndex(), Math.max(this.waypoints().length - 1, 0)),
  );

  readonly nextWaypoint = computed<NavWaypoint | null>(
    () => this.waypoints()[Math.max(this.targetIndex(), 0)] ?? null,
  );

  /**
   * Còn bao xa tới điểm giao kế tiếp (mét) — đo DỌC THEO ĐƯỜNG, không chim bay.
   * Chênh lệch giữa hai cách đo này ở phố một chiều có thể tới vài trăm mét.
   *
   * Provider không trả `legs` (Viettel) thì đành rơi về đường chim bay: thà một
   * con số xấp xỉ còn hơn hiện 0 m trong khi xe còn cách 3 km.
   */
  readonly metersToNextStop = computed(() => {
    const boundaries = this.boundaries();
    const idx = Math.max(this.targetIndex(), 0);
    const boundary = boundaries[idx + 1];

    if (boundary == null) {
      const target = this.waypoints()[idx];
      return target ? distanceMeters(this.position(), target.point) : 0;
    }

    return Math.max(boundary - this._progressMeters(), 0);
  });

  readonly metersRemaining = computed(() =>
    Math.max(this.routeMeters() - this._progressMeters(), 0),
  );

  /** Số điểm còn phải ghé sau điểm kế tiếp (không tính kho). */
  private readonly stopsAfterNext = computed(() => {
    const waypoints = this.waypoints();
    const idx = Math.max(this.targetIndex(), 0);
    return waypoints.slice(idx + 1).filter((w) => w.stop).length;
  });

  readonly secondsToNextStop = computed(() =>
    etaSeconds({
      remainingMeters: this.metersToNextStop(),
      routeMeters: this.routeMeters(),
      routeSeconds: this.routeSeconds(),
      observedSpeedMps: this.currentSpeedMps(),
    }),
  );

  readonly secondsToFinish = computed(() =>
    etaSeconds({
      remainingMeters: this.metersRemaining(),
      routeMeters: this.routeMeters(),
      routeSeconds: this.routeSeconds(),
      observedSpeedMps: this.currentSpeedMps(),
      stopsAhead: this.stopsAfterNext() + (this.nextWaypoint()?.stop ? 1 : 0),
      serviceSecondsPerStop: SERVICE_SECONDS_PER_STOP,
    }),
  );

  readonly etaNextStopIso = computed(() => addSeconds(this._clock(), this.secondsToNextStop()));
  readonly etaFinishIso = computed(() => addSeconds(this._clock(), this.secondsToFinish()));

  /**
   * Trễ so với kế hoạch của điểm kế tiếp (phút, dương = muộn).
   * Điểm phát sinh không có kế hoạch gốc -> trả `null` chứ không trả 0, để màn
   * hình hiện "—" thay vì khoe một con số đúng giả.
   */
  readonly nextStopDelayMinutes = computed<number | null>(() => {
    const stop = this.nextWaypoint()?.stop;
    if (!stop?.plannedArrival) return null;

    const planned = new Date(stop.plannedArrival).getTime();
    if (Number.isNaN(planned)) return null;

    return Math.round((new Date(this.etaNextStopIso()).getTime() - planned) / 60_000);
  });

  // ------------------------------------------------------------ tới nơi / giao

  /** Điểm giao vừa tới nơi, đang chờ tài xế xác nhận kết quả giao. */
  private readonly _arrivedStop = signal<DeliveryStop | null>(null);
  readonly arrivedStop = this._arrivedStop.asReadonly();

  /** Nhật ký hành trình — hiện ở cột phải, giống bảng log của app tài xế. */
  private readonly _log = signal<{ time: string; text: string; kind: string }[]>([]);
  readonly log = this._log.asReadonly();

  readonly finished = computed(() => {
    const trip = this.trip();
    if (!trip) return false;
    return (
      this._doneStopIds().size >= trip.stops.length &&
      this.metersRemaining() < ARRIVAL_RADIUS_METERS
    );
  });

  readonly progressPercent = computed(() => {
    const total = this.routeMeters();
    if (total <= 0) return 0;
    return Math.min(100, Math.round((this.projection().alongMeters / total) * 100));
  });

  constructor() {
    // Đổi chuyến -> quên sạch phiên dẫn đường cũ, KỂ CẢ tuyến giữ làm nền.
    // Effect này khai báo trước effect bên dưới nên luôn chạy trước, đảm bảo
    // không có khoảnh khắc nào tuyến chuyến cũ còn nằm lại.
    effect(() => {
      this._tripId();
      this._lastRoute.set(null);
      this.resetSession();
    });

    // Tuyến mới về (lần đầu hoặc sau khi định tuyến lại) -> xe đứng ở đầu tuyến.
    effect(() => {
      const value = this.routeResource.hasValue() ? this.routeResource.value() : undefined;
      if (!value) return;

      this._lastRoute.set({ tripId: untracked(() => this._tripId()), route: value });
      this._travelled.set(0);
      this._legIndex.set(0);
      this.lastSegmentIndex = 0;
      this._offRoute.set(INITIAL_OFF_ROUTE_STATE);
    });

    // Bộ phát GPS giả lập.
    effect((onCleanup) => {
      if (!this._running()) return;
      if (this.routePath().length < 2) return;

      const timer = setInterval(() => this.emitFix(), TICK_MS);
      onCleanup(() => clearInterval(timer));
    });

    this.destroyRef.onDestroy(() => this._running.set(false));
  }

  // ----------------------------------------------------------------- lệnh

  selectTrip(id: string): void {
    this._tripId.set(id);
  }

  start(): void {
    if (this.finished()) return;
    this._arrivedStop.set(null);
    this._running.set(true);
  }

  pause(): void {
    this._running.set(false);
  }

  toggleRun(): void {
    this._running() ? this.pause() : this.start();
  }

  setSpeed(speed: NavSpeed): void {
    this._speed.set(speed);
  }

  toggleFollow(): void {
    this._follow.update((v) => !v);
    if (this._follow()) this._focusPoint.set({ ...this.position() });
  }

  /** Bật/tắt mô phỏng đi chệch tuyến để xem hệ thống phản ứng thế nào. */
  toggleDetour(): void {
    const on = !this._detour();
    this._detour.set(on);
    if (!on) this._drift.set(0);
  }

  /**
   * Xác nhận đã giao xong điểm đang đứng, đi tiếp.
   *
   * Điểm giao xong bị loại khỏi `waypoints`, kéo theo `routeResource` chạy lại —
   * đó là lý do phải đặt lại `_origin` về vị trí hiện tại trước, nếu không tuyến
   * mới sẽ được tính từ kho.
   */
  completeArrivedStop(): void {
    const stop = this._arrivedStop();
    if (!stop) return;

    // CHỐT vị trí TRƯỚC khi đụng vào `doneStopIds`: sửa danh sách điểm là
    // `routeResource` lập tức chuyển sang trạng thái đang tải, và vị trí xe lúc
    // đó không còn đáng tin để làm điểm xuất phát cho tuyến mới.
    const here = { ...this.position() };

    this._doneStopIds.update((set) => new Set([...set, stop.id]));
    this._arrivedStop.set(null);
    this.pushLog(`Đã giao ${stop.customerName}`, 'done');

    this._origin.set(here);
    this._routeVersion.update((v) => v + 1);
    this._running.set(true);
  }

  /** Giao không thành công — vẫn rời điểm, nhưng ghi nhận khác. */
  skipArrivedStop(): void {
    const stop = this._arrivedStop();
    if (!stop) return;

    const here = { ...this.position() };

    this._doneStopIds.update((set) => new Set([...set, stop.id]));
    this._arrivedStop.set(null);
    this.pushLog(`Không giao được ${stop.customerName} — chuyển điểm kế tiếp`, 'fail');

    this._origin.set(here);
    this._routeVersion.update((v) => v + 1);
    this._running.set(true);
  }

  /** Định tuyến lại thủ công từ vị trí hiện tại. */
  reroute(reason = 'Định tuyến lại theo yêu cầu'): void {
    if (!this.trip()) return;

    this._origin.set({ ...this.rawFix() });
    this._drift.set(0);
    this._detour.set(false);
    this._routeVersion.update((v) => v + 1);
    this.pushLog(reason, 'reroute');
  }

  resetSession(): void {
    this._running.set(false);
    this._doneStopIds.set(new Set());
    this._arrivedStop.set(null);
    this._origin.set(null);
    this._drift.set(0);
    this._detour.set(false);
    this._travelled.set(0);
    this._legIndex.set(0);
    this._tick.set(0);
    this._offRoute.set(INITIAL_OFF_ROUTE_STATE);
    this.lastSegmentIndex = 0;
    this._log.set([]);
    this._focusPoint.set(null);
    this._clock.set(new Date().toISOString());
  }

  // ------------------------------------------------------- vòng lặp mô phỏng

  /** Tốc độ đang chạy (m/s): tốc độ trung bình tuyến, chậm lại khi sắp rẽ. */
  private currentSpeedMps(): number {
    const meters = this.routeMeters();
    const seconds = this.routeSeconds();
    if (meters <= 0 || seconds <= 0) return 0;

    const base = meters / seconds;
    const g = this.guidance();
    return g?.imminent ? base * SLOWDOWN_NEAR_TURN : base;
  }

  /**
   * Một "bản ghi GPS" mới.
   *
   * Thứ tự các bước ở đây đúng bằng thứ tự của một hệ dẫn đường thật khi nhận
   * một fix: tiến vị trí -> chiếu xuống tuyến -> kiểm tra lệch tuyến -> kiểm tra
   * đã tới điểm giao chưa.
   */
  private emitFix(): void {
    // Chốt chặn thứ hai cho lệnh dừng: `effect` dọn `setInterval` ở nhịp đồng bộ
    // kế tiếp chứ không tức thì, nên vẫn có thể lọt một nhịp sau khi đã dừng —
    // đủ để xe trôi qua điểm giao vừa tới nơi.
    if (!this._running()) return;

    // Tuyến đang được tính lại -> ĐỨNG YÊN chờ.
    //
    // Bỏ guard này là dính một lỗi rất khó lần ra: `waypoints` (danh sách điểm
    // chưa giao) đổi NGAY khi tài xế bấm "đã giao", trong khi `route` phải chờ
    // mạng vài trăm mili-giây mới về. Trong khoảng giữa đó, mốc quãng đường của
    // tuyến CŨ bị đem so với danh sách điểm MỚI — lệch đúng một điểm, đủ để hệ
    // thống tuyên bố "đã tới" điểm kế tiếp trong khi xe còn cách vài km.
    if (this.routeResource.isLoading()) return;

    // `length > 1`: provider không trả `legs` thì bỏ qua kiểm tra này, phần
    // "còn bao xa tới điểm kế tiếp" đã có nhánh dự phòng đường chim bay.
    const boundaries = this.boundaries();
    if (boundaries.length > 1 && boundaries.length !== this.waypoints().length + 1) return;

    const simSeconds = (this._speed() * TICK_MS) / 1000;

    this._tick.update((t) => t + 1);
    this._clock.update((iso) => addSeconds(iso, simSeconds));
    this._travelled.update((m) => m + this.currentSpeedMps() * simSeconds);

    // Lệch tuyến mô phỏng: tăng dần cho tới ~200 m rồi giữ nguyên.
    if (this._detour()) this._drift.update((d) => Math.min(d + 18 * this._speed(), 200));

    const next = updateOffRoute(this._offRoute(), this.projection().lateralMeters, {
      thresholdMeters: 60,
      confirmFixes: 3,
      clearMeters: 30,
    });
    this._offRoute.set(next);

    if (next.justTriggered) {
      this.pushLog(
        `Đi chệch tuyến ${Math.round(next.lastLateralMeters)} m — đang tính lại đường`,
        'reroute',
      );
      this.reroute('Tự động định tuyến lại từ vị trí hiện tại');
      return;
    }

    this.updateFollow();
    this.checkArrival();
  }

  /**
   * Đã tới điểm giao chưa?
   *
   * So bằng bán kính (`ARRIVAL_RADIUS_METERS`) chứ không so mốc quãng đường:
   * điểm giao nằm trong ngõ, tim đường gần nhất có thể cách cửa hàng 30 m và xe
   * không bao giờ "đi qua" đúng toạ độ đó.
   */
  /**
   * Đã tới điểm giao chưa?
   *
   * HAI ĐIỀU KIỆN, thiếu cái nào cũng sai:
   *  - **Vào bán kính geofence**: cách nhận biết tự nhiên nhất, đúng với hệ thật.
   *  - **Đi quá mốc chặng**: cứu hai trường hợp mà điều kiện trên trượt — cửa
   *    hàng nằm sâu trong ngõ (tim đường gần nhất cách cửa hơn bán kính), và bản
   *    ghi GPS thưa hơn bán kính (xe "nhảy" qua điểm mà không bản ghi nào rơi
   *    vào trong vòng tròn).
   *
   * Khi tới nơi thì kéo xe về đúng mốc chặng: xe phải đứng TẠI cửa hàng chứ
   * không phải đứng ở chỗ nó vô tình được lấy mẫu, nếu không marker sẽ nằm cách
   * điểm giao cả trăm mét trong lúc màn hình báo "đã tới nơi".
   */
  private checkArrival(): void {
    if (this._arrivedStop()) return;

    const target = this.nextWaypoint();
    if (!target) return;

    const boundaries = this.boundaries();
    const boundary = boundaries[this.targetIndex() + 1];

    const straight = distanceMeters(this.position(), target.point);
    const passedBoundary = boundary != null && this._travelled() >= boundary - 5;

    if (straight > ARRIVAL_RADIUS_METERS && !passedBoundary) return;

    if (boundary != null) this._travelled.set(boundary);

    // Waypoint cuối là kho -> kết thúc chuyến, không có gì để xác nhận giao.
    if (!target.stop) {
      this._running.set(false);
      this.pushLog('Đã về kho — kết thúc chuyến', 'done');
      return;
    }

    this._legIndex.update((i) => i + 1);
    this._arrivedStop.set(target.stop);
    this._running.set(false);
    this._focusPoint.set({ ...this.position() });
    this.pushLog(
      `Đã tới ${target.stop.customerName} (cách cửa ${Math.round(distanceMeters(this.position(), target.point))} m)`,
      'arrive',
    );
  }

  private pushLog(text: string, kind: string): void {
    const time = this._clock();
    this._log.update((items) => [{ time, text, kind }, ...items].slice(0, 40));
  }

  // ------------------------------------------------------- dữ liệu cho bản đồ

  readonly paths = computed<MapPath[]>(() => {
    const path = this.routePath();
    if (path.length < 2) return [];

    const { index, snapped } = this.projection();
    const travelled = [...path.slice(0, index + 1), snapped];
    const ahead = [snapped, ...path.slice(index + 1)];

    return [
      // Phần đã đi lùi xuống nền xám: mắt tài xế chỉ cần nhìn phần phía trước.
      { key: 'done', points: travelled, color: '#94a3b8', weight: 5, opacity: 0.75 },
      {
        key: 'ahead',
        points: ahead,
        color: this.offRoute() ? MAP_COLORS.deviation : '#2563eb',
        weight: 7,
        opacity: 0.95,
      },
    ];
  });

  readonly markers = computed<MapMarker[]>(() => {
    const trip = this.trip();
    if (!trip) return [];

    const done = this._doneStopIds();
    const next = this.nextWaypoint();

    const stops: MapMarker[] = [...trip.stops]
      .sort((a, b) => a.seq - b.seq)
      .map((stop) => ({
        key: `stop-${stop.id}`,
        lat: stop.lat,
        lng: stop.lng,
        label: String(stop.seq),
        title: stop.customerName,
        description: `${stop.address}<br>${stop.orderCode}`,
        color: done.has(stop.id)
          ? MAP_COLORS.done
          : next?.stop?.id === stop.id
            ? '#2563eb'
            : MAP_COLORS.pending,
        active: next?.stop?.id === stop.id,
      }));

    return [
      {
        key: 'depot',
        lat: trip.depot.lat,
        lng: trip.depot.lng,
        label: '🏭',
        title: trip.depot.name,
        description: trip.depot.address,
        color: '#0f172a',
      },
      ...stops,
      // Toạ độ thô của thiết bị — trưng ra để thấy rõ phần sai số đã được nắn.
      {
        key: 'raw-fix',
        lat: this.rawFix().lat,
        lng: this.rawFix().lng,
        label: '',
        title: 'Toạ độ thiết bị báo về (chưa bám đường)',
        description: `Lệch tim đường ${this.gpsErrorMeters()} m`,
        color: '#f97316',
        dot: true,
      },
    ];
  });

  readonly vehicle = computed<MapMarker | null>(() => {
    if (this.routePath().length < 2) return null;
    const p = this.position();

    return {
      key: 'vehicle',
      lat: p.lat,
      lng: p.lng,
      label: '🚚',
      title: this.trip()?.vehiclePlate ?? 'Xe',
      description: `${this.speedKmh()} km/h`,
      color: this.offRoute() ? MAP_COLORS.deviation : '#2563eb',
    };
  });

  readonly circles = computed<MapCircle[]>(() => {
    const next = this.nextWaypoint();
    if (!next) return [];

    return [
      {
        key: 'arrival-fence',
        center: next.point,
        radiusMeters: ARRIVAL_RADIUS_METERS,
        color: MAP_COLORS.done,
        fillOpacity: 0.08,
        dashed: true,
        title: `Vào vùng này là tính đã tới ${next.label}`,
      },
    ];
  });

  /**
   * Khung nhìn bám theo xe.
   *
   * KHÔNG trả thẳng `position()`: `focus` được component bản đồ thực hiện bằng
   * `flyTo` (animation 0,6 s), mà bộ phát bắn fix mỗi 0,5 s — trả vị trí tức thời
   * là mỗi animation bị chính nó huỷ giữa chừng, bản đồ giật liên tục và người
   * dùng không kéo bản đồ đi đâu được. Nên chỉ dời khung nhìn khi xe đã đi xa
   * quá `FOLLOW_STEP_METERS` so với lần dời trước.
   */
  private readonly _focusPoint = signal<LatLng | null>(null);
  readonly focus = this._focusPoint.asReadonly();

  private updateFollow(): void {
    if (!this._follow()) return;

    const here = this.position();
    const last = this._focusPoint();
    if (last && distanceMeters(last, here) < FOLLOW_STEP_METERS) return;

    this._focusPoint.set({ ...here });
  }
}

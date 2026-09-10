import { Injectable, computed, effect, inject, resource, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import {
  LatLng,
  MAP_COLORS,
  MapMarker,
  MapPath,
  GeocodeFacade,
  MapProviderService,
  RouteResult,
  RouteStep,
  RoutingFacade,
  TravelMode,
  googleMapsDirectionUrl,
  optimizeWaypointOrder,
} from '../../core/map';

/** Một điểm dừng người dùng đã chọn trên màn Chỉ đường. */
export interface Waypoint extends LatLng {
  id: string;
  label: string;
  /** Địa chỉ đầy đủ — điền sau khi reverse geocode xong. */
  address: string;
  /**
   * Điểm đã được kéo về tim đường gần nhất chưa, và kéo bao xa (mét).
   * `undefined` = chưa qua bước bám đường (điểm dựng sẵn, hoặc đã tắt tính năng).
   */
  snapOffsetMeters?: number;
  /** Tên con đường mà điểm đã bám vào. */
  snapRoadName?: string;
}

export const TRAVEL_MODES: { value: TravelMode; label: string; icon: string }[] = [
  { value: 'driving', label: 'Ô tô', icon: '🚗' },
  { value: 'motorbike', label: 'Xe máy', icon: '🛵' },
  { value: 'cycling', label: 'Xe đạp', icon: '🚲' },
  { value: 'walking', label: 'Đi bộ', icon: '🚶' },
];

/** Vài điểm dựng sẵn để mở màn hình lên là có ngay thứ để bấm. */
const SEED_WAYPOINTS: Waypoint[] = [
  {
    id: 'wp-1',
    label: 'Kho Long Biên',
    address: 'Ngọc Lâm, Long Biên, Hà Nội',
    lat: 21.0447,
    lng: 105.8752,
  },
  {
    id: 'wp-2',
    label: 'Siêu thị mini Bà Triệu',
    address: '191 Bà Triệu, Hai Bà Trưng, Hà Nội',
    lat: 21.0126,
    lng: 105.8489,
  },
  {
    id: 'wp-3',
    label: 'Đại lý Cầu Giấy',
    address: '99 Trần Duy Hưng, Cầu Giấy, Hà Nội',
    lat: 21.0333,
    lng: 105.797,
  },
];

/**
 * ==================== STATE MÀN CHỈ ĐƯỜNG ====================
 *
 * Luồng dữ liệu hoàn toàn khai báo (declarative), không có `subscribe` thủ công:
 *
 *   waypoints + travelMode + provider ──► routeResource ──► path / km / phút / chỉ dẫn
 *                    ▲                                            │
 *                    │                                            ▼
 *   click bản đồ / chọn kết quả tìm kiếm            computed: markers, paths, ETA
 *
 * Vì `routeResource` khai báo `params` gồm cả `provider`, chỉ cần đổi nhà cung
 * cấp bản đồ ở thanh trên là lộ trình tự tính lại bằng dịch vụ tương ứng —
 * không cần một dòng code điều phối nào ở component.
 */
@Injectable()
export class DirectionsStore {
  private readonly routing = inject(RoutingFacade);
  private readonly geocode = inject(GeocodeFacade);
  private readonly mapProvider = inject(MapProviderService);

  private readonly _waypoints = signal<Waypoint[]>(SEED_WAYPOINTS);
  private readonly _travelMode = signal<TravelMode>('driving');
  private readonly _pickMode = signal(false);
  private readonly _focus = signal<LatLng | null>(null);
  private readonly _activeStepIndex = signal<number | null>(null);

  readonly waypoints = this._waypoints.asReadonly();
  readonly travelMode = this._travelMode.asReadonly();
  readonly pickMode = this._pickMode.asReadonly();
  readonly focus = this._focus.asReadonly();
  readonly activeStepIndex = this._activeStepIndex.asReadonly();

  // ---------------------------------------------------------- tìm kiếm địa chỉ

  private readonly _query = signal('');
  private readonly _debouncedQuery = signal('');
  readonly query = this._query.asReadonly();

  /**
   * `rxResource` = `resource` nhưng loader trả Observable.
   * Nó tự huỷ request cũ khi `params` đổi, nên không bao giờ có chuyện kết quả
   * của từ khoá cũ về sau và ghi đè kết quả mới (race condition kinh điển của
   * ô tìm kiếm viết bằng `subscribe` thủ công).
   */
  readonly searchResults = rxResource({
    // `provider` nằm trong params để đổi nhà cung cấp là tìm lại bằng dịch vụ
    // geocode tương ứng (Google khi có key, Nominatim khi không).
    params: () => ({ term: this._debouncedQuery(), provider: this.mapProvider.provider() }),
    stream: ({ params }) => (params.term.length < 3 ? of([]) : this.geocode.search(params.term)),
  });

  /** Tên dịch vụ geocode đang dùng — hiển thị dưới ô tìm kiếm. */
  readonly geocodeProviderLabel = computed(() => {
    this.mapProvider.provider();
    return this.geocode.providerLabel();
  });

  // -------------------------------------------------------------- định tuyến

  /**
   * Tính theo tình trạng giao thông hiện tại. Mặc định TẮT.
   *
   * Để công tắc này lộ ra màn hình vì tác động của nó lớn hơn nhiều so với tên
   * gọi — nó đổi cả ĐƯỜNG ĐI chứ không chỉ số phút. Đo thật trên chặng
   * Ngọc Lâm -> Bà Triệu: tắt = 6.792 m qua cầu Chương Dương, bật = 10.787 m vì
   * Google né Chương Dương. Người dùng phải tự bấm và tự thấy chênh lệch, thay
   * vì bị một mặc định ẩn quyết định hộ.
   */
  private readonly _trafficAware = signal(false);
  readonly trafficAware = this._trafficAware.asReadonly();

  toggleTrafficAware(): void {
    this._trafficAware.update((v) => !v);
  }

  private readonly routeResource = resource({
    params: () => ({
      points: this._waypoints().map((w) => ({ lat: w.lat, lng: w.lng })),
      travelMode: this._travelMode(),
      provider: this.mapProvider.provider(),
      trafficAware: this._trafficAware(),
    }),
    loader: ({ params }) =>
      this.routing.computeRoutes({
        points: params.points,
        travelMode: params.travelMode,
        withSteps: true,
        trafficAware: params.trafficAware,
        // Phương án thay thế CHỈ có ý nghĩa với tuyến 2 điểm — cả OSRM lẫn Google
        // đều bỏ qua tham số này khi có waypoint trung gian. Không xin khi thừa
        // để khỏi tốn thêm dữ liệu (Google tính tiền theo FieldMask).
        alternatives: params.points.length === 2,
      }),
  });

  readonly loading = computed(() => this.routeResource.isLoading());
  readonly error = computed(() => {
    const err = this.routeResource.error();
    return err ? (err as Error).message : null;
  });

  /**
   * NGUỒN ĐỊNH TUYẾN — khác hẳn `geocodeProviderLabel`.
   *
   * Trước đây màn hình chỉ hiện "Nguồn: Google Geocoding", tức nguồn TÌM ĐỊA CHỈ.
   * Người xem không có cách nào biết con số km/phút do ai tính. Từ khi có cơ chế
   * dự phòng (Google hỏng -> OSRM) thì thiếu dòng này là mù hẳn.
   */
  readonly routingSourceLabel = computed(() => this.selectedRoute()?.source?.label ?? '');

  /**
   * Cảnh báo khi hồ sơ định tuyến KHÔNG đúng phương tiện đã chọn (ví dụ xe máy
   * chạy bằng hồ sơ ô tô vì OSRM công cộng không có profile xe máy), hoặc khi
   * tuyến dài phải ghép nhiều request.
   */
  readonly routingNote = computed(() => this.selectedRoute()?.source?.note ?? '');

  /**
   * `true` khi km/phút đang hiện KHÔNG do nguồn ứng với bản đồ đã chọn tính ra.
   * UI phải nhấn mạnh chỗ này — nếu không, người dùng chọn bản đồ Google rồi
   * tin rằng con số trước mắt là của Google.
   */
  readonly routingSwitched = computed(() => this.selectedRoute()?.source?.switched === true);

  /**
   * Hệ số vòng = quãng đường thật / đường chim bay. Hiện thẳng ra màn hình để
   * người dùng tự đánh giá tuyến, đúng cái mà lỗi "đi bộ 21 km" đã che giấu:
   * lúc đó màn hình chỉ có "21,7 km" — một con số không có gì để đối chiếu.
   */
  readonly detourRatio = computed(() => this.selectedRoute()?.source?.detourRatio);

  /** `"4,8×"` — đã làm tròn sẵn để template không cần `DecimalPipe`. */
  readonly detourLabel = computed(() => {
    const ratio = this.detourRatio();
    return ratio === undefined || !Number.isFinite(ratio)
      ? ''
      : `${ratio.toFixed(1).replace('.', ',')}×`;
  });

  /** Vòng hơn 2,5 lần đường chim bay -> tô cảnh báo, xem `IMPLAUSIBLE_DETOUR_RATIO`. */
  readonly detourSuspicious = computed(() => (this.detourRatio() ?? 0) > 2.5);

  /**
   * ============ PHƯƠNG ÁN ĐI ĐƯỜNG KHÁC ============
   *
   * Google Maps luôn đưa 2–3 phương án ("nhanh hơn 3 phút", "ít đèn đỏ hơn") vì
   * tuyến ngắn nhất không phải lúc nào cũng là tuyến người ta muốn đi. Với vận
   * tải, lý do còn thực tế hơn: tuyến ngắn nhất có thể đi qua phố cấm tải, cầu
   * hạn trọng, hoặc khu vực tắc cứng giờ cao điểm mà chỉ tài xế mới biết.
   */
  /**
   * ⚠️ PHẢI HỎI `hasValue()` TRƯỚC KHI ĐỌC `value()`.
   *
   * `resource.value()` của Angular **ném lại lỗi** khi resource đang ở trạng thái
   * lỗi. Viết `this.routeResource.value() ?? []` nghĩa là mọi computed đọc theo
   * (`routePath`, `distanceMeters`, `steps`, `paths`...) đều ném theo — nên khi
   * provider không tìm được tuyến, thay vì thấy dòng "Không tính được lộ trình",
   * người dùng thấy cả màn hình trắng.
   *
   * Đúng cái bẫy này làm màn Chỉ đường vỡ khi chọn xe đạp: lỗi không còn bị che
   * bởi tuyến giả `0 m` nữa, nên nó nổi lên thành lỗi render.
   */
  readonly alternatives = computed<RouteResult[]>(() =>
    this.routeResource.hasValue() ? this.routeResource.value() : [],
  );

  private readonly _routeIndex = signal(0);
  readonly routeIndex = this._routeIndex.asReadonly();

  private readonly selectedRoute = computed<RouteResult | undefined>(() => {
    const list = this.alternatives();
    return list[this._routeIndex()] ?? list[0];
  });

  selectRoute(index: number): void {
    this._routeIndex.set(index);
  }

  readonly routePath = computed<LatLng[]>(() => this.selectedRoute()?.path ?? []);
  readonly distanceMeters = computed(() => this.selectedRoute()?.distanceMeters ?? 0);
  readonly durationSeconds = computed(() => this.selectedRoute()?.durationSeconds ?? 0);
  readonly steps = computed<RouteStep[]>(() => this.selectedRoute()?.steps ?? []);

  /** Giờ dự kiến tới nơi nếu xuất phát ngay bây giờ. */
  readonly eta = computed(() => {
    const seconds = this.durationSeconds();
    if (!seconds) return '';
    const at = new Date(Date.now() + seconds * 1000);
    return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  });

  /** Deep-link mở app Google Maps để dẫn đường thật ngoài đường. */
  readonly googleDirectionUrl = computed(() => {
    const list = this._waypoints();
    if (list.length < 2) return '';

    const modeMap: Record<TravelMode, 'driving' | 'walking' | 'bicycling' | 'two-wheeler'> = {
      driving: 'driving',
      motorbike: 'two-wheeler',
      cycling: 'bicycling',
      walking: 'walking',
    };

    return googleMapsDirectionUrl(
      list[0],
      list[list.length - 1],
      list.slice(1, -1),
      modeMap[this._travelMode()],
    );
  });

  // ------------------------------------------------------- dữ liệu cho bản đồ

  readonly markers = computed<MapMarker[]>(() =>
    this._waypoints().map((w, i, all) => ({
      key: w.id,
      lat: w.lat,
      lng: w.lng,
      label: i === 0 ? 'A' : i === all.length - 1 ? 'B' : String(i + 1),
      title: w.label,
      description: w.address,
      color:
        i === 0 ? MAP_COLORS.done : i === all.length - 1 ? MAP_COLORS.deviation : MAP_COLORS.real,
    })),
  );

  readonly paths = computed<MapPath[]>(() => {
    const result: MapPath[] = [];

    // Đường chim bay nối các điểm — giúp thấy ngay khi dịch vụ định tuyến chết,
    // và làm nền so sánh với đường đi thật.
    if (this._waypoints().length > 1) {
      result.push({
        key: 'direct',
        points: this._waypoints().map((w) => ({ lat: w.lat, lng: w.lng })),
        color: '#cbd5e1',
        weight: 2,
        dashed: true,
      });
    }

    // Các phương án KHÔNG được chọn: vẽ mờ phía dưới để so sánh bằng mắt.
    // Vẽ trước tuyến chính để tuyến chính luôn nằm trên cùng.
    this.alternatives().forEach((route, i) => {
      if (i === this._routeIndex() || route.path.length < 2) return;
      result.push({
        key: `alt-${i}`,
        points: route.path,
        color: '#94a3b8',
        weight: 4,
        opacity: 0.55,
      });
    });

    if (this.routePath().length > 1) {
      result.push({ key: 'route', points: this.routePath(), color: MAP_COLORS.real, weight: 6 });
    }

    return result;
  });

  /** Ép bản đồ fit lại mỗi khi tuyến đổi. */
  readonly fitToken = computed(() => `${this._waypoints().length}-${this.routePath().length}`);

  constructor() {
    // Debounce ô tìm kiếm 400ms — Nominatim giới hạn 1 request/giây, gõ tới đâu
    // gọi tới đó là bị chặn IP.
    effect((onCleanup) => {
      const value = this._query();
      const timer = setTimeout(() => this._debouncedQuery.set(value), 400);
      onCleanup(() => clearTimeout(timer));
    });

    // Đổi danh sách điểm -> phương án cũ không còn tồn tại, con trỏ chọn phải về 0.
    // Không reset thì index 2 của tuyến cũ trỏ vào mảng mới chỉ có 1 phần tử,
    // và màn hình rơi về `list[0]` một cách âm thầm — người dùng tưởng đang xem
    // phương án mình chọn.
    //
    // `provider` PHẢI nằm trong danh sách này: đổi từ OSRM (hay trả 3 phương án)
    // sang Google (có waypoint trung gian thì luôn trả đúng 1) mà giữ index 2 là
    // đúng cái bẫy trên. Ba dòng đọc signal dưới đây là phần thân của effect,
    // không phải code thừa.
    effect(() => {
      this._waypoints();
      this._travelMode();
      this.mapProvider.provider();
      this._routeIndex.set(0);
    });
  }

  // ------------------------------------------------------------------ lệnh

  setQuery(value: string): void {
    this._query.set(value);
  }

  clearSearch(): void {
    this._query.set('');
    this._debouncedQuery.set('');
  }

  setTravelMode(mode: TravelMode): void {
    this._travelMode.set(mode);
  }

  togglePickMode(): void {
    this._pickMode.update((v) => !v);
  }

  /** Thêm điểm từ kết quả tìm kiếm. */
  addWaypoint(point: LatLng, label: string, address = ''): void {
    this._waypoints.update((list) => [
      ...list,
      { id: `wp-${Date.now()}-${list.length}`, label, address, lat: point.lat, lng: point.lng },
    ]);
    this.clearSearch();
  }

  /**
   * Thêm điểm bằng cách bấm lên bản đồ.
   *
   * Toạ độ có ngay, còn địa chỉ và vị trí bám đường thì vá vào sau — không bắt
   * người dùng chờ mạng mới thấy điểm hiện lên.
   *
   * BÁM ĐƯỜNG (`snapToRoad`) quan trọng hơn vẻ ngoài của nó: người dùng bấm vào
   * mái nhà chứ không bấm trúng tim đường. Không bám thì máy chủ định tuyến tự
   * bám theo cách của nó mà không báo lại, nên đường vẽ ra bắt đầu ở một chỗ
   * lệch với cái ghim đang hiển thị — nhìn như "đường không nối tới marker".
   * Xem `OsrmNearestService` để hiểu vì sao đây là nguồn sai số lớn.
   */
  addWaypointFromMap(point: LatLng): void {
    const id = `wp-${Date.now()}`;
    const fallback = `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;

    this._waypoints.update((list) => [
      ...list,
      { id, label: `Điểm ${list.length + 1}`, address: fallback, lat: point.lat, lng: point.lng },
    ]);

    this.geocode.reverse(point).subscribe((address) => {
      this._waypoints.update((list) =>
        list.map((w) => (w.id === id ? { ...w, address, label: address.split(',')[0] } : w)),
      );
    });

    if (this._snapToRoad()) void this.snapWaypoint(id, point);
  }

  // ------------------------------------------------------------ bám đường

  private readonly _snapToRoad = signal(true);
  private readonly _snapping = signal(0);

  readonly snapToRoad = this._snapToRoad.asReadonly();
  readonly snapping = computed(() => this._snapping() > 0);

  /** Tổng quãng "bấm hụt" đã được nắn lại — con số cho thấy tính năng có tác dụng. */
  readonly totalSnapOffsetMeters = computed(() =>
    this._waypoints().reduce((sum, w) => sum + (w.snapOffsetMeters ?? 0), 0),
  );

  toggleSnapToRoad(): void {
    this._snapToRoad.update((v) => !v);
  }

  /**
   * Kéo một điểm về tim đường gần nhất.
   *
   * Chỉ dịch điểm khi lệch **quá 3 m**: dưới ngưỡng đó thì việc dịch chuyển chỉ
   * làm ghim nhấp nháy mà không thay đổi gì về kết quả định tuyến.
   */
  private async snapWaypoint(id: string, point: LatLng): Promise<void> {
    this._snapping.update((n) => n + 1);

    try {
      const snapped = await this.routing.snap(point, 60);
      if (!snapped.matched || snapped.offsetMeters < 3) return;

      this._waypoints.update((list) =>
        list.map((w) =>
          w.id === id
            ? {
                ...w,
                lat: snapped.snapped.lat,
                lng: snapped.snapped.lng,
                snapOffsetMeters: snapped.offsetMeters,
                snapRoadName: snapped.roadName,
              }
            : w,
        ),
      );
    } finally {
      this._snapping.update((n) => Math.max(0, n - 1));
    }
  }

  /**
   * Bám lại TẤT CẢ điểm đang có — dùng khi bật tính năng sau khi đã chọn điểm.
   *
   * ⚠️ GHÉP KẾT QUẢ THEO `id`, KHÔNG THEO CHỈ SỐ MẢNG.
   *
   * `snapMany` là hàng chục request nối tiếp (OSRM rate-limit). Trong lúc chờ,
   * người dùng hoàn toàn có thể đảo thứ tự, xoá hay thêm điểm — bản cũ dùng
   * `current.map((w, i) => results[i])` nên sau một thao tác đảo chỗ, toạ độ bám
   * đường của điểm A bị gán cho điểm B. Kết quả: hai ghim nhảy sang vị trí của
   * nhau, còn tuyến thì vẫn vẽ ra bình thường.
   */
  async snapAll(): Promise<void> {
    const list = this._waypoints();
    if (!list.length) return;

    this._snapping.update((n) => n + 1);

    try {
      const results = await this.routing.snapMany(
        list.map((w) => ({ lat: w.lat, lng: w.lng })),
        60,
      );

      // Chụp lại danh tính tại thời điểm GỬI ĐI, rồi tra ngược theo id khi về.
      const byId = new Map(list.map((w, i) => [w.id, results[i]]));

      this._waypoints.update((current) =>
        current.map((w) => {
          const r = byId.get(w.id);
          // Điểm mới thêm trong lúc chờ: chưa từng gửi đi, để nguyên.
          if (!r?.matched || r.offsetMeters < 3) return w;

          return {
            ...w,
            lat: r.snapped.lat,
            lng: r.snapped.lng,
            snapOffsetMeters: r.offsetMeters,
            snapRoadName: r.roadName,
          };
        }),
      );
    } finally {
      this._snapping.update((n) => Math.max(0, n - 1));
    }
  }

  removeWaypoint(id: string): void {
    this._waypoints.update((list) => list.filter((w) => w.id !== id));
  }

  move(id: string, direction: -1 | 1): void {
    this._waypoints.update((list) => {
      const index = list.findIndex((w) => w.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= list.length) return list;

      const next = [...list];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  reverse(): void {
    this._waypoints.update((list) => [...list].reverse());
  }

  clearAll(): void {
    this._waypoints.set([]);
    this._activeStepIndex.set(null);
  }

  /** Sắp xếp lại các điểm TRUNG GIAN cho tổng đường ngắn nhất (giữ A và B). */
  optimize(): void {
    this._waypoints.update((list) => optimizeWaypointOrder(list));
  }

  /** Bấm vào một chỉ dẫn rẽ -> bay tới đúng ngã rẽ đó. */
  focusStep(index: number): void {
    const step = this.steps()[index];
    if (!step) return;
    this._activeStepIndex.set(index);
    // Tạo object mới mỗi lần để signal luôn báo thay đổi, kể cả khi bấm lại
    // đúng chặng cũ (người dùng hay bấm 2 lần để "bay lại").
    this._focus.set({ ...step.location });
  }

  focusWaypoint(w: Waypoint): void {
    this._focus.set({ lat: w.lat, lng: w.lng });
  }
}

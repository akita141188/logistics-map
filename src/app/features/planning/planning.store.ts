import { Injectable, computed, inject, signal } from '@angular/core';
import {
  CostMatrix,
  LatLng,
  MAP_COLORS,
  MapMarker,
  MapPath,
  RoutingFacade,
  VrpStop,
  formatTimeLabel,
  routeCost,
  solveCvrp,
} from '../../core/map';
import { PlanningMockApi } from './planning-mock.api';
import {
  DeliveryOrder,
  PlanSummary,
  PlannedRoute,
  PlannedStop,
  PlanningDepot,
  PlanningVehicle,
  hourToLabel,
} from './planning.models';

/** Tiến trình của một lần chạy tối ưu — để nút bấm không "đơ" trong im lặng. */
export type PlanPhase = 'idle' | 'matrix' | 'solving' | 'routing' | 'done' | 'error';

export const PLAN_PHASE_LABEL: Record<PlanPhase, string> = {
  idle: 'Chưa lập kế hoạch',
  matrix: 'Đang lấy ma trận khoảng cách đường thật…',
  solving: 'Đang chia tuyến (Clarke-Wright + 2-opt)…',
  routing: 'Đang vẽ đường đi thật cho từng xe…',
  done: 'Đã lập xong kế hoạch',
  error: 'Lập kế hoạch thất bại',
};

/**
 * ============== STATE MÀN LẬP KẾ HOẠCH & PHÂN XE ==============
 *
 * Đây là phần "trước khi xe lăn bánh" của một hệ vận tải, đối xứng với màn Giám
 * sát (phần "trong khi xe chạy").
 *
 * BA BƯỚC, TÁCH BẠCH CÓ LÝ DO:
 *
 *   1. MA TRẬN  — hỏi server quãng đường thật giữa mọi cặp điểm. Tốn mạng, chậm
 *                 nhất, nhưng chỉ cần làm MỘT LẦN cho một tập đơn.
 *   2. CHIA TUYẾN — thuần CPU, chạy trên ma trận đã có. Vài mili-giây. Vì vậy
 *                 người dùng chỉnh tay (chuyển đơn sang xe khác) thì tính lại
 *                 tức thì, KHÔNG cần gọi mạng lần nữa.
 *   3. VẼ ĐƯỜNG  — xin hình học bám phố cho từng tuyến để hiển thị.
 *
 * Gộp ba bước làm một là sai lầm thiết kế kinh điển: mỗi lần người dùng kéo một
 * đơn từ xe này sang xe kia lại phải chờ mạng vài giây, thao tác điều vận trở
 * nên không dùng được.
 */
@Injectable()
export class PlanningStore {
  private readonly api = inject(PlanningMockApi);
  private readonly routing = inject(RoutingFacade);

  readonly depot: PlanningDepot = this.api.getDepot();

  private readonly _orders = signal<DeliveryOrder[]>(this.api.getOrders());
  private readonly _vehicles = signal<PlanningVehicle[]>(this.api.getVehicles());

  readonly orders = this._orders.asReadonly();
  readonly vehicles = this._vehicles.asReadonly();

  readonly availableVehicles = computed(() => this._vehicles().filter((v) => v.available));

  /** Đơn được chọn đưa vào bài toán (bỏ chọn = để lại hôm sau). */
  private readonly _selectedOrderIds = signal<Set<string>>(
    new Set(this.api.getOrders().map((o) => o.id)),
  );

  readonly selectedOrders = computed(() =>
    this._orders().filter((o) => this._selectedOrderIds().has(o.id)),
  );

  isSelected(orderId: string): boolean {
    return this._selectedOrderIds().has(orderId);
  }

  // ------------------------------------------------------------- kết quả

  private readonly _phase = signal<PlanPhase>('idle');
  private readonly _error = signal<string | null>(null);
  private readonly _matrix = signal<CostMatrix | null>(null);
  /** `vehicleId -> danh sách orderId theo thứ tự ghé thăm`. Đây là "kế hoạch". */
  private readonly _assignment = signal<Map<string, string[]>>(new Map());
  private readonly _unassigned = signal<string[]>([]);
  private readonly _paths = signal<Map<string, LatLng[]>>(new Map());
  private readonly _naiveDistance = signal(0);
  private readonly _selectedVehicleId = signal<string | null>(null);
  private readonly _focus = signal<LatLng | null>(null);
  private readonly _highlightOrderId = signal<string | null>(null);
  /** Lý do lần kéo đơn gần nhất bị từ chối (quá tải / quá số điểm). */
  private readonly _moveError = signal<string | null>(null);

  readonly phase = this._phase.asReadonly();
  readonly error = this._error.asReadonly();
  readonly moveError = this._moveError.asReadonly();
  readonly unassignedIds = this._unassigned.asReadonly();
  readonly selectedVehicleId = this._selectedVehicleId.asReadonly();
  readonly focus = this._focus.asReadonly();
  readonly highlightOrderId = this._highlightOrderId.asReadonly();

  readonly busy = computed(() =>
    ['matrix', 'solving', 'routing'].includes(this._phase()),
  );

  readonly hasPlan = computed(() => this._assignment().size > 0);

  readonly unassignedOrders = computed(() => {
    const ids = new Set(this._unassigned());
    return this._orders().filter((o) => ids.has(o.id));
  });

  // ------------------------------------------------------- dựng tuyến hiển thị

  /**
   * Chuyển "kế hoạch thô" (xe -> danh sách đơn) thành tuyến đầy đủ có giờ giấc.
   *
   * Đây là computed, không phải kết quả trả về từ thuật toán — nghĩa là mọi thay
   * đổi thủ công (chuyển đơn, đổi thứ tự, đổi xe) đều tự động cập nhật giờ dự
   * kiến, tải trọng, chi phí và cảnh báo lệch khung giờ, không cần chạy lại gì.
   */
  readonly routes = computed<PlannedRoute[]>(() => {
    const matrix = this._matrix();
    const assignment = this._assignment();
    const orders = this.selectedOrders();
    if (!matrix || !assignment.size) return [];

    // Chỉ số trong ma trận: 0 = kho, i+1 = orders[i].
    const indexOf = new Map(orders.map((o, i) => [o.id, i + 1]));
    const orderById = new Map(orders.map((o) => [o.id, o]));

    const departMs = this.hourToMs(this.depot.departHour);
    const paths = this._paths();

    const result: PlannedRoute[] = [];

    for (const vehicle of this._vehicles()) {
      const ids = assignment.get(vehicle.id);
      if (!ids?.length) continue;

      const nodes = ids.map((id) => indexOf.get(id)).filter((n): n is number => n != null);
      if (!nodes.length) continue;

      const stops: PlannedStop[] = [];
      let clock = departMs;
      let loadKg = 0;
      let violations = 0;

      nodes.forEach((node, i) => {
        const from = i === 0 ? 0 : nodes[i - 1];
        const legSeconds = matrix.durations[from][node];
        const legMeters = matrix.distances[from][node];

        clock += legSeconds * 1000;

        const order = orderById.get(ids[i])!;
        const hour = this.msToHour(clock);

        const violation =
          hour < order.windowFrom ? 'early' : hour > order.windowTo ? 'late' : null;
        if (violation) violations++;

        stops.push({
          order,
          seq: i + 1,
          etaMs: clock,
          windowViolation: violation,
          legDistanceMeters: legMeters,
          legDurationSeconds: legSeconds,
        });

        loadKg += order.weightKg;
        // Đứng lại giao xong mới đi tiếp — bỏ qua bước này là mọi ETA phía sau
        // sớm hơn thực tế 10–20 phút mỗi điểm, cộng dồn thành cả tiếng.
        clock += order.serviceMinutes * 60_000;
      });

      const cost = routeCost(nodes, matrix, 0);
      const serviceSeconds = stops.reduce((s, x) => s + x.order.serviceMinutes * 60, 0);
      const backToDepot = clock + matrix.durations[nodes[nodes.length - 1]][0] * 1000;

      result.push({
        vehicle,
        stops,
        distanceMeters: cost.distance,
        durationSeconds: cost.duration + serviceSeconds,
        loadKg,
        utilization: vehicle.capacityKg ? loadKg / vehicle.capacityKg : 0,
        costVnd: Math.round((cost.distance / 1000) * vehicle.costPerKm),
        backToDepotMs: backToDepot,
        path: paths.get(vehicle.id) ?? [],
        windowViolations: violations,
      });
    }

    return result;
  });

  readonly summary = computed<PlanSummary>(() => {
    const routes = this.routes();
    const assigned = routes.reduce((sum, r) => sum + r.stops.length, 0);

    return {
      routes: routes.length,
      assignedOrders: assigned,
      unassignedOrders: this._unassigned().length,
      totalDistanceMeters: routes.reduce((s, r) => s + r.distanceMeters, 0),
      totalDurationSeconds: routes.reduce((s, r) => s + r.durationSeconds, 0),
      totalCostVnd: routes.reduce((s, r) => s + r.costVnd, 0),
      totalWeightKg: routes.reduce((s, r) => s + r.loadKg, 0),
      averageUtilization: routes.length
        ? routes.reduce((s, r) => s + r.utilization, 0) / routes.length
        : 0,
      windowViolations: routes.reduce((s, r) => s + r.windowViolations, 0),
      naiveDistanceMeters: this._naiveDistance(),
      realMatrix: this._matrix()?.real ?? false,
    };
  });

  /** Phần trăm quãng đường tiết kiệm được so với "mỗi đơn một chuyến". */
  readonly savingRatio = computed(() => {
    const s = this.summary();
    if (!s.naiveDistanceMeters || !s.totalDistanceMeters) return 0;
    return 1 - s.totalDistanceMeters / s.naiveDistanceMeters;
  });

  // -------------------------------------------------------------- chạy tối ưu

  /**
   * Chạy toàn bộ quy trình lập kế hoạch.
   *
   * Thứ tự các `await` ở đây quan trọng: phải `set` phase TRƯỚC mỗi bước để
   * người dùng thấy màn hình đang làm gì. Bước ma trận với 19 điểm mất 1–3 giây
   * trên server công cộng; không báo gì thì người dùng bấm nút lần thứ hai.
   */
  async optimize(): Promise<void> {
    const orders = this.selectedOrders();
    const vehicles = this.availableVehicles();

    if (!orders.length || !vehicles.length) {
      this._error.set('Cần ít nhất 1 đơn hàng và 1 xe sẵn sàng.');
      this._phase.set('error');
      return;
    }

    this._error.set(null);

    try {
      // ---- Bước 1: ma trận chi phí thật.
      this._phase.set('matrix');
      const points: LatLng[] = [
        { lat: this.depot.lat, lng: this.depot.lng },
        ...orders.map((o) => ({ lat: o.lat, lng: o.lng })),
      ];
      const matrix = await this.routing.matrix(points);
      this._matrix.set(matrix);

      // ---- Bước 2: chia tuyến.
      this._phase.set('solving');
      const stops: VrpStop[] = orders.map((o) => ({
        id: o.id,
        lat: o.lat,
        lng: o.lng,
        demand: o.weightKg,
        serviceMinutes: o.serviceMinutes,
      }));

      const solution = solveCvrp(
        stops,
        vehicles.map((v) => ({
          id: v.id,
          name: v.plate,
          capacity: v.capacityKg,
          maxStops: v.maxStops,
        })),
        matrix,
      );

      const assignment = new Map<string, string[]>();
      for (const route of solution.routes) assignment.set(route.vehicleId, route.stopIds);

      this._assignment.set(assignment);
      this._unassigned.set(solution.unassigned);
      this._naiveDistance.set(solution.naiveDistanceMeters);
      this._selectedVehicleId.set(solution.routes[0]?.vehicleId ?? null);

      // ---- Bước 3: hình học đường đi.
      this._phase.set('routing');
      await this.refreshPaths();

      this._phase.set('done');
    } catch (e) {
      this._error.set(e instanceof Error ? e.message : 'Lỗi không xác định');
      this._phase.set('error');
    }
  }

  /**
   * Xin hình học đường đi thật cho từng tuyến.
   *
   * Gọi TUẦN TỰ từng xe. `Promise.all` nhanh hơn nhưng bắn 4–5 request cùng lúc
   * vào server OSRM công cộng là cách chắc chắn nhất để bị trả 429 và mất sạch
   * đường vẽ.
   */
  private async refreshPaths(): Promise<void> {
    const orderById = new Map(this._orders().map((o) => [o.id, o]));
    const paths = new Map<string, LatLng[]>();
    const depot: LatLng = { lat: this.depot.lat, lng: this.depot.lng };

    for (const [vehicleId, ids] of this._assignment()) {
      if (!ids.length) continue;

      const waypoints: LatLng[] = [
        depot,
        ...ids
          .map((id) => orderById.get(id))
          .filter((o): o is DeliveryOrder => !!o)
          .map((o) => ({ lat: o.lat, lng: o.lng })),
        depot,
      ];

      try {
        const route = await this.routing.computeRoute({ points: waypoints, travelMode: 'driving' });
        paths.set(vehicleId, route.path.length > 1 ? route.path : waypoints);
      } catch {
        // Không vẽ được đường bám phố thì nối thẳng — vẫn thấy được hình dạng
        // tuyến, còn số liệu km/giờ đã lấy từ ma trận nên không bị sai theo.
        paths.set(vehicleId, waypoints);
      }
    }

    this._paths.set(paths);
  }

  // ----------------------------------------------------- chỉnh tay kế hoạch

  /**
   * Chuyển một đơn sang xe khác (hoặc về danh sách chưa phân xe).
   *
   * Chèn vào **khe rẻ nhất** của xe đích chứ không nhét xuống cuối: nhét cuối
   * thì một đơn ở Đông Anh chuyển sang xe đang chạy tuyến Hà Đông sẽ tạo ra một
   * đoạn chạy không 30 km ở cuối tuyến, và người dùng tưởng thuật toán ngu.
   */
  moveOrder(orderId: string, toVehicleId: string | null): boolean {
    const matrix = this._matrix();
    const orders = this.selectedOrders();
    if (!matrix) return false;

    const indexOf = new Map(orders.map((o, i) => [o.id, i + 1]));
    const node = indexOf.get(orderId);
    if (node == null) return false;

    /*
     * ============ KIỂM TRA TRƯỚC KHI ĐỘNG VÀO KẾ HOẠCH ============
     *
     * Thuật toán CVRP tôn trọng `capacityKg` và `maxStops`. Nhưng kéo-thả tay
     * thì bản cũ bỏ qua hoàn toàn hai ràng buộc đó — người dùng dồn cả 20 đơn
     * lên một xe 800 kg và hệ thống nhận, vẽ tuyến đẹp, tính ra tiền. Tới lúc
     * tài xế ra bãi mới biết không xếp nổi hàng.
     *
     * Kiểm tra phải làm TRƯỚC MỌI THAO TÁC ghi: chỉ cần gỡ đơn khỏi xe cũ rồi
     * mới phát hiện xe mới không chứa được là đơn hàng bốc hơi khỏi kế hoạch.
     */
    const rejection = this.rejectionFor(orderId, toVehicleId);
    if (rejection) {
      this._moveError.set(rejection);
      return false;
    }
    this._moveError.set(null);

    const next = new Map(this._assignment());

    // Gỡ khỏi xe hiện tại.
    for (const [vid, ids] of next) {
      if (!ids.includes(orderId)) continue;
      next.set(
        vid,
        ids.filter((id) => id !== orderId),
      );
    }

    let unassigned = this._unassigned().filter((id) => id !== orderId);

    if (!toVehicleId) {
      unassigned = [...unassigned, orderId];
    } else {
      const current = next.get(toVehicleId) ?? [];
      const nodes = current.map((id) => indexOf.get(id)).filter((n): n is number => n != null);

      // Tìm khe chèn rẻ nhất theo ma trận THẬT.
      let bestIndex = current.length;
      let bestExtra = Number.POSITIVE_INFINITY;

      for (let i = 0; i <= nodes.length; i++) {
        const prev = i === 0 ? 0 : nodes[i - 1];
        const nextNode = i === nodes.length ? 0 : nodes[i];
        const extra =
          matrix.distances[prev][node] +
          matrix.distances[node][nextNode] -
          matrix.distances[prev][nextNode];

        if (extra < bestExtra) {
          bestExtra = extra;
          bestIndex = i;
        }
      }

      const updated = [...current];
      updated.splice(bestIndex, 0, orderId);
      next.set(toVehicleId, updated);
    }

    this._assignment.set(next);
    this._unassigned.set(unassigned);
    this._highlightOrderId.set(orderId);

    // Hình học phải vẽ lại vì thứ tự điểm đã đổi.
    void this.refreshPathsInBackground();
    return true;
  }

  /**
   * Lý do TỪ CHỐI một lần kéo đơn, `null` nếu hợp lệ.
   *
   * Ba chiều di chuyển và luật tương ứng:
   *  - xe A -> xe B     : xe B phải chứa nổi (tải + số điểm).
   *  - chưa phân -> xe B: y hệt trên.
   *  - xe B -> chưa phân: LUÔN cho phép. Bỏ bớt hàng khỏi một xe không thể làm
   *    xe đó quá tải; chặn chiều này là khoá cứng người dùng trong một kế hoạch
   *    họ không sửa được.
   */
  private rejectionFor(orderId: string, toVehicleId: string | null): string | null {
    if (!toVehicleId) return null;

    const vehicle = this._vehicles().find((v) => v.id === toVehicleId);
    if (!vehicle) return 'Không tìm thấy xe đích.';

    const order = this._orders().find((o) => o.id === orderId);
    if (!order) return 'Không tìm thấy đơn hàng.';

    const currentIds = this._assignment().get(toVehicleId) ?? [];
    // Kéo đơn về chính xe đang chở nó thì không có gì tăng thêm.
    if (currentIds.includes(orderId)) return null;

    const orderById = new Map(this._orders().map((o) => [o.id, o]));
    const currentLoad = currentIds.reduce((sum, id) => sum + (orderById.get(id)?.weightKg ?? 0), 0);

    if (currentLoad + order.weightKg > vehicle.capacityKg) {
      const over = Math.round(currentLoad + order.weightKg - vehicle.capacityKg);
      return `Xe ${vehicle.plate} chỉ chở được ${vehicle.capacityKg} kg — thêm đơn ${order.code} (${order.weightKg} kg) là vượt ${over} kg.`;
    }

    if (currentIds.length + 1 > vehicle.maxStops) {
      return `Xe ${vehicle.plate} chỉ chạy tối đa ${vehicle.maxStops} điểm/chuyến, hiện đã có ${currentIds.length}.`;
    }

    return null;
  }

  /** Xe đích này có nhận thêm được đơn không — dùng để làm mờ nút trên UI. */
  canMoveOrder(orderId: string, toVehicleId: string | null): boolean {
    return this.rejectionFor(orderId, toVehicleId) === null;
  }

  dismissMoveError(): void {
    this._moveError.set(null);
  }

  /** Đổi vị trí một đơn trong cùng tuyến. */
  moveWithinRoute(vehicleId: string, orderId: string, direction: -1 | 1): void {
    const next = new Map(this._assignment());
    const ids = [...(next.get(vehicleId) ?? [])];

    const index = ids.indexOf(orderId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;

    [ids[index], ids[target]] = [ids[target], ids[index]];
    next.set(vehicleId, ids);

    this._assignment.set(next);
    void this.refreshPathsInBackground();
  }

  /** Chạy lại 2-opt cho MỘT tuyến, dùng ma trận đã có (không gọi mạng). */
  optimizeRoute(vehicleId: string): void {
    const matrix = this._matrix();
    const ids = this._assignment().get(vehicleId);
    if (!matrix || !ids || ids.length < 3) return;

    const orders = this.selectedOrders();
    const indexOf = new Map(orders.map((o, i) => [o.id, i + 1]));
    const nodeToId = new Map(orders.map((o, i) => [i + 1, o.id]));

    const nodes = ids.map((id) => indexOf.get(id)).filter((n): n is number => n != null);

    // Dùng lại chính `solveCvrp` với đúng MỘT xe tải trọng vô hạn: nó sẽ giữ
    // nguyên tập đơn và chỉ sắp lại thứ tự bằng 2-opt. Viết lại 2-opt ở đây là
    // nhân đôi thuật toán — hai bản sẽ lệch nhau sau vài lần sửa.
    const subset = nodes.map((n) => {
      const id = nodeToId.get(n)!;
      const order = orders.find((o) => o.id === id)!;
      return { id, lat: order.lat, lng: order.lng, demand: 0 };
    });

    const subMatrix = this.subMatrix(matrix, [0, ...nodes]);
    const solved = solveCvrp(
      subset,
      [{ id: vehicleId, name: vehicleId, capacity: Number.MAX_SAFE_INTEGER }],
      subMatrix,
    );

    const ordered = solved.routes[0]?.stopIds;
    if (!ordered?.length) return;

    const next = new Map(this._assignment());
    next.set(vehicleId, ordered);
    this._assignment.set(next);

    void this.refreshPathsInBackground();
  }

  /** Trích ma trận con theo danh sách chỉ số (giữ nguyên thứ tự truyền vào). */
  private subMatrix(matrix: CostMatrix, indices: readonly number[]): CostMatrix {
    return {
      real: matrix.real,
      distances: indices.map((i) => indices.map((j) => matrix.distances[i][j])),
      durations: indices.map((i) => indices.map((j) => matrix.durations[i][j])),
    };
  }

  /**
   * Vẽ lại đường mà KHÔNG chặn giao diện.
   *
   * Người dùng vừa chuyển một đơn thì bảng số liệu (km, giờ, tải) đã cập nhật
   * NGAY vì nó tính từ ma trận trong bộ nhớ. Chỉ có hình vẽ trên bản đồ là phải
   * chờ mạng — nên nó chạy nền, không dựng cờ `busy` để khoá nút.
   */
  private async refreshPathsInBackground(): Promise<void> {
    try {
      await this.refreshPaths();
    } catch {
      // Đường cũ vẫn còn trên bản đồ; số liệu đã đúng. Không có gì để báo.
    }
  }

  // ------------------------------------------------------------------ lệnh

  toggleOrder(orderId: string): void {
    this._selectedOrderIds.update((set) => {
      const next = new Set(set);
      next.has(orderId) ? next.delete(orderId) : next.add(orderId);
      return next;
    });
    this.invalidate();
  }

  toggleVehicle(vehicleId: string): void {
    this._vehicles.update((list) =>
      list.map((v) => (v.id === vehicleId ? { ...v, available: !v.available } : v)),
    );
    this.invalidate();
  }

  selectAllOrders(select: boolean): void {
    this._selectedOrderIds.set(select ? new Set(this._orders().map((o) => o.id)) : new Set());
    this.invalidate();
  }

  selectVehicle(id: string | null): void {
    this._selectedVehicleId.set(id);

    const route = this.routes().find((r) => r.vehicle.id === id);
    this._focus.set(route?.stops.length ? { ...route.stops[0].order } : null);
  }

  focusOrder(order: DeliveryOrder): void {
    this._highlightOrderId.set(order.id);
    this._focus.set({ lat: order.lat, lng: order.lng });
  }

  reset(): void {
    this._assignment.set(new Map());
    this._unassigned.set([]);
    this._paths.set(new Map());
    this._matrix.set(null);
    this._naiveDistance.set(0);
    this._phase.set('idle');
    this._selectedVehicleId.set(null);
  }

  /**
   * Đổi tập đơn/xe thì kế hoạch cũ không còn hợp lệ.
   *
   * Phải XOÁ chứ không giữ lại: một kế hoạch dựng trên ma trận của tập đơn cũ mà
   * hiển thị kèm tập đơn mới là dữ liệu sai — chỉ số trong ma trận lệch hàng và
   * mọi con số km/giờ sẽ thuộc về đơn khác.
   */
  private invalidate(): void {
    if (this.hasPlan()) this.reset();
  }

  // ------------------------------------------------------- dữ liệu cho bản đồ

  readonly markers = computed<MapMarker[]>(() => {
    const selectedVehicle = this._selectedVehicleId();
    const highlight = this._highlightOrderId();
    const routes = this.routes();

    const assigned = new Map<string, { color: string; seq: number; plate: string }>();
    for (const route of routes) {
      for (const stop of route.stops) {
        assigned.set(stop.order.id, {
          color: route.vehicle.color,
          seq: stop.seq,
          plate: route.vehicle.plate,
        });
      }
    }

    const markers: MapMarker[] = [
      {
        key: 'depot',
        lat: this.depot.lat,
        lng: this.depot.lng,
        label: '⌂',
        title: this.depot.name,
        description: `${this.depot.address}<br/>Xuất phát ${hourToLabel(this.depot.departHour)}`,
        color: '#0f172a',
      },
    ];

    for (const order of this.selectedOrders()) {
      const info = assigned.get(order.id);
      const route = routes.find((r) => r.vehicle.id === selectedVehicle);
      const stop = route?.stops.find((s) => s.order.id === order.id);

      markers.push({
        key: order.id,
        lat: order.lat,
        lng: order.lng,
        label: info ? String(info.seq) : '?',
        title: `${order.code} — ${order.customerName}`,
        description: [
          order.address,
          `${order.weightKg} kg · khung giờ ${hourToLabel(order.windowFrom)}–${hourToLabel(order.windowTo)}`,
          info ? `Xe ${info.plate}, điểm thứ ${info.seq}` : 'Chưa phân xe',
          stop ? `Dự kiến tới ${formatTimeLabel(new Date(stop.etaMs).toISOString())}` : '',
        ]
          .filter(Boolean)
          .join('<br/>'),
        // Chưa phân xe -> xám. Người điều vận cần thấy ngay đơn nào bị bỏ lại.
        color: info?.color ?? MAP_COLORS.pending,
        active: order.id === highlight,
        // Xe đang chọn -> làm mờ đơn của xe khác bằng cách thu nhỏ (dot).
        dot: !!selectedVehicle && info?.plate !== routes.find((r) => r.vehicle.id === selectedVehicle)?.vehicle.plate,
      });
    }

    return markers;
  });

  readonly paths = computed<MapPath[]>(() => {
    const selected = this._selectedVehicleId();

    return this.routes()
      .filter((r) => r.path.length > 1)
      .map((r) => ({
        key: `route-${r.vehicle.id}`,
        points: r.path,
        color: r.vehicle.color,
        weight: r.vehicle.id === selected ? 6 : 3,
        opacity: !selected || r.vehicle.id === selected ? 0.9 : 0.25,
      }));
  });

  readonly fitToken = computed(() => `${this.routes().length}-${this.selectedOrders().length}`);

  // ------------------------------------------------------------------ tiện ích

  /** Giờ trong ngày (7.25) -> mốc ms của hôm nay. */
  private hourToMs(hour: number): number {
    const d = new Date();
    d.setHours(Math.floor(hour), Math.round((hour - Math.floor(hour)) * 60), 0, 0);
    return d.getTime();
  }

  private msToHour(ms: number): number {
    const d = new Date(ms);
    return d.getHours() + d.getMinutes() / 60;
  }

  timeLabel(ms: number): string {
    return formatTimeLabel(new Date(ms).toISOString());
  }
}

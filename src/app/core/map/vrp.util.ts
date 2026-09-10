import { LatLng } from './map.types';

/**
 * ========== BÀI TOÁN PHÂN XE & CHIA TUYẾN (CVRP) ==========
 *
 * Đây là bài toán trung tâm của mọi phần mềm điều vận (TMS):
 *
 *   "Có 1 kho, N đơn hàng ở N địa chỉ khác nhau, mỗi đơn nặng bao nhiêu đó;
 *    có M xe, mỗi xe chở được tối đa bao nhiêu đó. Chia đơn cho xe và sắp thứ tự
 *    ghé thăm sao cho TỔNG QUÃNG ĐƯỜNG cả đội là nhỏ nhất."
 *
 * Tên khoa học: Capacitated Vehicle Routing Problem (CVRP). Nó là bài toán
 * NP-hard — với 30 đơn, số cách chia đã lớn hơn số nguyên tử trong dải ngân hà,
 * không có chuyện "tính ra đáp án đúng tuyệt đối". Mọi phần mềm thương mại đều
 * dùng heuristic; khác nhau ở chỗ heuristic tốt tới đâu.
 *
 * ─────────────────────── THUẬT TOÁN DÙNG Ở ĐÂY ───────────────────────
 *
 * **Bước 1 — Clarke-Wright Savings (1964).** Vẫn là xương sống của ngành sau 60
 * năm vì tỉ lệ "chất lượng / độ phức tạp" cực tốt.
 *
 *   Xuất phát: mỗi đơn một chuyến riêng, kho → đơn i → kho. Rất tốn nhưng hợp lệ.
 *   Với mỗi cặp đơn (i, j), tính khoản TIẾT KIỆM được nếu gộp chung một chuyến:
 *
 *        s(i,j) = d(kho,i) + d(j,kho) − d(i,j)
 *
 *   Ý nghĩa: gộp lại thì bỏ được đoạn quay về kho từ i và đoạn đi từ kho tới j,
 *   nhưng phải trả thêm đoạn i→j. Xếp mọi cặp theo `s` giảm dần rồi lần lượt
 *   gộp, miễn là không vi phạm tải trọng và hai đơn đang nằm ở hai đầu mút của
 *   hai chuyến khác nhau.
 *
 * **Bước 2 — 2-opt trong từng chuyến.** Savings quyết định "đơn nào đi cùng xe"
 * rất tốt nhưng thứ tự bên trong thường còn đoạn bắt chéo. 2-opt gỡ chúng ra.
 *
 * **Bước 3 — Gán chuyến cho xe.** Chuyến nặng nhất vào xe tải trọng lớn nhất.
 * Thiếu xe thì các đơn thừa vào danh sách `unassigned` — KHÔNG được im lặng nhét
 * quá tải, đó là dữ liệu giả gây vỡ kế hoạch ngoài đường.
 *
 * ─────────────────────── ĐIỀU KIỆN ĐẦU VÀO QUAN TRỌNG ───────────────────────
 *
 * Toàn bộ thuật toán chạy trên MA TRẬN CHI PHÍ truyền từ ngoài vào, KHÔNG tự
 * tính khoảng cách. Chủ ý:
 *
 *  - Truyền ma trận đường thật (`OsrmMatrixService`) -> kết quả dùng được ngoài đời.
 *  - Truyền ma trận chim bay -> vẫn chạy, nhưng sai ở chỗ có sông/đường một chiều.
 *
 * Quy ước chỉ số: **0 = kho**, `i + 1` = `stops[i]`. Sai quy ước này là toàn bộ
 * lời giải vô nghĩa mà không có lỗi nào được ném ra — nên `solveCvrp` kiểm tra
 * kích thước ma trận ngay từ đầu.
 */

/**
 * ⚠️ PHẠM VI RÀNG BUỘC CỦA SOLVER NÀY — ĐỌC TRƯỚC KHI DÙNG
 *
 * `solveCvrp` enforce đúng HAI ràng buộc:
 *  1. tải trọng (`demand` vs `capacity`),
 *  2. số điểm mỗi chuyến (`maxStops`).
 *
 * KHUNG GIỜ NHẬN HÀNG (time window) KHÔNG PHẢI RÀNG BUỘC Ở ĐÂY. `VrpStop` cố ý
 * không có `windowFrom/windowTo`: bước gộp Clarke-Wright và bước 2-opt chỉ so
 * quãng đường, không hề mô phỏng dòng thời gian.
 *
 * Tầng nghiệp vụ (`PlanningStore`) tính giờ dự kiến tới từng điểm SAU KHI đã có
 * tuyến, rồi đánh dấu `windowViolation`. Nghĩa là khung giờ hiện là **hậu kiểm /
 * cảnh báo**, không phải điều kiện lọc phương án.
 *
 * Đây là giới hạn thật, không phải thiếu sót giấu đi: VRPTW (VRP with Time
 * Windows) cần mô hình khác hẳn — kiểm tra tính khả thi theo travel time + service
 * time ở mọi lần gộp/đảo, cộng khái niệm chờ sớm (waiting time). Ai muốn làm thì
 * đó là việc phải làm, và phải sửa cả tài liệu lẫn test theo.
 */
export interface VrpStop extends LatLng {
  id: string;
  /** Khối lượng/thể tích đơn hàng — cùng đơn vị với `VrpVehicle.capacity`. */
  demand: number;
  /** Thời gian đứng giao tại điểm này (phút). */
  serviceMinutes?: number;
}

export interface VrpVehicle {
  id: string;
  name: string;
  capacity: number;
  /** Trần số điểm mỗi chuyến (giờ làm việc của tài xế), 0 = không giới hạn. */
  maxStops?: number;
}

export interface VrpRoute {
  vehicleId: string;
  vehicleName: string;
  /** Thứ tự ghé thăm, KHÔNG bao gồm kho ở hai đầu. */
  stopIds: string[];
  distanceMeters: number;
  durationSeconds: number;
  load: number;
  capacity: number;
  /** Tỉ lệ lấp đầy xe (0..1) — chỉ số điều vận quan tâm nhất sau quãng đường. */
  utilization: number;
}

export interface VrpSolution {
  routes: VrpRoute[];
  /** Đơn không xếp được xe nào (hết xe, hoặc một đơn nặng hơn mọi xe). */
  unassigned: string[];
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  /** Tổng quãng đường nếu mỗi đơn đi một chuyến riêng — mốc để khoe phần tiết kiệm. */
  naiveDistanceMeters: number;
  /** Số lần 2-opt cải thiện được — dùng để biết bước 2 có tác dụng thật không. */
  improvements: number;
}

export interface CostLike {
  distances: number[][];
  durations: number[][];
}

interface Saving {
  i: number;
  j: number;
  value: number;
}

/**
 * Giải bài toán chia tuyến.
 *
 * @param matrix ma trận (n+1)×(n+1) với chỉ số 0 là kho.
 */
export function solveCvrp(
  stops: readonly VrpStop[],
  vehicles: readonly VrpVehicle[],
  matrix: CostLike,
  serviceSecondsPerStop = 600,
): VrpSolution {
  const n = stops.length;

  const empty: VrpSolution = {
    routes: [],
    unassigned: stops.map((s) => s.id),
    totalDistanceMeters: 0,
    totalDurationSeconds: 0,
    naiveDistanceMeters: 0,
    improvements: 0,
  };

  if (!n || !vehicles.length) return empty;

  // Ma trận sai kích thước = sai quy ước chỉ số. Thà trả về "không xếp được"
  // còn hơn cho ra một lời giải trông hợp lý nhưng dựa trên số liệu lệch hàng.
  if (matrix.distances.length < n + 1 || matrix.distances[0].length < n + 1) return empty;

  const naive = stops.reduce(
    (sum, _, i) => sum + matrix.distances[0][i + 1] + matrix.distances[i + 1][0],
    0,
  );

  // --------------------------------------------------- bước 1: Clarke-Wright

  // Mỗi đơn một chuyến riêng. `routes[k]` là mảng chỉ số điểm (1..n).
  let routes: number[][] = stops.map((_, i) => [i + 1]);
  const routeOf = new Map<number, number>(); // chỉ số điểm -> chỉ số chuyến
  routes.forEach((r, k) => routeOf.set(r[0], k));

  const loadOf = new Map<number, number>();
  routes.forEach((r, k) => loadOf.set(k, stops[r[0] - 1].demand));

  const maxCapacity = Math.max(...vehicles.map((v) => v.capacity));
  const maxStops = Math.max(...vehicles.map((v) => v.maxStops || Number.POSITIVE_INFINITY));

  const savings: Saving[] = [];
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= n; j++) {
      if (i === j) continue;
      savings.push({
        i,
        j,
        value: matrix.distances[0][i] + matrix.distances[j][0] - matrix.distances[i][j],
      });
    }
  }
  savings.sort((a, b) => b.value - a.value);

  for (const s of savings) {
    if (s.value <= 0) break; // Hết cặp nào gộp có lợi.

    const ri = routeOf.get(s.i);
    const rj = routeOf.get(s.j);
    if (ri == null || rj == null || ri === rj) continue;

    const routeI = routes[ri];
    const routeJ = routes[rj];
    if (!routeI.length || !routeJ.length) continue;

    // Chỉ gộp được khi i là ĐUÔI chuyến này và j là ĐẦU chuyến kia — nối kiểu
    // khác sẽ phải đảo ngược một chuyến, làm hỏng thứ tự đã tối ưu cục bộ.
    if (routeI[routeI.length - 1] !== s.i || routeJ[0] !== s.j) continue;

    const merged = (loadOf.get(ri) ?? 0) + (loadOf.get(rj) ?? 0);
    if (merged > maxCapacity) continue;
    if (routeI.length + routeJ.length > maxStops) continue;

    const combined = [...routeI, ...routeJ];
    routes[ri] = combined;
    routes[rj] = [];
    loadOf.set(ri, merged);
    loadOf.set(rj, 0);
    combined.forEach((node) => routeOf.set(node, ri));
  }

  routes = routes.filter((r) => r.length);

  // ------------------------------------------------ bước 2: 2-opt từng chuyến

  let improvements = 0;
  routes = routes.map((route) => {
    const { order, improved } = twoOptRoute(route, matrix.distances);
    improvements += improved;
    return order;
  });

  // ------------------------------------------------- bước 3: gán chuyến cho xe

  const loads = routes.map((r) => r.reduce((sum, node) => sum + stops[node - 1].demand, 0));

  // Chuyến nặng nhất trước, xe to nhất trước. Làm ngược lại thì một chuyến nặng
  // rơi vào xe nhỏ và bị loại, dù xe to đang rảnh.
  const order = routes.map((_, k) => k).sort((a, b) => loads[b] - loads[a]);
  const fleet = [...vehicles].sort((a, b) => b.capacity - a.capacity);

  const result: VrpRoute[] = [];
  const unassigned: string[] = [];

  let vehicleIndex = 0;
  for (const k of order) {
    const route = routes[k];
    const load = loads[k];

    const vehicle = fleet[vehicleIndex];
    const fits =
      vehicle &&
      load <= vehicle.capacity &&
      (!vehicle.maxStops || route.length <= vehicle.maxStops);

    if (!fits) {
      unassigned.push(...route.map((node) => stops[node - 1].id));
      continue;
    }

    vehicleIndex++;
    const cost = routeCost(route, matrix, serviceSecondsPerStop);

    result.push({
      vehicleId: vehicle.id,
      vehicleName: vehicle.name,
      stopIds: route.map((node) => stops[node - 1].id),
      distanceMeters: cost.distance,
      durationSeconds: cost.duration,
      load,
      capacity: vehicle.capacity,
      utilization: vehicle.capacity ? load / vehicle.capacity : 0,
    });
  }

  return {
    routes: result,
    unassigned,
    totalDistanceMeters: result.reduce((sum, r) => sum + r.distanceMeters, 0),
    totalDurationSeconds: result.reduce((sum, r) => sum + r.durationSeconds, 0),
    naiveDistanceMeters: naive,
    improvements,
  };
}

/** Quãng đường + thời gian của một chuyến khép vòng kho -> các điểm -> kho. */
export function routeCost(
  route: readonly number[],
  matrix: CostLike,
  serviceSecondsPerStop = 0,
): { distance: number; duration: number } {
  if (!route.length) return { distance: 0, duration: 0 };

  let distance = matrix.distances[0][route[0]];
  let duration = matrix.durations[0][route[0]];

  for (let i = 1; i < route.length; i++) {
    distance += matrix.distances[route[i - 1]][route[i]];
    duration += matrix.durations[route[i - 1]][route[i]];
  }

  distance += matrix.distances[route[route.length - 1]][0];
  duration += matrix.durations[route[route.length - 1]][0];
  duration += route.length * serviceSecondsPerStop;

  return { distance, duration };
}

/**
 * 2-opt trên MỘT chuyến, dùng ma trận thật.
 *
 * Khác `route-optimizer.util.ts` (chạy trên Haversine, dùng cho màn Chỉ đường):
 * ở đây điểm đầu và điểm cuối KHÔNG cố định — chuyến nào cũng bắt đầu và kết
 * thúc ở kho, nên mọi vị trí trong chuỗi đều được phép hoán vị.
 */
function twoOptRoute(
  route: readonly number[],
  distances: number[][],
): { order: number[]; improved: number } {
  if (route.length < 3) return { order: [...route], improved: 0 };

  let best = [...route];
  let bestCost = closedCost(best, distances);
  let improved = 0;
  let changed = true;
  let guard = 0;

  while (changed && guard++ < 40) {
    changed = false;

    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const candidate = [
          ...best.slice(0, i),
          ...best.slice(i, k + 1).reverse(),
          ...best.slice(k + 1),
        ];
        const cost = closedCost(candidate, distances);

        // Ngưỡng 1 m để không lặp vô hạn vì sai số dấu phẩy động.
        if (cost < bestCost - 1) {
          best = candidate;
          bestCost = cost;
          changed = true;
          improved++;
        }
      }
    }
  }

  return { order: best, improved };
}

function closedCost(route: readonly number[], distances: number[][]): number {
  if (!route.length) return 0;

  let total = distances[0][route[0]];
  for (let i = 1; i < route.length; i++) total += distances[route[i - 1]][route[i]];
  return total + distances[route[route.length - 1]][0];
}

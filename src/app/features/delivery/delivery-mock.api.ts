import { Injectable, inject } from '@angular/core';
import {
  LatLng,
  MapProviderService,
  RoutePoint,
  RouteResult,
  RoutingFacade,
  cumulativeAlong,
  distanceMeters,
  interpolate,
  pointAtAlong,
  resampleAlongPath,
  slicePathByDistance,
  totalDistanceMeters,
} from '../../core/map';
import { DeliveryStop, DeliveryTrip, Depot, StopStatus } from './delivery.models';
import { SimStopPlan, applyGpsNoise, simulateTrack } from './track-sim.util';

interface StopSeed {
  orderCode: string;
  customerName: string;
  address: string;
  lat: number;
  lng: number;
  /**
   * Số phút tài xế thực sự nán lại ở điểm này: đỗ xe, bốc hàng, chờ khách kiểm,
   * ký nhận, thu tiền.
   *
   * VÌ SAO KHÔNG PHẢI `delayMinutes` NHƯ TRƯỚC: "chậm bao nhiêu phút" là KẾT QUẢ,
   * không phải nguyên nhân. Gõ tay số phút chậm rồi mong nó khớp với quãng đường
   * là cách chắc chắn sinh ra dữ liệu bất khả thi — bộ seed cũ cho ra đoạn xe phải
   * chạy 4,3 km trong 2 phút (129 km/h giữa nội thành Hà Nội) chỉ vì hai điểm liền
   * nhau được gõ lệch 41 và 18 phút. Ở đây chỉ khai NGUYÊN NHÂN (đứng bao lâu),
   * còn giờ tới và số phút chậm được SUY RA từ thời gian lăn bánh thật.
   */
  dwellMinutes: number;
  status: StopStatus;
  amount: number;
  note?: string;
}

interface TripSeed {
  id: string;
  code: string;
  driverName: string;
  driverPhone: string;
  vehiclePlate: string;
  /** Giờ xuất kho, dạng `HH:mm`. */
  departAt: string;
  depot: Depot;
  stops: StopSeed[];
  /**
   * Đoạn "đi lệch tuyến": sau khi giao xong điểm thứ `afterStopIndex` (đếm từ 1),
   * tài xế rẽ khỏi lộ trình để ghé một chỗ ngoài kế hoạch rồi mới quay lại tuyến.
   *
   * `offset` là độ lệch toạ độ của chỗ ghé đó so với vị trí xe lúc rẽ. Chỗ ghé
   * này được **ĐỊNH TUYẾN THẬT** chứ không nối thẳng — xem `buildDetour`.
   *
   * `null` = chuyến chạy đúng tuyến.
   */
  detour: { afterStopIndex: number; offset: LatLng; reason: string } | null;
}

/**
 * Thời gian giao hàng theo KẾ HOẠCH tại mỗi điểm (giây).
 * Đứng lâu hơn mức này thì phần dôi ra chính là số phút chậm mà màn hình báo.
 */
const PLANNED_SERVICE_SECONDS = 15 * 60;

/** Tốc độ lăn bánh giả định khi dịch vụ định tuyến không trả về thời gian (km/h). */
const FALLBACK_CRUISE_KMH = 22;

/** Xe đang ở đâu trong chặng dẫn tới điểm giao kế tiếp (0 = vừa rời điểm trước). */
const PROGRESS_INTO_NEXT_LEG = 0.45;

/** Biên độ sai số GPS mô phỏng (mét) — cỡ sai số thật của điện thoại trong phố. */
const GPS_NOISE_METERS = 7;

/** Khoảng cách tối đa giữa hai mẫu GPS liên tiếp (mét). */
const GPS_SPACING_METERS = 40;

/** Xe đỗ giao hàng thì thiết bị vẫn bắn log — mỗi 90 giây một bản ghi. */
const PARKED_SAMPLE_SECONDS = 90;

const TRIP_SEEDS: TripSeed[] = [
  {
    id: 'TRIP-HN-01',
    code: 'GH-HN-20260909-01',
    driverName: 'Nguyễn Văn Toàn',
    driverPhone: '0912 345 678',
    vehiclePlate: '29C-123.45',
    departAt: '07:15',
    depot: {
      name: 'Kho Long Biên',
      address: 'Số 5 Ngọc Lâm, Long Biên, Hà Nội',
      lat: 21.0447,
      lng: 105.8752,
    },
    detour: {
      afterStopIndex: 3,
      offset: { lat: 0.012, lng: -0.014 },
      reason: 'Tạt ngang lấy hàng đổi trả ở kho phụ, không có trong kế hoạch',
    },
    stops: [
      {
        orderCode: 'DH-24081',
        customerName: 'Tạp hoá Hàng Bài',
        address: '48 Hàng Bài, Hoàn Kiếm',
        lat: 21.0227,
        lng: 105.8524,
        dwellMinutes: 11,
        status: 'delivered',
        amount: 4_850_000,
      },
      {
        orderCode: 'DH-24082',
        customerName: 'Siêu thị mini Bà Triệu',
        address: '191 Bà Triệu, Hai Bà Trưng',
        lat: 21.0126,
        lng: 105.8489,
        dwellMinutes: 19,
        status: 'delivered',
        amount: 12_300_000,
      },
      {
        orderCode: 'DH-24083',
        customerName: 'Cửa hàng Kim Liên',
        address: '12 Phạm Ngọc Thạch, Đống Đa',
        lat: 21.006,
        lng: 105.836,
        dwellMinutes: 37,
        status: 'delivered',
        amount: 7_620_000,
        note: 'Khách kiểm từng thùng trước khi ký nhận',
      },
      {
        orderCode: 'DH-24084',
        customerName: 'Đại lý Thanh Xuân',
        address: '235 Nguyễn Trãi, Thanh Xuân',
        lat: 20.9955,
        lng: 105.814,
        dwellMinutes: 24,
        status: 'failed',
        amount: 9_100_000,
        note: 'Khách đóng cửa, chờ 24 phút không liên lạc được, hẹn giao lại chiều',
      },
      {
        orderCode: 'DH-24085',
        customerName: 'Cửa hàng Trung Hoà',
        address: '18 Trung Hoà, Cầu Giấy',
        lat: 21.0079,
        lng: 105.7997,
        dwellMinutes: 16,
        status: 'delivered',
        amount: 5_430_000,
      },
      {
        orderCode: 'DH-24086',
        customerName: 'Tạp hoá Mỹ Đình',
        address: '2 Lê Đức Thọ, Nam Từ Liêm',
        lat: 21.0293,
        lng: 105.7796,
        dwellMinutes: 15,
        status: 'pending',
        amount: 6_780_000,
      },
      {
        orderCode: 'DH-24087',
        customerName: 'Đại lý Cầu Giấy',
        address: '99 Trần Duy Hưng, Cầu Giấy',
        lat: 21.0333,
        lng: 105.797,
        dwellMinutes: 15,
        status: 'pending',
        amount: 15_200_000,
      },
    ],
  },
  {
    id: 'TRIP-HCM-01',
    code: 'GH-HCM-20260909-04',
    driverName: 'Trần Minh Khoa',
    driverPhone: '0938 111 222',
    vehiclePlate: '51D-678.90',
    departAt: '06:40',
    depot: {
      name: 'Kho Bình Tân',
      address: 'KCN Tân Tạo, Bình Tân, TP.HCM',
      lat: 10.748,
      lng: 106.61,
    },
    detour: null,
    stops: [
      {
        orderCode: 'DH-31201',
        customerName: 'Bách hoá Bến Thành',
        address: '26 Lê Lợi, Quận 1',
        lat: 10.7758,
        lng: 106.7009,
        dwellMinutes: 17,
        status: 'delivered',
        amount: 21_400_000,
      },
      {
        orderCode: 'DH-31202',
        customerName: 'Cửa hàng Phú Nhuận',
        address: '155 Phan Xích Long, Phú Nhuận',
        lat: 10.787,
        lng: 106.69,
        dwellMinutes: 12,
        status: 'delivered',
        amount: 8_900_000,
      },
      {
        orderCode: 'DH-31203',
        customerName: 'Đại lý Tân Bình',
        address: '77 Cộng Hoà, Tân Bình',
        lat: 10.8005,
        lng: 106.658,
        dwellMinutes: 26,
        status: 'delivered',
        amount: 13_050_000,
      },
      {
        orderCode: 'DH-31204',
        customerName: 'Tạp hoá Quận 3',
        address: '40 Võ Văn Tần, Quận 3',
        lat: 10.7629,
        lng: 106.6822,
        dwellMinutes: 18,
        status: 'delivered',
        amount: 4_120_000,
      },
      {
        orderCode: 'DH-31205',
        customerName: 'Siêu thị Quận 4',
        address: '12 Hoàng Diệu, Quận 4',
        lat: 10.7411,
        lng: 106.7002,
        dwellMinutes: 15,
        status: 'pending',
        amount: 6_600_000,
      },
    ],
  },
  {
    id: 'TRIP-DN-01',
    code: 'GH-DN-20260909-02',
    driverName: 'Lê Thị Hồng',
    driverPhone: '0905 777 888',
    vehiclePlate: '43C-334.55',
    departAt: '07:00',
    depot: {
      name: 'Kho Hoà Khánh',
      address: 'KCN Hoà Khánh, Liên Chiểu, Đà Nẵng',
      lat: 16.08,
      lng: 108.15,
    },
    detour: {
      afterStopIndex: 1,
      offset: { lat: -0.009, lng: 0.011 },
      reason: 'Đi vòng tránh chốt cấm tải giờ cao điểm',
    },
    stops: [
      {
        orderCode: 'DH-77011',
        customerName: 'Cửa hàng Thanh Khê',
        address: '210 Điện Biên Phủ, Thanh Khê',
        lat: 16.0678,
        lng: 108.2208,
        dwellMinutes: 14,
        status: 'delivered',
        amount: 5_300_000,
      },
      {
        orderCode: 'DH-77012',
        customerName: 'Tạp hoá Hải Châu',
        address: '35 Nguyễn Văn Linh, Hải Châu',
        lat: 16.0544,
        lng: 108.2022,
        dwellMinutes: 21,
        status: 'delivered',
        amount: 7_800_000,
      },
      {
        orderCode: 'DH-77013',
        customerName: 'Đại lý Sơn Trà',
        address: '88 Ngô Quyền, Sơn Trà',
        lat: 16.0471,
        lng: 108.2199,
        dwellMinutes: 33,
        status: 'delivered',
        amount: 11_250_000,
        note: 'Chờ kho khách dọn chỗ mới hạ được hàng',
      },
      {
        orderCode: 'DH-77014',
        customerName: 'Siêu thị Ngũ Hành Sơn',
        address: '5 Lê Văn Hiến, Ngũ Hành Sơn',
        lat: 16.0339,
        lng: 108.2436,
        dwellMinutes: 15,
        status: 'pending',
        amount: 9_400_000,
      },
    ],
  },
];

/** Chặng giữa hai waypoint, đã chuẩn hoá về mét + giây. */
interface NormalizedLeg {
  meters: number;
  seconds: number;
}

/**
 * ================== GIẢ LẬP API GIÁM SÁT GIAO HÀNG ==================
 *
 * Ở hệ thống thật, màn hình sẽ gọi:
 *  - `GET /delivery/trips?date=...`            -> danh sách chuyến
 *  - `GET /delivery/trips/{id}`                -> chi tiết + danh sách điểm giao
 *  - `GET /staffPositionLog/percent?...`       -> GPS log của tài xế
 *
 * Ở demo này, dữ liệu được dựng từ **chính lộ trình định tuyến thật**:
 *
 *  1. Định tuyến qua `[kho, ...các điểm giao, kho]` -> lộ trình dự kiến + `legs`
 *     (quãng đường & thời gian lăn bánh THẬT của từng chặng).
 *  2. Xác định xe đang ở đâu: giữa điểm đã giao cuối cùng và điểm chưa giao kế tiếp.
 *  3. Nếu chuyến có đoạn đi lệch tuyến thì **định tuyến tiếp** một vòng ghé thật
 *     rồi ghép vào — đường đi lệch cũng là đường phố có thật.
 *  4. Làm dày hình học (chỉ thêm đỉnh, không bớt), cộng nhiễu GPS lệch ngang.
 *  5. Rải mốc thời gian theo biểu đồ tốc độ + thời gian đứng giao hàng.
 *  6. Suy ngược ra giờ tới thực tế của từng điểm.
 *
 * Nhờ vậy ba trục dữ liệu — hình học, thời gian, trạng thái đơn hàng — nhất quán
 * với nhau, và mọi kết luận màn hình rút ra (km, tốc độ, lệch tuyến, ETA, chậm
 * giờ) đều có cơ sở.
 */
@Injectable({ providedIn: 'root' })
export class DeliveryMockApi {
  private readonly routing = inject(RoutingFacade);
  private readonly mapProvider = inject(MapProviderService);

  /**
   * Cache theo `tripId + provider`.
   *
   * PHẢI CÓ PROVIDER TRONG KHOÁ: lộ trình dự kiến (đường nét đứt) được tính lại
   * mỗi khi đổi nhà cung cấp bản đồ, còn GPS track thì lấy từ cache. Khoá chỉ
   * theo `tripId` nghĩa là sau khi đổi Google <-> OSM, đường nét đứt là hình học
   * của nguồn mới còn đường xe chạy vẫn là hình học của nguồn cũ — hai đường lệch
   * nhau cả trăm mét mà không có gì trên màn hình giải thích tại sao.
   */
  private readonly cache = new Map<string, DeliveryTrip>();

  /**
   * Lộ trình dự kiến đã định tuyến, tái sử dụng chính kết quả dùng để sinh GPS.
   *
   * VÌ SAO TỒN TẠI: màn Điều hành đội xe cần lộ trình dự kiến của CẢ BA chuyến để
   * đo lệch tuyến. Nếu mỗi màn tự gọi định tuyến lại thì mở bảng điều hành là bắn
   * thêm 3 request vào server demo công cộng, trong khi `buildTrip` vừa tính
   * xong đúng đường đó vài mili-giây trước.
   */
  private readonly plannedCache = new Map<string, LatLng[]>();

  listTrips(): { id: string; code: string; driverName: string; vehiclePlate: string }[] {
    return TRIP_SEEDS.map((t) => ({
      id: t.id,
      code: t.code,
      driverName: t.driverName,
      vehiclePlate: t.vehiclePlate,
    }));
  }

  /** Lộ trình dự kiến (đã bám phố) của một chuyến. Tự tải chuyến nếu chưa có. */
  async getPlannedPath(id: string): Promise<LatLng[]> {
    const key = this.cacheKey(id);
    if (!this.plannedCache.has(key)) await this.getTrip(id);
    return this.plannedCache.get(key) ?? [];
  }

  /** Tải toàn bộ chuyến trong ngày — dùng cho bảng điều hành đội xe. */
  async getAllTrips(): Promise<DeliveryTrip[]> {
    const trips: DeliveryTrip[] = [];
    // TUẦN TỰ, không `Promise.all`: mỗi chuyến là một request định tuyến, bắn
    // đồng thời vào server OSRM công cộng rất dễ ăn rate-limit.
    for (const seed of TRIP_SEEDS) trips.push(await this.getTrip(seed.id));
    return trips;
  }

  /** Lộ trình DỰ KIẾN: kho -> các điểm theo thứ tự -> quay về kho (khép vòng). */
  buildPlannedWaypoints(trip: Pick<DeliveryTrip, 'depot' | 'stops'>): LatLng[] {
    const stops = [...trip.stops].sort((a, b) => a.seq - b.seq);
    return [
      { lat: trip.depot.lat, lng: trip.depot.lng },
      ...stops.map((s) => ({ lat: s.lat, lng: s.lng })),
      { lat: trip.depot.lat, lng: trip.depot.lng },
    ];
  }

  async getTrip(id: string): Promise<DeliveryTrip> {
    const key = this.cacheKey(id);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const seed = TRIP_SEEDS.find((t) => t.id === id) ?? TRIP_SEEDS[0];
    const trip = await this.buildTrip(seed, key);

    this.cache.set(key, trip);
    return trip;
  }

  private cacheKey(id: string): string {
    return `${id}::${this.mapProvider.provider()}`;
  }

  // ------------------------------------------------------------- dựng dữ liệu

  private async buildTrip(seed: TripSeed, cacheKey: string): Promise<DeliveryTrip> {
    const waypoints: LatLng[] = [
      { lat: seed.depot.lat, lng: seed.depot.lng },
      ...seed.stops.map((s) => ({ lat: s.lat, lng: s.lng })),
      { lat: seed.depot.lat, lng: seed.depot.lng },
    ];

    let route: RouteResult | null = null;
    try {
      route = await this.routing.computeRoute({ points: waypoints, travelMode: 'driving' });
    } catch {
      route = null;
    }

    const spine = route && route.path.length > 1 ? route.path : this.straightLine(waypoints);
    this.plannedCache.set(cacheKey, spine);

    const legs = this.normalizeLegs(route, waypoints, spine);
    const cum = cumulativeAlong(spine);
    const total = cum[cum.length - 1];

    // Mốc quãng đường của từng điểm giao trên `spine`.
    //
    // Quy về TỈ LỆ rồi nhân với chiều dài hình học, không dùng thẳng số mét của
    // provider: `legs[].distanceMeters` là quãng đường theo dữ liệu đường bộ, còn
    // polyline trả về đã được đơn giản hoá nên ngắn hơn vài phần nghìn. Lấy thẳng
    // số mét thì mốc điểm cuối vượt quá chiều dài polyline và bị kẹp về cuối tuyến.
    const legMetersTotal = legs.reduce((s, l) => s + l.meters, 0) || 1;
    const stopAlong: number[] = [];
    let acc = 0;
    for (let i = 0; i < seed.stops.length; i++) {
      acc += legs[i]?.meters ?? 0;
      stopAlong.push((acc / legMetersTotal) * total);
    }

    // Số điểm đã xử lý xong (giao được hoặc giao hỏng), tính từ đầu danh sách.
    let handled = 0;
    while (handled < seed.stops.length && seed.stops[handled].status !== 'pending') handled++;

    // VỊ TRÍ XE PHẢI NHẤT QUÁN VỚI TRẠNG THÁI ĐƠN.
    //
    // Bản cũ cắt track ở "72% số ĐỈNH" — một con số không mang ý nghĩa nghiệp vụ
    // nào. Đo trên tuyến Hà Nội: 72% số đỉnh = 75,7% quãng đường, trong khi điểm
    // giao số 6 nằm ở 61,6% và số 7 ở 68,7%. Nghĩa là xe đã chạy vượt qua hai
    // khách hàng đang mang trạng thái "Chưa tới", vượt tới 3–5 km.
    const from = handled > 0 ? stopAlong[handled - 1] : 0;
    const to = handled < stopAlong.length ? stopAlong[handled] : total;
    const progress = from + (to - from) * PROGRESS_INTO_NEXT_LEG;

    const detour = await this.buildDetour(seed, spine, cum, stopAlong, total);

    const travelled = this.assembleTravelled(spine, cum, progress, detour);
    const extraMeters = detour ? detour.meters - (detour.toAlong - detour.fromAlong) : 0;
    const extraSeconds = detour ? detour.extraSeconds : 0;
    const detourAfter = detour ? detour.afterStopIndex : Number.POSITIVE_INFINITY;

    // Mốc điểm giao quy về đường ĐÃ ĐI (đã cộng phần đi vòng chèn thêm).
    const travelledStopAlong = stopAlong
      .slice(0, handled)
      .map((m, i) => (i >= detourAfter ? m + extraMeters : m));

    const dense = resampleAlongPath(travelled, GPS_SPACING_METERS);
    const noisy = applyGpsNoise(dense, GPS_NOISE_METERS, seed.id.length);

    // Nhiễu lệch ngang làm chiều dài đổi chút ít -> quy mốc về tỉ lệ cho khớp.
    const travelledTotal = totalDistanceMeters(travelled) || 1;
    const noisyTotal = totalDistanceMeters(noisy);

    const simStops: SimStopPlan[] = travelledStopAlong.map((m, i) => ({
      alongMeters: (m / travelledTotal) * noisyTotal,
      dwellSeconds: seed.stops[i].dwellMinutes * 60,
      driveSeconds: (legs[i]?.seconds ?? 60) + (i === detourAfter ? extraSeconds : 0),
    }));

    const departure = this.atTime(seed.departAt);
    const tailSeconds = (legs[handled]?.seconds ?? 60) * PROGRESS_INTO_NEXT_LEG;

    const samples = simulateTrack({
      path: noisy,
      stops: simStops,
      departureMs: departure.getTime(),
      tailDriveSeconds: tailSeconds,
      parkedSampleSeconds: PARKED_SAMPLE_SECONDS,
    });

    const stops = this.buildStops(seed, legs, simStops, departure);
    const track = this.toRoutePoints(samples, seed, departure);

    return {
      id: seed.id,
      code: seed.code,
      date: this.today(),
      driverName: seed.driverName,
      driverPhone: seed.driverPhone,
      vehiclePlate: seed.vehiclePlate,
      depot: seed.depot,
      stops,
      track,
    };
  }

  /**
   * Chuẩn hoá `legs` của kết quả định tuyến.
   *
   * Provider nào cũng trả `legs`, nhưng không phải lúc nào cũng đủ hoặc có thời
   * gian. Thiếu tới đâu thì suy ra tới đó từ hình học + tốc độ giả định, để phần
   * còn lại của hàm không bao giờ phải xử lý `undefined`.
   */
  private normalizeLegs(
    route: RouteResult | null,
    waypoints: readonly LatLng[],
    spine: readonly LatLng[],
  ): NormalizedLeg[] {
    const expected = waypoints.length - 1;
    const legs = route?.legs ?? [];

    if (legs.length === expected) {
      return legs.map((l) => ({
        meters: l.distanceMeters,
        seconds:
          l.durationSeconds > 0
            ? l.durationSeconds
            : (l.distanceMeters / 1000 / FALLBACK_CRUISE_KMH) * 3600,
      }));
    }

    // Không có `legs` (hoặc sai số lượng): chia hình học theo đường chim bay giữa
    // các waypoint. Kém chính xác hơn nhưng vẫn giữ đúng THỨ TỰ và tỉ lệ tương đối.
    const totalGeom = totalDistanceMeters(spine);
    const crow = waypoints.slice(1).map((w, i) => distanceMeters(waypoints[i], w));
    const crowSum = crow.reduce((s, d) => s + d, 0) || 1;

    return crow.map((d) => {
      const meters = (d / crowSum) * totalGeom;
      return { meters, seconds: (meters / 1000 / FALLBACK_CRUISE_KMH) * 3600 };
    });
  }

  /**
   * Dựng đoạn ĐI LỆCH TUYẾN bằng cách **định tuyến thật** một vòng ghé ngoài
   * kế hoạch: `chỗ rẽ -> chỗ ghé -> chỗ nhập lại tuyến`.
   *
   * ====== VÌ SAO KHÔNG NỐI THẲNG NHƯ TRƯỚC ======
   *
   * Bản cũ nội suy tuyến tính từ điểm neo ra một toạ độ lệch rồi vòng về. Trên
   * chuyến Hà Nội, đó là hai đoạn thẳng dài ~2 km cắt thẳng qua khu dân cư quanh
   * Đại học Thuỷ Lợi rồi đâm ra hồ Đống Đa. Không xe nào đi được đường đó, và
   * người xem không thể phân biệt "tài xế đi lệch" với "phần mềm vẽ sai".
   *
   * Cùng điểm neo và cùng độ lệch ấy, khi ĐỊNH TUYẾN THẬT thì ra 5.882 m đường
   * phố có thật (so với 2.200 m nếu đi đúng tuyến), đỉnh lệch 1.099 m — vượt xa
   * ngưỡng cảnh báo 120 m, nên cảnh báo lệch tuyến vẫn kêu đúng như trước, chỉ
   * khác là bây giờ nó kêu vì một hành vi lái xe có thật.
   *
   * Định tuyến hỏng -> trả `null`, chuyến chạy đúng tuyến. KHÔNG bịa đường thẳng:
   * thà thiếu một cảnh báo còn hơn vẽ một con đường không tồn tại.
   */
  private async buildDetour(
    seed: TripSeed,
    spine: readonly LatLng[],
    cum: readonly number[],
    stopAlong: readonly number[],
    total: number,
  ): Promise<{
    path: LatLng[];
    fromAlong: number;
    toAlong: number;
    meters: number;
    extraSeconds: number;
    afterStopIndex: number;
  } | null> {
    const spec = seed.detour;
    if (!spec || spine.length < 2) return null;

    const index = spec.afterStopIndex - 1;
    if (index < 0 || index >= stopAlong.length) return null;

    const fromAlong = stopAlong[index];
    const nextAlong = index + 1 < stopAlong.length ? stopAlong[index + 1] : total;
    // Nhập lại tuyến ở giữa chặng kế tiếp: đủ dài để thấy rõ, đủ ngắn để không
    // nuốt trọn chặng và làm điểm giao sau đó mất phần đường dẫn tới.
    const toAlong = fromAlong + (nextAlong - fromAlong) * 0.5;
    if (toAlong <= fromAlong) return null;

    const anchor = pointAtAlong(spine, fromAlong, cum);
    const rejoin = pointAtAlong(spine, toAlong, cum);
    const via: LatLng = {
      lat: anchor.lat + spec.offset.lat,
      lng: anchor.lng + spec.offset.lng,
    };

    try {
      const detour = await this.routing.computeRoute({
        points: [anchor, via, rejoin],
        travelMode: 'driving',
      });
      if (detour.path.length < 2) return null;

      // Thời gian ĐỘI THÊM = thời gian đi vòng trừ thời gian lẽ ra phải đi.
      const replacedSeconds =
        ((toAlong - fromAlong) / Math.max(total, 1)) *
        ((total / 1000 / FALLBACK_CRUISE_KMH) * 3600);
      const detourSeconds =
        detour.durationSeconds && detour.durationSeconds > 0
          ? detour.durationSeconds
          : (detour.distanceMeters / 1000 / FALLBACK_CRUISE_KMH) * 3600;

      return {
        path: detour.path,
        fromAlong,
        toAlong,
        meters: detour.distanceMeters || totalDistanceMeters(detour.path),
        extraSeconds: Math.max(0, detourSeconds - replacedSeconds),
        afterStopIndex: spec.afterStopIndex,
      };
    } catch {
      return null;
    }
  }

  /** Ghép: phần đi đúng tuyến + vòng đi lệch + phần còn lại tới vị trí hiện tại. */
  private assembleTravelled(
    spine: readonly LatLng[],
    cum: readonly number[],
    progress: number,
    detour: { path: LatLng[]; fromAlong: number; toAlong: number } | null,
  ): LatLng[] {
    if (!detour || detour.toAlong >= progress) {
      return slicePathByDistance(spine, cum, 0, progress);
    }

    return [
      ...slicePathByDistance(spine, cum, 0, detour.fromAlong),
      ...detour.path,
      ...slicePathByDistance(spine, cum, detour.toAlong, progress),
    ];
  }

  /**
   * Giờ kế hoạch và giờ thực tế của từng điểm giao.
   *
   * KẾ HOẠCH  = giờ rời kho + thời gian lăn bánh của dịch vụ định tuyến
   *             + `PLANNED_SERVICE_SECONDS` cho mỗi điểm đã ghé trước đó.
   * THỰC TẾ   = giờ rời kho + thời gian lăn bánh THẬT (đã gồm đoạn đi lệch)
   *             + thời gian đứng giao hàng THẬT của các điểm trước đó.
   *
   * Số phút chậm vì thế là HIỆU của hai chuỗi trên, và luôn truy được nguyên nhân:
   * đứng lâu hơn định mức, hoặc đi vòng ngoài kế hoạch.
   */
  private buildStops(
    seed: TripSeed,
    legs: readonly NormalizedLeg[],
    simStops: readonly SimStopPlan[],
    departure: Date,
  ): DeliveryStop[] {
    let plannedAcc = 0;
    let actualAcc = 0;

    return seed.stops.map((s, index) => {
      plannedAcc += legs[index]?.seconds ?? 0;
      const planned = new Date(departure.getTime() + plannedAcc * 1000);
      plannedAcc += PLANNED_SERVICE_SECONDS;

      const sim = simStops[index];
      let actual: string | null = null;

      if (sim) {
        actualAcc += sim.driveSeconds;
        actual = new Date(departure.getTime() + actualAcc * 1000).toISOString();
        actualAcc += sim.dwellSeconds;
      }

      return {
        id: `${seed.id}-${index + 1}`,
        seq: index + 1,
        orderCode: s.orderCode,
        customerName: s.customerName,
        address: s.address,
        lat: s.lat,
        lng: s.lng,
        plannedArrival: planned.toISOString(),
        actualArrival: actual,
        status: s.status,
        amount: s.amount,
        note: s.note,
      };
    });
  }

  /** Gắn metadata thiết bị vào các mẫu đã mô phỏng. */
  private toRoutePoints(
    samples: ReturnType<typeof simulateTrack>,
    seed: TripSeed,
    departure: Date,
  ): RoutePoint[] {
    if (!samples.length) return [];

    const spanMs = Math.max(1, samples[samples.length - 1].timeMs - departure.getTime());

    return samples.map((s) => {
      const ratio = (s.timeMs - departure.getTime()) / spanMs;

      return {
        lat: s.point.lat,
        lng: s.point.lng,
        createDate: new Date(s.timeMs).toISOString(),
        // Pin tụt theo THỜI GIAN chứ không theo số thứ tự bản ghi — lúc xe đỗ
        // giao hàng thiết bị vẫn nằm đó tốn pin.
        battery: Math.max(5, Math.round(96 - ratio * 38)),
        speedKmh: Math.round(s.speedKmh),
        staffTitle: seed.driverName,
        deviceId: seed.vehiclePlate,
      } satisfies RoutePoint;
    });
  }

  /** Fallback khi không gọi được dịch vụ định tuyến: nối thẳng, chèn điểm giữa. */
  private straightLine(waypoints: readonly LatLng[]): LatLng[] {
    const result: LatLng[] = [];
    for (let i = 1; i < waypoints.length; i++) {
      const a = waypoints[i - 1];
      const b = waypoints[i];
      const segments = 40;
      for (let s = 0; s < segments; s++) result.push(interpolate(a, b, s / segments));
    }
    result.push(waypoints[waypoints.length - 1]);
    return result;
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private atTime(hhmm: string): Date {
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
  }
}

import { Injectable, inject } from '@angular/core';
import { LatLng, RoutePoint, RoutingFacade, distanceMeters, interpolate } from '../../core/map';
import { DeliveryStop, DeliveryTrip, Depot, StopStatus } from './delivery.models';

interface StopSeed {
  orderCode: string;
  customerName: string;
  address: string;
  lat: number;
  lng: number;
  /** Phút lệch so với giờ kế hoạch (âm = tới sớm). */
  delayMinutes: number;
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
   * Đoạn "đi lệch tuyến" mô phỏng: xe rẽ khỏi lộ trình dự kiến sau điểm thứ N.
   * `null` = chuyến chạy đúng tuyến.
   */
  detour: { afterStopIndex: number; offset: LatLng } | null;
}

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
    detour: { afterStopIndex: 3, offset: { lat: 0.012, lng: -0.014 } },
    stops: [
      {
        orderCode: 'DH-24081',
        customerName: 'Tạp hoá Hàng Bài',
        address: '48 Hàng Bài, Hoàn Kiếm',
        lat: 21.0227,
        lng: 105.8524,
        delayMinutes: -4,
        status: 'delivered',
        amount: 4_850_000,
      },
      {
        orderCode: 'DH-24082',
        customerName: 'Siêu thị mini Bà Triệu',
        address: '191 Bà Triệu, Hai Bà Trưng',
        lat: 21.0126,
        lng: 105.8489,
        delayMinutes: 6,
        status: 'delivered',
        amount: 12_300_000,
      },
      {
        orderCode: 'DH-24083',
        customerName: 'Cửa hàng Kim Liên',
        address: '12 Phạm Ngọc Thạch, Đống Đa',
        lat: 21.006,
        lng: 105.836,
        delayMinutes: 22,
        status: 'delivered',
        amount: 7_620_000,
        note: 'Khách kiểm hàng lâu, giao chậm 22 phút',
      },
      {
        orderCode: 'DH-24084',
        customerName: 'Đại lý Thanh Xuân',
        address: '235 Nguyễn Trãi, Thanh Xuân',
        lat: 20.9955,
        lng: 105.814,
        delayMinutes: 41,
        status: 'failed',
        amount: 9_100_000,
        note: 'Khách đóng cửa, hẹn giao lại chiều',
      },
      {
        orderCode: 'DH-24085',
        customerName: 'Cửa hàng Trung Hoà',
        address: '18 Trung Hoà, Cầu Giấy',
        lat: 21.0079,
        lng: 105.7997,
        delayMinutes: 18,
        status: 'delivered',
        amount: 5_430_000,
      },
      {
        orderCode: 'DH-24086',
        customerName: 'Tạp hoá Mỹ Đình',
        address: '2 Lê Đức Thọ, Nam Từ Liêm',
        lat: 21.0293,
        lng: 105.7796,
        delayMinutes: 0,
        status: 'pending',
        amount: 6_780_000,
      },
      {
        orderCode: 'DH-24087',
        customerName: 'Đại lý Cầu Giấy',
        address: '99 Trần Duy Hưng, Cầu Giấy',
        lat: 21.0333,
        lng: 105.797,
        delayMinutes: 0,
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
        delayMinutes: 3,
        status: 'delivered',
        amount: 21_400_000,
      },
      {
        orderCode: 'DH-31202',
        customerName: 'Cửa hàng Phú Nhuận',
        address: '155 Phan Xích Long, Phú Nhuận',
        lat: 10.787,
        lng: 106.69,
        delayMinutes: -6,
        status: 'delivered',
        amount: 8_900_000,
      },
      {
        orderCode: 'DH-31203',
        customerName: 'Đại lý Tân Bình',
        address: '77 Cộng Hoà, Tân Bình',
        lat: 10.8005,
        lng: 106.658,
        delayMinutes: 11,
        status: 'delivered',
        amount: 13_050_000,
      },
      {
        orderCode: 'DH-31204',
        customerName: 'Tạp hoá Quận 3',
        address: '40 Võ Văn Tần, Quận 3',
        lat: 10.7629,
        lng: 106.6822,
        delayMinutes: 4,
        status: 'delivered',
        amount: 4_120_000,
      },
      {
        orderCode: 'DH-31205',
        customerName: 'Siêu thị Quận 4',
        address: '12 Hoàng Diệu, Quận 4',
        lat: 10.7411,
        lng: 106.7002,
        delayMinutes: 0,
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
    detour: { afterStopIndex: 1, offset: { lat: -0.009, lng: 0.011 } },
    stops: [
      {
        orderCode: 'DH-77011',
        customerName: 'Cửa hàng Thanh Khê',
        address: '210 Điện Biên Phủ, Thanh Khê',
        lat: 16.0678,
        lng: 108.2208,
        delayMinutes: 2,
        status: 'delivered',
        amount: 5_300_000,
      },
      {
        orderCode: 'DH-77012',
        customerName: 'Tạp hoá Hải Châu',
        address: '35 Nguyễn Văn Linh, Hải Châu',
        lat: 16.0544,
        lng: 108.2022,
        delayMinutes: 9,
        status: 'delivered',
        amount: 7_800_000,
      },
      {
        orderCode: 'DH-77013',
        customerName: 'Đại lý Sơn Trà',
        address: '88 Ngô Quyền, Sơn Trà',
        lat: 16.0471,
        lng: 108.2199,
        delayMinutes: 27,
        status: 'delivered',
        amount: 11_250_000,
        note: 'Kẹt xe cầu Rồng',
      },
      {
        orderCode: 'DH-77014',
        customerName: 'Siêu thị Ngũ Hành Sơn',
        address: '5 Lê Văn Hiến, Ngũ Hành Sơn',
        lat: 16.0339,
        lng: 108.2436,
        delayMinutes: 0,
        status: 'pending',
        amount: 9_400_000,
      },
    ],
  },
];

/**
 * ================== GIẢ LẬP API GIÁM SÁT GIAO HÀNG ==================
 *
 * Ở hệ thống thật, màn hình sẽ gọi:
 *  - `GET /delivery/trips?date=...`            -> danh sách chuyến
 *  - `GET /delivery/trips/{id}`                -> chi tiết + danh sách điểm giao
 *  - `GET /staffPositionLog/percent?...`       -> GPS log của tài xế
 *
 * Ở demo này, GPS log được **sinh ra từ chính lộ trình định tuyến thật**:
 *  1. Gọi dịch vụ định tuyến qua `[kho, ...các điểm giao, kho]` -> lộ trình dự kiến.
 *  2. Lấy mẫu điểm dọc lộ trình đó, cộng nhiễu ±10m (GPS đời thật luôn có nhiễu).
 *  3. Chèn một đoạn "đi lệch tuyến" để màn hình có cái mà cảnh báo.
 *  4. Gắn timestamp/tốc độ/pin cho từng điểm.
 *
 * Nhờ vậy dữ liệu demo bám đúng đường phố thật chứ không phải đường chim bay,
 * và toàn bộ phần tính toán "độ lệch tuyến" ở màn hình chạy trên dữ liệu có ý nghĩa.
 */
@Injectable({ providedIn: 'root' })
export class DeliveryMockApi {
  private readonly routing = inject(RoutingFacade);

  /** Cache theo `tripId + provider` để không phải gọi lại dịch vụ định tuyến. */
  private readonly cache = new Map<string, DeliveryTrip>();

  /**
   * Lộ trình dự kiến đã định tuyến, tái sử dụng chính kết quả dùng để sinh GPS.
   *
   * VÌ SAO TỒN TẠI: màn Điều hành đội xe cần lộ trình dự kiến của CẢ BA chuyến để
   * đo lệch tuyến. Nếu mỗi màn tự gọi định tuyến lại thì mở bảng điều hành là bắn
   * thêm 3 request vào server demo công cộng, trong khi `buildTrack` vừa tính
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
    if (!this.plannedCache.has(id)) await this.getTrip(id);
    return this.plannedCache.get(id) ?? [];
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
    const cached = this.cache.get(id);
    if (cached) return cached;

    const seed = TRIP_SEEDS.find((t) => t.id === id) ?? TRIP_SEEDS[0];
    const stops = this.buildStops(seed);
    const base: Omit<DeliveryTrip, 'track'> = {
      id: seed.id,
      code: seed.code,
      date: this.today(),
      driverName: seed.driverName,
      driverPhone: seed.driverPhone,
      vehiclePlate: seed.vehiclePlate,
      depot: seed.depot,
      stops,
    };

    const track = await this.buildTrack(seed, base);
    const trip: DeliveryTrip = { ...base, track };

    this.cache.set(id, trip);
    return trip;
  }

  // ------------------------------------------------------------- dựng dữ liệu

  private buildStops(seed: TripSeed): DeliveryStop[] {
    const departure = this.atTime(seed.departAt);

    return seed.stops.map((s, index) => {
      // Kế hoạch: mỗi điểm cách nhau 25 phút kể từ lúc rời kho.
      const planned = new Date(departure.getTime() + (index + 1) * 25 * 60_000);
      const actual =
        s.status === 'pending'
          ? null
          : new Date(planned.getTime() + s.delayMinutes * 60_000).toISOString();

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

  /**
   * Sinh GPS track. Nếu dịch vụ định tuyến lỗi (mất mạng, OSRM demo quá tải) thì
   * fallback về nội suy đường thẳng — màn hình vẫn chạy được, chỉ là đường không
   * bám theo phố.
   */
  private async buildTrack(
    seed: TripSeed,
    trip: Omit<DeliveryTrip, 'track'>,
  ): Promise<RoutePoint[]> {
    const waypoints = this.buildPlannedWaypoints(trip);

    let spine: LatLng[];
    try {
      const route = await this.routing.computeRoute({ points: waypoints, travelMode: 'driving' });
      spine = route.path.length > 1 ? route.path : this.straightLine(waypoints);
    } catch {
      spine = this.straightLine(waypoints);
    }

    // Giữ lại đúng đường vừa tính để màn Điều hành khỏi phải gọi định tuyến lần nữa.
    this.plannedCache.set(seed.id, spine);

    // Xe mới chạy được ~72% hành trình -> vẫn còn điểm "Chưa tới" trên bản đồ.
    const travelled = spine.slice(0, Math.max(2, Math.floor(spine.length * 0.72)));
    const withDetour = this.applyDetour(travelled, seed);

    // Lấy mẫu ~1 điểm GPS mỗi 6 điểm hình học, tối thiểu 60 điểm cho mượt.
    const step = Math.max(1, Math.floor(withDetour.length / 220));
    const sampled = withDetour.filter((_, i) => i % step === 0);

    const departure = this.atTime(seed.departAt);
    // Toàn bộ track trải trong 3 giờ 20 phút.
    const totalMs = 200 * 60_000;

    return sampled.map((p, i) => {
      const ratio = sampled.length > 1 ? i / (sampled.length - 1) : 0;
      const prev = sampled[Math.max(0, i - 1)];
      const gapSeconds = (totalMs / Math.max(1, sampled.length - 1)) / 1000;

      return {
        // Nhiễu GPS ±~11m — dùng `pseudoRandom` để dữ liệu ổn định giữa các lần
        // mở màn hình (nếu dùng Math.random thì mỗi lần F5 lại ra một đường khác).
        lat: p.lat + this.pseudoRandom(i, 1) * 0.0001,
        lng: p.lng + this.pseudoRandom(i, 2) * 0.0001,
        createDate: new Date(departure.getTime() + ratio * totalMs).toISOString(),
        battery: Math.round(96 - ratio * 38),
        speedKmh: Math.round((distanceMeters(prev, p) / gapSeconds) * 3.6),
        staffTitle: seed.driverName,
        deviceId: seed.vehiclePlate,
      } satisfies RoutePoint;
    });
  }

  /**
   * Chèn một đoạn đi vòng ra khỏi lộ trình dự kiến (mô phỏng tài xế tạt ngang).
   * Đoạn này chính là thứ làm cho cảnh báo "lệch tuyến" ở màn hình có dữ liệu thật.
   */
  private applyDetour(path: LatLng[], seed: TripSeed): LatLng[] {
    if (!seed.detour || path.length < 20) return path;

    const start = Math.floor(path.length * 0.35);
    const end = Math.min(path.length - 1, start + Math.floor(path.length * 0.12));
    const anchor = path[start];
    const away: LatLng = {
      lat: anchor.lat + seed.detour.offset.lat,
      lng: anchor.lng + seed.detour.offset.lng,
    };

    const detour: LatLng[] = [];
    const half = Math.max(4, Math.floor((end - start) / 2));
    for (let i = 1; i <= half; i++) detour.push(interpolate(anchor, away, i / half));
    for (let i = 1; i <= half; i++) detour.push(interpolate(away, path[end], i / half));

    return [...path.slice(0, start + 1), ...detour, ...path.slice(end)];
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

  /** Nhiễu giả lập tất định trong khoảng [-1, 1) — thay cho `Math.random()`. */
  private pseudoRandom(index: number, salt: number): number {
    const x = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1;
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

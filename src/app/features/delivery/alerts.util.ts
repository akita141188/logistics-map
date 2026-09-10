/**
 * IMPORT SÂU CÓ CHỦ Ý (không dùng barrel `../../core/map`).
 *
 * File này là LOGIC THUẦN TUÝ — không Angular, không DOM, không mạng. Đi qua
 * barrel là kéo theo `osm-map.component` → `leaflet` → `window`, khiến:
 *   - unit test phải dựng jsdom dù chẳng đụng gì tới DOM,
 *   - bundler không tách được code nữa (xem chú thích ở `app.config.ts`).
 */
import { LatLng, RoutePoint } from '../../core/map/map.types';
import {
  StopEvent,
  detectStops,
  findGaps,
  secondsBetween,
  speedProfileKmh,
  timeOf,
} from '../../core/map/gps-quality.util';
import {
  distanceMeters,
  distanceToPathMeters,
  formatDistance,
  formatTimeLabel,
} from '../../core/map/geo.util';
import { DeliveryStop, DeliveryTrip } from './delivery.models';

/**
 * =================== BỘ MÁY CẢNH BÁO VẬN TẢI ===================
 *
 * Đây là phần biến "một bản đồ có vẽ đường" thành "một hệ thống giám sát".
 *
 * Nguyên tắc thiết kế quan trọng nhất: **cảnh báo phải ÍT và ĐÁNG TIN**.
 * Một màn hình điều hành bắn 200 cảnh báo mỗi ca thì sau ba ngày không ai nhìn
 * nữa — hiện tượng "alert fatigue". Vì vậy mọi luật ở đây đều:
 *
 *  - gộp các sự kiện liên tiếp thành MỘT cảnh báo (không bắn từng điểm GPS),
 *  - có ngưỡng thời gian/khoảng cách tối thiểu để bỏ qua nhiễu,
 *  - kèm số liệu cụ thể để người điều vận quyết định được ngay, không phải mở
 *    thêm màn khác để tra.
 *
 * Toàn bộ là HÀM THUẦN TUÝ: vào là dữ liệu, ra là danh sách cảnh báo. Không gọi
 * mạng, không đụng signal — nhờ vậy test được bằng dữ liệu dựng tay, và dùng
 * chung được cho cả màn Giám sát một chuyến lẫn màn Điều hành cả đội.
 */

export type AlertType = 'overspeed' | 'idle' | 'offroute' | 'late' | 'failed' | 'gap';

export type AlertSeverity = 'high' | 'medium' | 'low';

export interface FleetAlert {
  id: string;
  tripId: string;
  tripCode: string;
  driverName: string;
  vehiclePlate: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  detail: string;
  /** Thời điểm xảy ra (ISO). Rỗng khi cảnh báo thuộc về trạng thái chứ không phải sự kiện. */
  atIso: string;
  /** Vị trí để bấm vào là bay tới. */
  location: LatLng | null;
}

export const ALERT_LABEL: Record<AlertType, string> = {
  overspeed: 'Quá tốc độ',
  idle: 'Dừng đỗ bất thường',
  offroute: 'Lệch tuyến',
  late: 'Trễ lịch giao',
  failed: 'Giao thất bại',
  gap: 'Mất tín hiệu GPS',
};

export const ALERT_ICON: Record<AlertType, string> = {
  overspeed: '⚡',
  idle: '⏸',
  offroute: '↯',
  late: '⏰',
  failed: '✕',
  gap: '📡',
};

export interface AlertRules {
  overspeedKmh: number;
  /** Phải vượt tốc liên tục ít nhất ngần này giây mới báo (lọc nhiễu GPS). */
  overspeedMinSeconds: number;
  deviationThresholdMeters: number;
  /** Phải lệch liên tục ngần này điểm mới báo (lọc một điểm nhiễu đơn lẻ). */
  offRouteMinPoints: number;
  idleMinutes: number;
  /** Dừng cách mọi điểm giao xa hơn ngần này mét thì mới coi là bất thường. */
  idleAwayFromStopMeters: number;
  lateMinutes: number;
  gapMinutes: number;
}

export const DEFAULT_ALERT_RULES: AlertRules = {
  overspeedKmh: 60,
  overspeedMinSeconds: 60,
  deviationThresholdMeters: 120,
  offRouteMinPoints: 3,
  idleMinutes: 12,
  idleAwayFromStopMeters: 200,
  lateMinutes: 15,
  gapMinutes: 15,
};

/**
 * Sinh toàn bộ cảnh báo của MỘT chuyến.
 *
 * @param track      GPS **đã làm sạch** (`cleanTrack`). Đưa dữ liệu thô vào đây
 *                   là cầm chắc cảnh báo rác: mỗi điểm nhảy cóc thành một lần
 *                   "quá tốc độ 900 km/h".
 * @param plannedPath lộ trình dự kiến đã định tuyến, để đo lệch tuyến.
 */
export function buildTripAlerts(
  trip: DeliveryTrip,
  track: readonly RoutePoint[],
  plannedPath: readonly LatLng[],
  rules: Partial<AlertRules> = {},
): FleetAlert[] {
  const r = { ...DEFAULT_ALERT_RULES, ...rules };
  const alerts: FleetAlert[] = [];

  const base = {
    tripId: trip.id,
    tripCode: trip.code,
    driverName: trip.driverName,
    vehiclePlate: trip.vehiclePlate,
  };

  alerts.push(...overspeedAlerts(trip, track, r, base));
  alerts.push(...offRouteAlerts(trip, track, plannedPath, r, base));
  alerts.push(...idleAlerts(trip, track, r, base));
  alerts.push(...gapAlerts(trip, track, r, base));
  alerts.push(...scheduleAlerts(trip, r, base));

  // Nặng trước, rồi mới tới mới nhất trước. Người điều vận đọc từ trên xuống và
  // hiếm khi kéo hết danh sách.
  const weight: Record<AlertSeverity, number> = { high: 0, medium: 1, low: 2 };
  return alerts.sort(
    (a, b) => weight[a.severity] - weight[b.severity] || b.atIso.localeCompare(a.atIso),
  );
}

type AlertBase = Pick<FleetAlert, 'tripId' | 'tripCode' | 'driverName' | 'vehiclePlate'>;

/**
 * QUÁ TỐC ĐỘ — gộp các điểm vượt ngưỡng liên tiếp thành một đoạn.
 *
 * Vì sao phải gộp: xe chạy 70 km/h suốt 4 phút trên đường vành đai sẽ có ~8 điểm
 * GPS vượt ngưỡng. Bắn 8 cảnh báo cho cùng một hành vi là vô nghĩa; phải là một
 * cảnh báo "vượt tốc 4 phút, đỉnh 74 km/h".
 */
function overspeedAlerts(
  trip: DeliveryTrip,
  track: readonly RoutePoint[],
  rules: AlertRules,
  base: AlertBase,
): FleetAlert[] {
  if (track.length < 3) return [];

  const speeds = speedProfileKmh(track);
  const alerts: FleetAlert[] = [];

  let start = -1;

  const close = (end: number) => {
    if (start < 0) return;

    const seconds = secondsBetween(track[start], track[end]);
    if (seconds >= rules.overspeedMinSeconds) {
      const peak = Math.max(...speeds.slice(start, end + 1));
      const meters = segmentLength(track, start, end);

      alerts.push({
        ...base,
        id: `${trip.id}-speed-${start}`,
        type: 'overspeed',
        // Vượt hơn 20 km/h so với ngưỡng là hành vi nguy hiểm, không còn là
        // "trôi nhẹ quá tốc" nữa.
        severity: peak > rules.overspeedKmh + 20 ? 'high' : 'medium',
        title: `Vượt ${Math.round(peak)} km/h`,
        detail:
          `Chạy quá ${rules.overspeedKmh} km/h liên tục ${Math.round(seconds / 60)} phút ` +
          `(${formatDistance(meters)}), từ ${formatTimeLabel(timeOf(track[start]))}`,
        atIso: timeOf(track[start]) ?? '',
        location: { lat: track[start].lat, lng: track[start].lng },
      });
    }
    start = -1;
  };

  for (let i = 0; i < track.length; i++) {
    if (speeds[i] > rules.overspeedKmh) {
      if (start < 0) start = i;
    } else {
      close(Math.max(start, i - 1));
    }
  }
  close(track.length - 1);

  return alerts;
}

/**
 * LỆCH TUYẾN — cách lộ trình dự kiến quá ngưỡng, liên tục nhiều điểm.
 *
 * Điều kiện "liên tục nhiều điểm" là bắt buộc: một điểm GPS nhiễu văng ra 150 m
 * rồi quay lại ngay không phải là lệch tuyến, đó là lỗi thiết bị.
 */
function offRouteAlerts(
  trip: DeliveryTrip,
  track: readonly RoutePoint[],
  plannedPath: readonly LatLng[],
  rules: AlertRules,
  base: AlertBase,
): FleetAlert[] {
  if (plannedPath.length < 2 || track.length < 2) return [];

  const alerts: FleetAlert[] = [];
  let start = -1;
  let peak = 0;

  const close = (end: number) => {
    if (start < 0) return;

    if (end - start + 1 >= rules.offRouteMinPoints) {
      const minutes = Math.round(secondsBetween(track[start], track[end]) / 60);

      alerts.push({
        ...base,
        id: `${trip.id}-offroute-${start}`,
        type: 'offroute',
        severity: peak > rules.deviationThresholdMeters * 3 ? 'high' : 'medium',
        title: `Lệch tuyến ${formatDistance(peak)}`,
        detail:
          `Ra khỏi lộ trình dự kiến ${end - start + 1} điểm GPS` +
          (minutes ? ` (~${minutes} phút)` : '') +
          `, từ ${formatTimeLabel(timeOf(track[start]))}`,
        atIso: timeOf(track[start]) ?? '',
        location: { lat: track[start].lat, lng: track[start].lng },
      });
    }

    start = -1;
    peak = 0;
  };

  for (let i = 0; i < track.length; i++) {
    const d = distanceToPathMeters(track[i], plannedPath);

    if (d > rules.deviationThresholdMeters) {
      if (start < 0) start = i;
      peak = Math.max(peak, d);
    } else {
      close(Math.max(start, i - 1));
    }
  }
  close(track.length - 1);

  return alerts;
}

/**
 * DỪNG ĐỖ BẤT THƯỜNG — đứng lâu ở chỗ KHÔNG có điểm giao nào gần đó.
 *
 * Đây là luật có giá trị nghiệp vụ cao nhất trong cả bộ: dừng lâu tại điểm giao
 * là chuyện bình thường (đang giao hàng), nhưng dừng 40 phút ở một chỗ cách mọi
 * điểm giao 2 km thì cần giải trình. Không lọc theo khoảng cách tới điểm giao
 * thì luật này chỉ bắn ra toàn cảnh báo giả.
 */
function idleAlerts(
  trip: DeliveryTrip,
  track: readonly RoutePoint[],
  rules: AlertRules,
  base: AlertBase,
): FleetAlert[] {
  const stops: StopEvent[] = detectStops(track, {
    minMinutes: rules.idleMinutes,
    radiusMeters: 60,
  });

  const anchors: LatLng[] = [
    { lat: trip.depot.lat, lng: trip.depot.lng },
    ...trip.stops.map((s) => ({ lat: s.lat, lng: s.lng })),
  ];

  return stops
    .filter((stop) => nearestDistance(stop.center, anchors) > rules.idleAwayFromStopMeters)
    .map((stop) => ({
      ...base,
      id: `${trip.id}-idle-${stop.fromIndex}`,
      type: 'idle' as const,
      severity: stop.minutes > rules.idleMinutes * 2 ? ('high' as const) : ('medium' as const),
      title: `Dừng ${stop.minutes} phút ngoài kế hoạch`,
      detail:
        `Đứng yên từ ${formatTimeLabel(stop.startIso)} đến ${formatTimeLabel(stop.endIso)}, ` +
        `cách điểm giao gần nhất ${formatDistance(nearestDistance(stop.center, anchors))}`,
      atIso: stop.startIso,
      location: stop.center,
    }));
}

/** MẤT TÍN HIỆU — track đứt quãng (app bị kill, hết pin, mất sóng). */
function gapAlerts(
  trip: DeliveryTrip,
  track: readonly RoutePoint[],
  rules: AlertRules,
  base: AlertBase,
): FleetAlert[] {
  return findGaps(track, rules.gapMinutes * 60).map((gap) => ({
    ...base,
    id: `${trip.id}-gap-${gap.index}`,
    type: 'gap' as const,
    severity: gap.minutes > rules.gapMinutes * 3 ? ('high' as const) : ('low' as const),
    title: `Mất tín hiệu ${gap.minutes} phút`,
    detail:
      `Không có dữ liệu từ ${formatTimeLabel(gap.fromIso)} đến ${formatTimeLabel(gap.toIso)}; ` +
      `khi có lại thì xe đã cách ${formatDistance(gap.meters)}`,
    atIso: gap.fromIso,
    location: track[gap.index] ? { lat: track[gap.index].lat, lng: track[gap.index].lng } : null,
  }));
}

/** TRỄ LỊCH & GIAO THẤT BẠI — đọc thẳng từ trạng thái điểm giao. */
function scheduleAlerts(trip: DeliveryTrip, rules: AlertRules, base: AlertBase): FleetAlert[] {
  const alerts: FleetAlert[] = [];

  for (const stop of trip.stops) {
    if (stop.status === 'failed') {
      alerts.push({
        ...base,
        id: `${trip.id}-failed-${stop.id}`,
        type: 'failed',
        severity: 'high',
        title: `Giao thất bại: ${stop.customerName}`,
        detail: `${stop.orderCode} — ${stop.note ?? 'Không rõ lý do'}`,
        atIso: stop.actualArrival ?? stop.plannedArrival,
        location: { lat: stop.lat, lng: stop.lng },
      });
      continue;
    }

    const late = lateMinutesOf(stop);
    if (late > rules.lateMinutes) {
      alerts.push({
        ...base,
        id: `${trip.id}-late-${stop.id}`,
        type: 'late',
        severity: late > rules.lateMinutes * 2 ? 'medium' : 'low',
        title: `Trễ ${late} phút tại ${stop.customerName}`,
        detail:
          `Kế hoạch ${formatTimeLabel(stop.plannedArrival)}, ` +
          `thực tế ${formatTimeLabel(stop.actualArrival)}`,
        atIso: stop.actualArrival ?? '',
        location: { lat: stop.lat, lng: stop.lng },
      });
    }
  }

  return alerts;
}

/** Số phút tới trễ so với kế hoạch (âm = tới sớm, 0 khi thiếu dữ liệu). */
export function lateMinutesOf(stop: DeliveryStop): number {
  if (!stop.actualArrival || !stop.plannedArrival) return 0;

  const diff =
    (new Date(stop.actualArrival).getTime() - new Date(stop.plannedArrival).getTime()) / 60_000;

  return Number.isNaN(diff) ? 0 : Math.round(diff);
}

function nearestDistance(point: LatLng, anchors: readonly LatLng[]): number {
  return anchors.reduce(
    (min, a) => Math.min(min, distanceMeters(point, a)),
    Number.POSITIVE_INFINITY,
  );
}

function segmentLength(track: readonly RoutePoint[], from: number, to: number): number {
  let total = 0;
  for (let i = from + 1; i <= to; i++) total += distanceMeters(track[i - 1], track[i]);
  return total;
}

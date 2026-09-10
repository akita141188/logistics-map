import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MAP_ROUTING_CONFIG, LatLng, MAP_ROUTING_CONFIG } from '../../core/map';
import { DeliveryMockApi } from '../delivery/delivery-mock.api';
import { DeliveryStop, DeliveryTrip } from '../delivery/delivery.models';
import { FleetStore } from './fleet.store';

/**
 * ============ KPI PHẢI ĐI THEO ĐỒNG HỒ, KHÔNG NHÌN THẤY TƯƠNG LAI ============
 *
 * Bảng điều hành có thanh tua thời gian. Bản cũ nội suy VỊ TRÍ xe theo đồng hồ
 * nhưng lại đọc KPI từ trạng thái cuối chuyến — tua về 08:00 mà màn hình vẫn báo
 * đã giao đủ điểm 15:00 và đã chạy hết km cả ngày. Hai nửa màn hình kể hai câu
 * chuyện khác nhau.
 *
 * Kịch bản test: một chuyến, 3 điểm giao lúc 08:00 / 10:00 / 12:00, trong đó
 * điểm 10:00 giao muộn 30 phút và điểm 12:00 giao thất bại.
 */

const T = (h: number, m = 0) =>
  `2026-09-09T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;

const ms = (h: number, m = 0) => new Date(T(h, m)).getTime();

function makeStops(): DeliveryStop[] {
  return [
    {
      id: 'S1',
      seq: 1,
      orderCode: 'DH-1',
      customerName: 'KH 1',
      address: '—',
      lat: 21.01,
      lng: 105.81,
      plannedArrival: T(8),
      actualArrival: T(8), // đúng hẹn
      status: 'delivered',
      amount: 1_000_000,
    },
    {
      id: 'S2',
      seq: 2,
      orderCode: 'DH-2',
      customerName: 'KH 2',
      address: '—',
      lat: 21.02,
      lng: 105.82,
      plannedArrival: T(10),
      actualArrival: T(10, 30), // muộn 30 phút
      status: 'delivered',
      amount: 2_000_000,
    },
    {
      id: 'S3',
      seq: 3,
      orderCode: 'DH-3',
      customerName: 'KH 3',
      address: '—',
      lat: 21.03,
      lng: 105.83,
      plannedArrival: T(12),
      actualArrival: T(12), // tới nơi nhưng KHÔNG giao được
      status: 'failed',
      amount: 4_000_000,
    },
  ];
}

function makeTrip(): DeliveryTrip {
  return {
    id: 'T1',
    code: 'TRIP-1',
    date: '2026-09-09',
    driverName: 'Tài xế',
    driverPhone: '0900000000',
    vehiclePlate: '29A-00000',
    depot: { name: 'Kho', address: '—', lat: 21.0, lng: 105.8 },
    stops: makeStops(),
    // GPS mỗi 2 tiếng, đi thẳng theo kinh độ để quãng đường tăng đều.
    track: [
      { lat: 21.0, lng: 105.8, createDate: T(7) },
      { lat: 21.0, lng: 105.82, createDate: T(9) },
      { lat: 21.0, lng: 105.84, createDate: T(11) },
      { lat: 21.0, lng: 105.86, createDate: T(13) },
    ],
  };
}

class FakeApi {
  getAllTrips = async (): Promise<DeliveryTrip[]> => [makeTrip()];
  getPlannedPath = async (): Promise<LatLng[]> => [
    { lat: 21.0, lng: 105.8 },
    { lat: 21.0, lng: 105.86 },
  ];
}

async function setup() {
  TestBed.resetTestingModule();
  localStorage.clear();

  TestBed.configureTestingModule({
    providers: [
      { provide: MAP_ROUTING_CONFIG, useValue: DEFAULT_MAP_ROUTING_CONFIG },
      { provide: DeliveryMockApi, useClass: FakeApi },
      FleetStore,
    ],
  });

  const store = TestBed.inject(FleetStore);
  await TestBed.inject(ApplicationRef).whenStable();
  // Dừng đồng hồ để test tự điều khiển mốc thời gian.
  store.setSpeed(0);
  return store;
}

describe('FleetStore — KPI as-of clock', () => {
  beforeEach(() => localStorage.clear());

  it('trước khi bắt đầu: chưa giao gì, chưa chạy km nào', async () => {
    const store = await setup();
    store.seek(ms(6));

    const kpi = store.kpi();
    expect(kpi.deliveredStops).toBe(0);
    expect(kpi.failedStops).toBe(0);
    expect(kpi.collectedAmount).toBe(0);
    expect(kpi.distanceMeters).toBe(0);
    // Toàn bộ tiền vẫn là "còn phải thu".
    expect(kpi.pendingAmount).toBe(7_000_000);
  });

  it('giữa hành trình: chỉ thấy phần đã xảy ra', async () => {
    const store = await setup();
    store.seek(ms(11));

    const kpi = store.kpi();
    // 08:00 và 10:30 đã qua; 12:00 thì chưa.
    expect(kpi.deliveredStops).toBe(2);
    expect(kpi.failedStops).toBe(0);
    expect(kpi.collectedAmount).toBe(3_000_000);
    expect(kpi.pendingAmount).toBe(4_000_000);
    expect(kpi.distanceMeters).toBeGreaterThan(0);
  });

  it('kết thúc: đủ số liệu cả ngày', async () => {
    const store = await setup();
    store.seek(ms(13));

    const kpi = store.kpi();
    expect(kpi.deliveredStops).toBe(2);
    expect(kpi.failedStops).toBe(1);
    expect(kpi.collectedAmount).toBe(3_000_000);
    expect(kpi.pendingAmount).toBe(0);
  });

  it('KPI chỉ tăng theo thời gian, không bao giờ tụt', async () => {
    const store = await setup();

    let prevDelivered = -1;
    let prevDistance = -1;

    for (const hour of [6, 8, 9, 10, 11, 12, 13]) {
      store.seek(ms(hour));
      const kpi = store.kpi();

      expect(kpi.deliveredStops).toBeGreaterThanOrEqual(prevDelivered);
      expect(kpi.distanceMeters).toBeGreaterThanOrEqual(prevDistance);

      prevDelivered = kpi.deliveredStops;
      prevDistance = kpi.distanceMeters;
    }
  });

  it('km đã chạy tại thời điểm giữa < km cả ngày', async () => {
    const store = await setup();

    store.seek(ms(9));
    const half = store.kpi().distanceMeters;

    store.seek(ms(13));
    const full = store.kpi().distanceMeters;

    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(full);
  });

  it('thẻ từng xe cũng theo đồng hồ: điểm kế tiếp là điểm chưa xử lý đầu tiên', async () => {
    const store = await setup();

    store.seek(ms(9));
    expect(store.vehicles()[0].deliveredCount).toBe(1);
    expect(store.vehicles()[0].nextStop?.id).toBe('S2');

    store.seek(ms(11));
    expect(store.vehicles()[0].deliveredCount).toBe(2);
    expect(store.vehicles()[0].nextStop?.id).toBe('S3');
  });
});

describe('FleetStore — tỉ lệ giao đúng hẹn', () => {
  beforeEach(() => localStorage.clear());

  it('không bao giờ âm, dù có điểm giao thất bại lúc muộn giờ', async () => {
    const store = await setup();
    store.seek(ms(13));

    const kpi = store.kpi();
    expect(kpi.onTimeRate).toBeGreaterThanOrEqual(0);
    expect(kpi.onTimeRate).toBeLessThanOrEqual(1);
  });

  it('tử số và mẫu số cùng một tập: giao thành công đúng hẹn / giao thành công', async () => {
    const store = await setup();
    store.seek(ms(13));

    const kpi = store.kpi();
    // 2 điểm giao thành công, 1 trong đó muộn -> 1/2.
    expect(kpi.deliveredStops).toBe(2);
    expect(kpi.lateStops).toBe(1);
    expect(kpi.onTimeRate).toBeCloseTo(0.5, 5);
  });

  it('điểm giao thất bại KHÔNG bị trừ vào tử số của giao đúng hẹn', async () => {
    const store = await setup();

    // Trước 12:00 chưa có điểm failed nào; sau 12:00 có 1.
    store.seek(ms(11));
    const before = store.kpi().onTimeRate;

    store.seek(ms(13));
    const after = store.kpi().onTimeRate;

    // Thêm một điểm FAILED không được làm đổi tỉ lệ GIAO ĐÚNG HẸN.
    expect(after).toBeCloseTo(before, 5);
  });

  it('chưa xử lý điểm nào -> tỉ lệ là 0 chứ không phải NaN', async () => {
    const store = await setup();
    store.seek(ms(6));

    expect(store.kpi().onTimeRate).toBe(0);
    expect(Number.isNaN(store.kpi().onTimeRate)).toBe(false);
  });
});

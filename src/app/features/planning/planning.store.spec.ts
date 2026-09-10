import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CostMatrix, LatLng, RouteResult, RoutingFacade } from '../../core/map';
import { PlanningMockApi } from './planning-mock.api';
import { PlanningStore } from './planning.store';
import { DeliveryOrder, PlanningDepot, PlanningVehicle } from './planning.models';

/**
 * ============ CHỈNH TAY KẾ HOẠCH KHÔNG ĐƯỢC PHÁ RÀNG BUỘC ============
 *
 * Thuật toán CVRP tôn trọng tải trọng và số điểm mỗi chuyến. Nhưng thao tác kéo
 * đơn sang xe khác thì bản cũ bỏ qua cả hai — người dùng dồn hết đơn lên một xe
 * và hệ thống nhận, vẽ tuyến, tính ra tiền. Sai sót chỉ lộ ra ở bãi xe.
 *
 * Dữ liệu test cố ý nhỏ và tự dựng (không dùng seed thật) để con số ràng buộc
 * nằm ngay trước mắt, đọc là biết vì sao case đó phải bị từ chối.
 */

const DEPOT: PlanningDepot = {
  id: 'D1',
  name: 'Kho test',
  address: '—',
  lat: 21.0,
  lng: 105.8,
  departHour: 7.25,
};

/** 4 đơn, mỗi đơn 300 kg. */
function makeOrders(): DeliveryOrder[] {
  return Array.from({ length: 4 }, (_, i) => ({
    id: `O${i + 1}`,
    code: `DH-${i + 1}`,
    customerName: `KH ${i + 1}`,
    address: `Địa chỉ ${i + 1}`,
    lat: 21.0 + (i + 1) * 0.01,
    lng: 105.8 + (i + 1) * 0.01,
    weightKg: 300,
    amount: 1_000_000,
    windowFrom: 8,
    windowTo: 17,
    priority: 'normal' as const,
    serviceMinutes: 10,
  }));
}

/**
 * XE A: 1000 kg / 5 điểm  -> chở được 3 đơn (900 kg), đơn thứ 4 là vượt tải.
 * XE B: 5000 kg / 2 điểm  -> thừa tải nhưng chỉ được 2 điểm.
 */
function makeVehicles(): PlanningVehicle[] {
  return [
    {
      id: 'V-A',
      plate: '29A-00001',
      driverName: 'Tài xế A',
      capacityKg: 1000,
      maxStops: 5,
      costPerKm: 10_000,
      color: '#2563eb',
      available: true,
    },
    {
      id: 'V-B',
      plate: '29B-00002',
      driverName: 'Tài xế B',
      capacityKg: 5000,
      maxStops: 2,
      costPerKm: 10_000,
      color: '#16a34a',
      available: true,
    },
  ];
}

class FakeApi {
  getDepot = () => ({ ...DEPOT });
  getOrders = () => makeOrders();
  getVehicles = () => makeVehicles();
}

/** Ma trận giả: mọi cặp cách nhau 1 km / 2 phút, đủ để solver chạy. */
function fakeMatrix(size: number): CostMatrix {
  const distances = Array.from({ length: size }, (_, i) =>
    Array.from({ length: size }, (_, j) => (i === j ? 0 : 1000)),
  );
  const durations = distances.map((row) => row.map((d) => (d ? 120 : 0)));
  return { distances, durations, real: true } as CostMatrix;
}

const computeRoute = vi.fn(
  async ({ points }: { points: readonly LatLng[] }): Promise<RouteResult> => ({
    path: [...points],
    distanceMeters: (points.length - 1) * 1000,
    durationSeconds: (points.length - 1) * 120,
  }),
);

async function setup() {
  TestBed.resetTestingModule();
  computeRoute.mockClear();

  TestBed.configureTestingModule({
    providers: [
      { provide: PlanningMockApi, useClass: FakeApi },
      {
        provide: RoutingFacade,
        useValue: {
          computeRoute,
          matrix: vi.fn(async (points: readonly LatLng[]) => fakeMatrix(points.length)),
        },
      },
      PlanningStore,
    ],
  });

  const store = TestBed.inject(PlanningStore);
  await store.optimize();
  return store;
}

/** Dồn hết đơn đang có về một xe để dựng sẵn tình huống sát trần. */
function stackOn(store: PlanningStore, vehicleId: string, orderIds: string[]): void {
  for (const id of orderIds) store.moveOrder(id, vehicleId);
}

describe('PlanningStore — kéo đơn phải tôn trọng tải trọng / số điểm', () => {
  beforeEach(() => localStorage.clear());

  it('kéo đơn làm xe vượt TẢI TRỌNG -> từ chối và nói rõ lý do', async () => {
    const store = await setup();

    // Xe A (1000 kg) nhận 3 đơn x 300 kg = 900 kg: vẫn hợp lệ.
    stackOn(store, 'V-A', ['O1', 'O2', 'O3']);
    expect(store.moveError()).toBeNull();

    // Đơn thứ 4 đẩy lên 1200 kg -> phải bị chặn.
    const accepted = store.moveOrder('O4', 'V-A');

    expect(accepted).toBe(false);
    expect(store.moveError()).toContain('1000 kg');
    expect(store.moveError()).toContain('vượt 200 kg');
  });

  it('kéo đơn làm xe vượt SỐ ĐIỂM -> từ chối', async () => {
    const store = await setup();

    // Xe B chỉ được 2 điểm.
    stackOn(store, 'V-B', ['O1', 'O2']);
    expect(store.moveError()).toBeNull();

    const accepted = store.moveOrder('O3', 'V-B');

    expect(accepted).toBe(false);
    expect(store.moveError()).toContain('tối đa 2 điểm');
  });

  it('bị từ chối thì đơn KHÔNG được rơi khỏi xe cũ', async () => {
    const store = await setup();

    stackOn(store, 'V-A', ['O1', 'O2', 'O3']);
    store.moveOrder('O4', 'V-B');

    const before = snapshot(store);
    expect(store.moveOrder('O4', 'V-A')).toBe(false);

    // Toàn bộ kế hoạch phải y nguyên: không mất đơn, không đổi xe.
    expect(snapshot(store)).toEqual(before);
    expect(ownerOf(store, 'O4')).toBe('V-B');
  });

  it('nước đi hợp lệ vẫn chạy và chèn vào đúng tuyến', async () => {
    const store = await setup();

    const accepted = store.moveOrder('O1', 'V-B');

    expect(accepted).toBe(true);
    expect(store.moveError()).toBeNull();
    expect(ownerOf(store, 'O1')).toBe('V-B');
  });

  it('trả đơn về danh sách chưa phân xe thì LUÔN được phép', async () => {
    const store = await setup();

    stackOn(store, 'V-B', ['O1', 'O2']);
    const accepted = store.moveOrder('O1', null);

    expect(accepted).toBe(true);
    expect(store.unassignedIds()).toContain('O1');
    expect(ownerOf(store, 'O1')).toBeNull();
  });

  it('kéo đơn về chính xe đang chở nó không bị coi là vượt tải', async () => {
    const store = await setup();

    stackOn(store, 'V-A', ['O1', 'O2', 'O3']);
    const owner = ownerOf(store, 'O3')!;

    expect(store.canMoveOrder('O3', owner)).toBe(true);
    expect(store.moveOrder('O3', owner)).toBe(true);
  });

  it('canMoveOrder trả lời trước khi người dùng bấm', async () => {
    const store = await setup();

    stackOn(store, 'V-B', ['O1', 'O2']);

    expect(store.canMoveOrder('O3', 'V-B')).toBe(false);
    expect(store.canMoveOrder('O3', 'V-A')).toBe(true);
  });
});

/** Ảnh chụp kế hoạch: `orderId -> vehicleId`, dùng để so trước/sau. */
function snapshot(store: PlanningStore): Record<string, string | null> {
  const map: Record<string, string | null> = {};
  for (const order of store.orders()) map[order.id] = ownerOf(store, order.id);
  return map;
}

function ownerOf(store: PlanningStore, orderId: string): string | null {
  return (
    store.routes().find((r) => r.stops.some((s) => s.order.id === orderId))?.vehicle.id ?? null
  );
}

import { Injectable } from '@angular/core';
import { DeliveryOrder, PlanningDepot, PlanningVehicle } from './planning.models';

/**
 * ============ DỮ LIỆU GIẢ LẬP CHO MÀN LẬP KẾ HOẠCH ============
 *
 * Ở hệ thống thật, ba nguồn này đến từ ba nơi khác nhau:
 *  - đơn hàng   : `GET /orders?status=confirmed&deliveryDate=...` (phân hệ bán hàng)
 *  - xe & tài xế: `GET /vehicles?status=available` (phân hệ quản lý đội xe)
 *  - kho        : `GET /warehouses` (dữ liệu gốc, khai báo ở CMS)
 *
 * Toạ độ dưới đây là địa chỉ có thật ở Hà Nội, rải đều 4 hướng quanh kho Long
 * Biên — cố ý, để bài toán chia tuyến có lời giải "thú vị": nếu tất cả đơn nằm
 * cùng một hướng thì thuật toán nào cũng cho kết quả giống nhau và không chứng
 * minh được gì.
 *
 * Có 3 đơn nằm bên kia sông Hồng (Long Biên, Gia Lâm) — đây là phép thử quan
 * trọng nhất: đường chim bay thấy chúng rất gần các đơn ở Hoàn Kiếm, nhưng đường
 * thật phải vòng qua cầu. Chỉ ma trận đường thật mới xếp đúng.
 */

const DEPOT: PlanningDepot = {
  id: 'DEPOT-LB',
  name: 'Kho tổng Long Biên',
  address: 'Số 5 Ngọc Lâm, Long Biên, Hà Nội',
  lat: 21.0447,
  lng: 105.8752,
  departHour: 7.25,
};

const ORDERS: DeliveryOrder[] = [
  {
    id: 'O-01',
    code: 'DH-24101',
    customerName: 'Tạp hoá Hàng Bài',
    address: '48 Hàng Bài, Hoàn Kiếm',
    lat: 21.0227,
    lng: 105.8524,
    weightKg: 320,
    amount: 4_850_000,
    windowFrom: 8,
    windowTo: 11,
    priority: 'normal',
    serviceMinutes: 10,
  },
  {
    id: 'O-02',
    code: 'DH-24102',
    customerName: 'Siêu thị mini Bà Triệu',
    address: '191 Bà Triệu, Hai Bà Trưng',
    lat: 21.0126,
    lng: 105.8489,
    weightKg: 540,
    amount: 12_300_000,
    windowFrom: 8,
    windowTo: 12,
    priority: 'high',
    serviceMinutes: 15,
  },
  {
    id: 'O-03',
    code: 'DH-24103',
    customerName: 'Cửa hàng Kim Liên',
    address: '12 Phạm Ngọc Thạch, Đống Đa',
    lat: 21.006,
    lng: 105.836,
    weightKg: 280,
    amount: 7_620_000,
    windowFrom: 9,
    windowTo: 12,
    priority: 'normal',
    serviceMinutes: 10,
  },
  {
    id: 'O-04',
    code: 'DH-24104',
    customerName: 'Đại lý Thanh Xuân',
    address: '235 Nguyễn Trãi, Thanh Xuân',
    lat: 20.9955,
    lng: 105.814,
    weightKg: 760,
    amount: 9_100_000,
    windowFrom: 9,
    windowTo: 13,
    priority: 'normal',
    serviceMinutes: 15,
  },
  {
    id: 'O-05',
    code: 'DH-24105',
    customerName: 'Cửa hàng Trung Hoà',
    address: '18 Trung Hoà, Cầu Giấy',
    lat: 21.0079,
    lng: 105.7997,
    weightKg: 410,
    amount: 5_430_000,
    windowFrom: 8.5,
    windowTo: 11.5,
    priority: 'normal',
    serviceMinutes: 10,
  },
  {
    id: 'O-06',
    code: 'DH-24106',
    customerName: 'Tạp hoá Mỹ Đình',
    address: '2 Lê Đức Thọ, Nam Từ Liêm',
    lat: 21.0293,
    lng: 105.7796,
    weightKg: 350,
    amount: 6_780_000,
    windowFrom: 9,
    windowTo: 14,
    priority: 'normal',
    serviceMinutes: 10,
  },
  {
    id: 'O-07',
    code: 'DH-24107',
    customerName: 'Đại lý Cầu Giấy',
    address: '99 Trần Duy Hưng, Cầu Giấy',
    lat: 21.0333,
    lng: 105.797,
    weightKg: 620,
    amount: 15_200_000,
    windowFrom: 8,
    windowTo: 11,
    priority: 'high',
    serviceMinutes: 20,
  },
  {
    id: 'O-08',
    code: 'DH-24108',
    customerName: 'Siêu thị Tây Hồ',
    address: '52 Xuân Diệu, Tây Hồ',
    lat: 21.0685,
    lng: 105.8253,
    weightKg: 480,
    amount: 11_400_000,
    windowFrom: 8,
    windowTo: 12,
    priority: 'normal',
    serviceMinutes: 15,
  },
  {
    id: 'O-09',
    code: 'DH-24109',
    customerName: 'Cửa hàng Nghi Tàm',
    address: '310 Nghi Tàm, Tây Hồ',
    lat: 21.0757,
    lng: 105.8348,
    weightKg: 230,
    amount: 3_900_000,
    windowFrom: 9,
    windowTo: 13,
    priority: 'normal',
    serviceMinutes: 10,
  },
  {
    id: 'O-10',
    code: 'DH-24110',
    customerName: 'Đại lý Gia Lâm',
    address: '128 Ngô Xuân Quảng, Gia Lâm',
    lat: 21.0248,
    lng: 105.9385,
    weightKg: 890,
    amount: 18_700_000,
    windowFrom: 8,
    windowTo: 11,
    priority: 'high',
    serviceMinutes: 20,
  },
  {
    id: 'O-11',
    code: 'DH-24111',
    customerName: 'Tạp hoá Sài Đồng',
    address: '5 Sài Đồng, Long Biên',
    lat: 21.0369,
    lng: 105.9042,
    weightKg: 310,
    amount: 5_100_000,
    windowFrom: 9,
    windowTo: 14,
    priority: 'normal',
    serviceMinutes: 10,
  },
  {
    id: 'O-12',
    code: 'DH-24112',
    customerName: 'Cửa hàng Việt Hưng',
    address: '17 Vạn Hạnh, Long Biên',
    lat: 21.0553,
    lng: 105.8985,
    weightKg: 260,
    amount: 4_300_000,
    windowFrom: 8.5,
    windowTo: 12,
    priority: 'normal',
    serviceMinutes: 10,
  },
  {
    id: 'O-13',
    code: 'DH-24113',
    customerName: 'Siêu thị Hoàng Mai',
    address: '89 Trương Định, Hoàng Mai',
    lat: 20.9855,
    lng: 105.8447,
    weightKg: 700,
    amount: 13_800_000,
    windowFrom: 10,
    windowTo: 15,
    priority: 'normal',
    serviceMinutes: 15,
  },
  {
    id: 'O-14',
    code: 'DH-24114',
    customerName: 'Đại lý Linh Đàm',
    address: '2 Nguyễn Duy Trinh, Hoàng Mai',
    lat: 20.9682,
    lng: 105.8302,
    weightKg: 450,
    amount: 8_250_000,
    windowFrom: 10,
    windowTo: 15,
    priority: 'normal',
    serviceMinutes: 10,
  },
  {
    id: 'O-15',
    code: 'DH-24115',
    customerName: 'Tạp hoá Hà Đông',
    address: '120 Quang Trung, Hà Đông',
    lat: 20.9721,
    lng: 105.7788,
    weightKg: 580,
    amount: 9_950_000,
    windowFrom: 10,
    windowTo: 16,
    priority: 'normal',
    serviceMinutes: 15,
  },
  {
    id: 'O-16',
    code: 'DH-24116',
    customerName: 'Cửa hàng Văn Quán',
    address: '8 Nguyễn Khuyến, Hà Đông',
    lat: 20.9805,
    lng: 105.7899,
    weightKg: 190,
    amount: 3_200_000,
    windowFrom: 10,
    windowTo: 16,
    priority: 'normal',
    serviceMinutes: 10,
  },
  {
    id: 'O-17',
    code: 'DH-24117',
    customerName: 'Đại lý Đông Anh',
    address: '45 Cao Lỗ, Đông Anh',
    lat: 21.1362,
    lng: 105.8483,
    weightKg: 640,
    amount: 11_100_000,
    windowFrom: 8,
    windowTo: 12,
    priority: 'normal',
    serviceMinutes: 20,
  },
  {
    id: 'O-18',
    code: 'DH-24118',
    customerName: 'Siêu thị Cổ Loa',
    address: '2 Đường Cổ Loa, Đông Anh',
    lat: 21.1148,
    lng: 105.8747,
    weightKg: 370,
    amount: 6_400_000,
    windowFrom: 9,
    windowTo: 13,
    priority: 'normal',
    serviceMinutes: 10,
  },
];

/**
 * Đội xe.
 *
 * CON SỐ ĐƯỢC CHỌN CÓ CHỦ Ý:
 *   tổng khối lượng 18 đơn        = 8.380 kg
 *   tổng tải trọng 4 xe sẵn sàng  = 7.900 kg  (V-01..V-04)
 *
 * Tức là **thiếu xe** ngay từ đầu. Đây không phải sơ suất mà là tình huống có
 * thật của mọi buổi sáng điều vận, và là thứ demo cần chứng minh: thuật toán
 * phải trả về danh sách "chưa phân xe" thay vì âm thầm nhét quá tải lên xe —
 * quá tải là phạt tiền, gãy nhíp, và mất hàng thật ngoài đường.
 *
 * Xe V-05 để `available: false` (tài xế nghỉ). Bật nó lên là tổng tải trọng
 * thành 9.100 kg và bài toán vừa đủ — người dùng tự thấy được tác động của một
 * quyết định điều vận lên cả kế hoạch.
 */
const VEHICLES: PlanningVehicle[] = [
  {
    id: 'V-01',
    plate: '29C-123.45',
    driverName: 'Nguyễn Văn Toàn',
    capacityKg: 2500,
    maxStops: 8,
    costPerKm: 9500,
    color: '#2563eb',
    available: true,
  },
  {
    id: 'V-02',
    plate: '29C-678.90',
    driverName: 'Trần Minh Khoa',
    capacityKg: 2000,
    maxStops: 7,
    costPerKm: 8800,
    color: '#16a34a',
    available: true,
  },
  {
    id: 'V-03',
    plate: '29D-334.55',
    driverName: 'Lê Thị Hồng',
    capacityKg: 1800,
    maxStops: 6,
    costPerKm: 8200,
    color: '#d946ef',
    available: true,
  },
  {
    id: 'V-04',
    plate: '29E-777.11',
    driverName: 'Phạm Quốc Đạt',
    capacityKg: 1600,
    maxStops: 6,
    costPerKm: 7900,
    color: '#f97316',
    available: true,
  },
  {
    id: 'V-05',
    plate: '29F-202.02',
    driverName: 'Đỗ Hải Nam',
    capacityKg: 1200,
    maxStops: 5,
    costPerKm: 7400,
    color: '#0891b2',
    available: false,
  },
];

@Injectable({ providedIn: 'root' })
export class PlanningMockApi {
  getDepot(): PlanningDepot {
    return { ...DEPOT };
  }

  getOrders(): DeliveryOrder[] {
    return ORDERS.map((o) => ({ ...o }));
  }

  getVehicles(): PlanningVehicle[] {
    return VEHICLES.map((v) => ({ ...v }));
  }
}

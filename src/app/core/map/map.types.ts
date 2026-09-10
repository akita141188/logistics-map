/**
 * Kiểu dữ liệu dùng chung cho toàn bộ tính năng chỉ đường / giám sát lộ trình.
 *
 * QUY ƯỚC THỨ TỰ TOẠ ĐỘ (nguồn gốc của ~80% bug vẽ sai vị trí):
 *  - Viettel Map / GeoJSON / OSRM query : [lng, lat]  -> dùng `LngLatTuple`
 *  - Google Maps / Leaflet              : { lat, lng } -> dùng `LatLng`
 *  - PolylineUtil.decode()              : [lat, lng]  -> dùng `LatLngTuple`
 */

/** [lng, lat] — định dạng Viettel Map / GeoJSON. */
export type LngLatTuple = [number, number];

/** [lat, lng] — định dạng polyline encoded của Google. */
export type LatLngTuple = [number, number];

/** { lat, lng } — định dạng Google Maps / Leaflet. */
export interface LatLng {
  lat: number;
  lng: number;
}

/** Một điểm GPS trong lộ trình THỰC TẾ (log vị trí nhân viên / xe giao hàng). */
export interface RoutePoint extends LatLng {
  createDate?: string;
  createdAt?: string;
  create_date?: string;
  battery?: number | null;
  batteryPercent?: string;
  speedKmh?: number;
  staffTitle?: string;
  deviceId?: string;
  /** Chỉ số gốc trong mảng đầu vào — giữ lại sau khi dedupe/decimate. */
  _originIdx?: number;
  [key: string]: unknown;
}

/** Đầu vào linh hoạt: chấp nhận cả [lng, lat] lẫn object { lat, lng, ... }. */
export type AnyRoutePoint = LngLatTuple | RoutePoint;

/** Một chặng chỉ dẫn rẽ (turn-by-turn). */
export interface RouteStep {
  /** Câu chỉ dẫn đã dựng sẵn tiếng Việt, ví dụ "Rẽ phải vào Trần Duy Hưng". */
  instruction: string;
  /** Tên đường của chặng (có thể rỗng với ngõ/ngách không tên). */
  roadName: string;
  distanceMeters: number;
  durationSeconds: number;
  /** Điểm bắt đầu chặng — dùng để bay tới khi người dùng bấm vào chỉ dẫn. */
  location: LatLng;
  /** Mã maneuver gốc của OSRM (turn / merge / roundabout ...). */
  maneuver: string;
  /** Hướng rẽ: left | right | straight | slight left ... */
  modifier?: string;
}

/**
 * Một CHẶNG giữa hai waypoint liên tiếp mà người gọi đã truyền vào.
 *
 * Phân biệt rõ với `RouteStep`:
 *  - `RouteStep` = một thao tác lái xe ("rẽ phải vào Trần Duy Hưng") — hàng trăm cái.
 *  - `RouteLeg`  = đoạn từ điểm dừng thứ i tới điểm dừng thứ i+1 — đúng bằng
 *    `waypoints.length - 1` cái.
 *
 * VÌ SAO CẦN: để tính giờ dự kiến tới TỪNG điểm giao. Chỉ có tổng quãng đường
 * của cả tuyến thì không trả lời được câu "chèn thêm điểm này vào thì điểm số 5
 * bị đẩy muộn mấy phút".
 */
export interface RouteLeg {
  distanceMeters: number;
  durationSeconds: number;
}

/**
 * NGUỒN ĐỊNH TUYẾN THẬT của một `RouteResult`.
 *
 * VÌ SAO PHẢI CÓ: màn hình từng chỉ hiện "Nguồn: Google Geocoding" — đó là nguồn
 * TÌM ĐỊA CHỈ, không phải nguồn TÌM ĐƯỜNG. Khi có cơ chế dự phòng
 * (Google lỗi -> OSRM) thì người xem không còn cách nào biết con số km/phút
 * trước mắt do ai tính, bằng hồ sơ phương tiện nào. Metadata này để UI nói thật.
 */
export interface RouteSource {
  provider: MapProvider;
  /** Nhãn ngắn cho UI: `Google Routes · Đi bộ`, `OSRM Xe đạp`. */
  label: string;
  /** Phương tiện đã thật sự gửi đi (không phải cái người dùng chọn nếu bị hạ cấp). */
  travelMode: TravelMode;
  /** Endpoint/profile thật đã gọi — để đối chiếu khi nghi ngờ số liệu. */
  profile: string;
  /**
   * `true` khi hồ sơ định tuyến KHÔNG đúng phương tiện người dùng chọn
   * (ví dụ xe máy chạy bằng hồ sơ ô tô vì OSRM công cộng không có profile
   * xe máy). Bắt buộc phải hiện ra UI, không được im lặng.
   */
  degraded?: boolean;
  /**
   * `true` khi nguồn tính km/phút KHÔNG phải nguồn ứng với bản đồ người dùng
   * đang chọn — vì nguồn kia thiếu dữ liệu cho phương tiện này (xem
   * `routing-capability.ts`) hoặc trả về tuyến vòng vô lý.
   *
   * Khác `degraded`: `degraded` = đúng nguồn nhưng sai hồ sơ phương tiện;
   * `switched` = đổi hẳn sang nguồn khác để lấy được số liệu đúng.
   */
  switched?: boolean;
  /** Giải thích ngắn cho `degraded` / `switched`, hoặc ghi chú đã ghép nhiều request. */
  note?: string;
  /**
   * Quãng đường thật / đường chim bay. Con số này để người điều vận tự thấy
   * tuyến có vòng bất thường không — xem `judgeDetour`.
   */
  detourRatio?: number;
  /** Số request đã ghép để giữ đủ waypoint (> 1 nghĩa là tuyến vượt hạn mức). */
  requestCount?: number;
}

/** Kết quả của một lần định tuyến. */
export interface RouteResult {
  /** Hình học đường đi, dạng { lat, lng } để render polyline. */
  path: LatLng[];
  /** Tổng quãng đường — LUÔN LUÔN tính bằng MÉT ở tầng service. */
  distanceMeters: number;
  /** Thời gian dự kiến (giây) nếu provider có trả về. */
  durationSeconds?: number;
  /** Chỉ dẫn rẽ — chỉ có khi gọi với `withSteps: true`. */
  steps?: RouteStep[];
  /** Chặng giữa các waypoint đã truyền vào — dùng để tính ETA từng điểm dừng. */
  legs?: RouteLeg[];
  /** Ai tính ra kết quả này — xem `RouteSource`. */
  source?: RouteSource;
}

/** Ba loại lộ trình của màn Giám sát lộ trình bán hàng. */
export enum RouteType {
  /** MH06 — Lộ trình dự kiến (theo thứ tự ghé thăm của tuyến). */
  Expected = 'expectedRoute',
  /** MH05 — Lộ trình thực tế (GPS track). */
  Real = 'realRoute',
  /** So sánh lộ trình 2 nhân viên. */
  Compare = 'compareRoute',
}

/** Ba nhà cung cấp bản đồ được hỗ trợ. */
export enum MapProvider {
  Viettel = 'VTMAP',
  Google = 'GMAP',
  OpenStreet = 'OSMAP',
}

/** Phương tiện di chuyển — mỗi provider có mã riêng, xem bảng quy đổi ở service. */
export type TravelMode = 'driving' | 'motorbike' | 'walking' | 'cycling';

/** Marker chung cho mọi component bản đồ. */
export interface MapMarker {
  key: string;
  lat: number;
  lng: number;
  /** Nội dung in trong marker (số thứ tự điểm giao, giờ GPS...). */
  label?: string;
  /** Tiêu đề popup. */
  title?: string;
  /** Dòng mô tả thêm trong popup (HTML an toàn do app tự dựng). */
  description?: string;
  color?: string;
  /** Marker to hơn, có viền nhấn — dùng cho điểm đang chọn. */
  active?: boolean;
  /** Hình tròn nhỏ thay vì "pill" — dùng cho breadcrumb GPS. */
  dot?: boolean;
  data?: unknown;
}

/** Một đường cần vẽ lên bản đồ. */
export interface MapPath {
  key: string;
  points: LatLng[];
  color?: string;
  weight?: number;
  opacity?: number;
  /** Nét đứt — dùng cho lộ trình dự kiến ở màn Giám sát giao hàng. */
  dashed?: boolean;
}

/**
 * Vùng tròn vẽ trên bản đồ — dùng cho **geofence** (hàng rào ảo) quanh điểm giao,
 * quanh kho, hoặc vùng phủ của một tuyến bán hàng.
 *
 * VÌ SAO GEOFENCE LÀ THỨ BẮT BUỘC CỦA HỆ GIÁM SÁT VẬN TẢI:
 * Không thể so sánh toạ độ GPS với toạ độ điểm giao bằng dấu bằng — sai số vài
 * chục mét là chuyện thường. Phải định nghĩa "đã tới nơi" bằng một bán kính.
 * Bán kính đó chính là hình tròn này, và nó phải VẼ ĐƯỢC LÊN BẢN ĐỒ để người
 * điều vận tự mắt kiểm chứng "xe có thật sự vào tới cửa hàng không".
 */
export interface MapCircle {
  key: string;
  center: LatLng;
  radiusMeters: number;
  color?: string;
  /** Độ đậm phần tô trong (0..1). */
  fillOpacity?: number;
  dashed?: boolean;
  title?: string;
}

/** Định nghĩa một lớp bản đồ nền. */
export interface BaseLayerDef {
  id: string;
  label: string;
  /** Mô tả ngắn hiện trong bộ chọn lớp. */
  hint: string;
  urlTemplate: string;
  attribution: string;
  maxZoom: number;
  /** Lớp ảnh vệ tinh cần phủ thêm nhãn đường lên trên mới đọc được. */
  overlayUrlTemplate?: string;
  /** Nền tối -> chữ trên marker/điều khiển phải đổi màu theo. */
  dark?: boolean;
}

/**
 * ================= CÁC LỚP BẢN ĐỒ NỀN =================
 *
 * ⚠️ VÌ SAO KHÔNG DÙNG `tile.openstreetmap.org` LÀM MẶC ĐỊNH (dù nó là lựa chọn
 * hiển nhiên nhất):
 *
 * Tên miền này **bị chặn ở nhiều mạng tại Việt Nam** — kiểu chặn ở tầng DNS:
 * tên miền phân giải về `127.0.0.1` nên trình duyệt không đi đâu cả.
 *
 * ⚠️ ĐO LẠI 10/09/2026: `tile.openstreetmap.org` **đã vào được** (DNS trả đúng
 * IP Fastly `151.101.x.91`, tile về 200), trong khi
 * `nominatim.openstreetmap.org` **vẫn** bị ghim `127.0.0.1`. Tức là danh sách
 * chặn thay đổi theo thời điểm và theo từng mạng — đừng tin vào một phép đo cũ,
 * và cũng đừng vì một lần đo thông mà bỏ lớp nền dự phòng.
 *
 * Hậu quả nếu để nguyên: bản đồ ra một khung xám trơn, marker và đường vẫn vẽ
 * đúng nên nhìn như "bản đồ chưa tải xong" chứ không ai đoán ra là bị chặn.
 *
 * Vì vậy mặc định dùng **Carto Voyager** (cũng dựng từ dữ liệu OpenStreetMap,
 * CDN riêng, đã kiểm tra truy cập được), và vẫn giữ lớp OSM gốc trong danh sách
 * để ai ở mạng không bị chặn thì chọn dùng.
 *
 * Tất cả các lớp dưới đây đều **miễn phí và không cần API key**.
 */
export const BASE_LAYERS: readonly BaseLayerDef[] = [
  {
    id: 'voyager',
    label: 'Đường phố',
    hint: 'Carto Voyager — dữ liệu OSM, nhiều nhãn đường, dễ đọc nhất',
    urlTemplate: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    maxZoom: 20,
  },
  {
    id: 'positron',
    label: 'Nền sáng',
    hint: 'Carto Positron — nền nhạt, làm nổi bật đường vẽ và marker',
    urlTemplate: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    maxZoom: 20,
  },
  {
    id: 'dark',
    label: 'Nền tối',
    hint: 'Carto Dark Matter — hợp với màn hình điều hành treo tường',
    urlTemplate: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    maxZoom: 20,
    dark: true,
  },
  {
    id: 'satellite',
    label: 'Vệ tinh',
    hint: 'Esri World Imagery + nhãn đường phủ trên — kiểm tra cổng/kho thực địa',
    urlTemplate:
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    overlayUrlTemplate:
      'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics',
    maxZoom: 19,
    dark: true,
  },
  {
    id: 'osm',
    label: 'OSM gốc',
    hint: '⚠️ tile.openstreetmap.org bị chặn ở một số mạng VN — chọn nếu mạng bạn vào được',
    urlTemplate: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  },
  {
    id: 'topo',
    label: 'Địa hình',
    hint: 'OpenTopoMap — đường đồng mức, dùng khi giao hàng vùng núi',
    urlTemplate: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors, SRTM &copy; OpenTopoMap (CC-BY-SA)',
    maxZoom: 17,
  },
];

export const DEFAULT_BASE_LAYER_ID = 'voyager';

/** Màu đường mặc định, đồng bộ với `ROUTE_LINE_COLOR` bên Vue. */
export const ROUTE_LINE_COLOR = '#020202';

/** Bảng màu dùng chung cho demo. */
export const MAP_COLORS = {
  expected: '#7c3aed',
  real: '#0ea5e9',
  deviation: '#ef4444',
  done: '#16a34a',
  pending: '#94a3b8',
  late: '#f59e0b',
} as const;

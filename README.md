# DMS Map Demo — Bản đồ vận tải: lập kế hoạch, điều hành, dẫn đường, giám sát

Ứng dụng **Angular 21** (standalone, zoneless, signals) dựng lại đủ vòng đời một ngày làm
việc của đơn vị vận chuyển, tất cả trên bản đồ thật:

```
đơn hàng  ──▶  lập kế hoạch & phân xe  ──▶  dẫn đường tài xế  ──▶  điều hành đội xe
 (/planning: ma trận + CVRP)              (/navigate: turn-by-turn)   (/fleet: cả đội)
                                                      │
                                                      ▼
                                  giám sát & điều phối đơn phát sinh (/delivery)
```

Tài liệu phân tích chi tiết nằm ở `../docs/`:

- `../docs/map-routing.md` — mô tả tính năng chỉ đường trong codebase Vue gốc (13 mục,
  kèm trích dẫn code thật, bảng so sánh 3 nhà cung cấp và checklist 9 cái bẫy).
- `../docs/map-routing-angular/` — bản port sang Angular kèm chú thích cho từng file.

---

## 1. Chạy thử

```bash
npm install
npm start          # http://localhost:4200
```

**Không cần API key.** Mặc định app dùng OpenStreetMap (Leaflet) + OSRM + Nominatim —
đều là dịch vụ công cộng miễn phí. Google Maps và Viettel Map có sẵn trong code, chỉ cần
nạp key (mục 5) rồi chọn lại ở góc phải thanh trên.

Chạy với key thật của dự án DMS:

```bash
npm run sync:env     # đọc .env của dms.webapp -> sinh public/map-keys.json
npm start            # vẫn lệnh cũ, app tự nhận key, mở thẳng Google Maps
```

```bash
npm run build        # build production (KHÔNG kèm key)
npm test             # vitest — 180 test / 16 file, phủ cả lõi tính toán lẫn ranh giới giữa các tầng
```

Mở app vào thẳng `/fleet`. Muốn xem phần "giống app dẫn đường nhất" thì vào `/navigate`,
bấm **▶ Chạy**, rồi bấm **🧪 Giả lập đi sai đường** để xem hệ thống tự phát hiện và tính
lại đường.

---

## 2. Năm màn hình

| Màn | Đường dẫn | Người dùng | Câu hỏi nó trả lời |
|---|---|---|---|
| Điều hành đội xe | `/fleet` | Trực phòng điều độ | Cả đội đang ở đâu, ai đang có vấn đề? |
| Lập kế hoạch & phân xe | `/planning` | Điều phối viên đầu ngày | Chia 30 đơn cho 4 xe thế nào cho rẻ nhất? |
| Dẫn đường tài xế | `/navigate` | Tài xế trong cabin | Giờ tôi rẽ đâu, bao giờ tới nơi? |
| Giám sát lộ trình | `/delivery` | Điều phối viên trong ca | Xe đi đúng tuyến không, nhận thêm đơn có kịp? |
| Chỉ đường | `/directions` | Ai cũng dùng | Đi từ A qua B, C tới D hết bao xa? |

### 2.1 Điều hành đội xe — `/fleet`

| Chức năng | Ghi chú kỹ thuật |
|---|---|
| Xem cả đội trên một bản đồ | Nhiều marker xe cùng lúc (`vehicles` input của `dms-map-surface`) |
| **Đồng hồ chung cho cả đội** | Vị trí mỗi xe được **nội suy theo mốc thời gian**, không lấy theo chỉ số mảng GPS — ba xe có nhịp lấy mẫu khác nhau, lấy theo chỉ số là dựng ra một hiện thực không tồn tại |
| Tua nhanh 1× → 60× | 1 giây thật = 1…60 phút mô phỏng |
| KPI toàn đội | Tỉ lệ giao đúng hạn, km, tiền đã thu, số cảnh báo nặng |
| Dòng cảnh báo xếp theo mức độ | `alerts.util.ts` — quá tốc độ, dừng đỗ bất thường, lệch tuyến, trễ lịch, mất tín hiệu |
| Bấm cảnh báo → mở đúng chuyến | Điều hướng sang `/delivery?trip=...` |

### 2.2 Lập kế hoạch & phân xe — `/planning`

Bài toán **CVRP** (vehicle routing có ràng buộc tải trọng) giải ngay trong trình duyệt:

| Bước | Việc | Chi phí |
|---|---|---|
| 1. Ma trận | `OsrmMatrixService` (`/table`) — quãng đường **thật theo đường**, không phải chim bay | 1 request, chậm nhất |
| 2. Chia tuyến | Clarke-Wright savings + 2-opt (`vrp.util.ts`) | vài mili-giây, thuần CPU |
| 3. Vẽ đường | Định tuyến từng xe để lấy hình học bám phố | mỗi xe 1 request |

Tách ba bước là có chủ ý: kéo một đơn từ xe này sang xe kia chỉ chạy lại **bước 2**, nên
thao tác điều phối phản hồi tức thì thay vì chờ mạng vài giây mỗi lần.

Ràng buộc **cứng** của solver: tải trọng xe và giới hạn số điểm/xe. Thời gian đứng giao mỗi
điểm được đưa vào để tính giờ dự kiến.

Khung giờ nhận hàng của khách là **hậu kiểm, không phải ràng buộc của solver**: `solveCvrp`
chỉ so quãng đường khi gộp/đảo tuyến, xong xuôi rồi `PlanningStore` mới dóng giờ dự kiến với
`windowFrom/windowTo` để đánh dấu vi phạm. Làm VRPTW thật cần mô hình khác hẳn (kiểm tra khả
thi theo travel time + service time ở mọi bước, cộng khái niệm chờ sớm) — xem chú thích ở
`VrpStop` trong `core/map/vrp.util.ts`.

Kéo tay một đơn sang xe khác cũng phải qua đúng hai ràng buộc cứng đó: vượt tải hoặc vượt số
điểm thì thao tác bị **từ chối kèm lý do**, và kế hoạch không bị sửa dở dang.

### 2.3 Dẫn đường tài xế — `/navigate`

Bốn màn kia nhìn từ **văn phòng**. Màn này nhìn từ **cabin**, và nó là thứ phân biệt một
demo bản đồ với một sản phẩm vận tải: chỉ dẫn phải chạy theo vị trí thực, không phải một
danh sách tĩnh.

| Chức năng | Ghi chú kỹ thuật |
|---|---|
| **Băng chỉ dẫn rẽ theo vị trí** | `guidanceAt()` — hiện thao tác sắp phải làm + số mét còn lại, đổi màu khi còn < 150 m |
| **Vị trí bám tim đường** | GPS thô luôn lệch vài mét; mọi thứ hiển thị đều dùng hình chiếu vuông góc (`projectOnPath`). Chấm cam trên bản đồ là toạ độ thô, để nhìn thấy phần sai số đã bị nắn |
| **Tự phát hiện đi sai đường** | Trễ Schmitt + đếm 3 bản ghi liên tiếp (`updateOffRoute`) — một fix nhiễu không được phép làm cả tuyến nhảy |
| **Tự định tuyến lại** | Tuyến mới đi từ chỗ xe đang đứng qua các điểm **chưa giao** rồi về kho, không chạy lại từ đầu |
| **Tự nhận biết đã tới nơi** | Vào bán kính 45 m **hoặc** đã đi quá mốc chặng — xe dừng lại chờ tài xế xác nhận giao |
| ETA điểm kế tiếp / giờ về kho | `etaSeconds()` — ưu tiên tốc độ thực đo, cộng thời gian đứng giao từng điểm |
| Nút "giả lập đi sai đường" | Bơm độ lệch ngang tăng dần để xem toàn bộ chuỗi phát hiện → cảnh báo → định tuyến lại chạy thật |
| Bàn giao sang điện thoại | Deep-link Google Maps cho phần đường còn lại |

**Vì sao mục tiêu kế tiếp là `signal` chứ không phải `computed` từ quãng đường đã đi.**
Suy ra mục tiêu bằng `activeLegIndex(boundaries, along)` thì nó tự nhảy sang điểm sau ngay
khi xe đi quá mốc — kể cả khi chưa ai xác nhận giao xong. Ở tốc độ tua 16× (mỗi nhịp đi
160 m, dài hơn bán kính geofence 45 m) hệ quả là **xe lướt qua cửa hàng mà màn hình không
hề dừng lại**. Đây đúng là lỗi hay gặp ở hệ thống thật: thiết bị gửi vị trí 60 giây/lần,
xe chạy 50 km/h thì hai bản ghi cách nhau 830 m, mọi logic "đã tới nơi" dựa trên khoảng
cách tức thời đều trượt. Nên mục tiêu chỉ được tiến **một bước**, do `checkArrival()` quyết định.

**Một cái bẫy nữa đã xử lý:** `resource` xoá `value()` về `undefined` ngay khi bắt đầu tải
lần mới. Trong lúc chờ định tuyến lại, `routePath()` rỗng → vị trí xe rơi về `{0,0}` (giữa
Đại Tây Dương) và marker biến mất. Store giữ lại tuyến cũ (`_lastRoute`) làm nền để xe
đứng yên chờ tuyến mới — đúng hành vi của mọi thiết bị dẫn đường.

Toàn bộ phần lõi nằm ở `core/map/navigation.util.ts`, **thuần tuý và có 21 unit test**
(`navigation.spec.ts`): chiếu vị trí, chỉ dẫn theo quãng đường, mốc chặng, ETA, phát hiện
lệch tuyến. Bộ phát GPS giả lập nằm riêng trong store — thay bằng WebSocket thật thì không
phải sửa dòng nào ở phần còn lại.

### 2.4 Chỉ đường — `/directions`

| Chức năng | Ghi chú kỹ thuật |
|---|---|
| Tìm địa chỉ | Nominatim, debounce 400 ms, chỉ gọi từ 3 ký tự (`nominatim-geocode.service.ts`) |
| Bấm bản đồ để thêm điểm | Toạ độ hiện ngay, địa chỉ reverse-geocode vá vào sau — không bắt người dùng chờ mạng |
| Sắp xếp / đảo chiều / xoá điểm | Thao tác trên signal `_waypoints` |
| **Tối ưu thứ tự điểm** | Nearest-Neighbour + 2-opt tự cài (`route-optimizer.util.ts`), giữ nguyên điểm đầu/cuối |
| Đổi phương tiện | Ô tô / xe máy / xe đạp / đi bộ — mỗi phương tiện trỏ sang một instance OSRM khác nhau |
| Tổng km, thời gian, ETA | Lấy từ `distance`/`duration` của dịch vụ định tuyến |
| **Chỉ dẫn rẽ từng chặng** | OSRM chỉ trả mã maneuver; câu tiếng Việt do `OsrmRoutingService.describe()` tự dựng |
| Bấm chỉ dẫn → bay tới ngã rẽ | Qua input `focus` (khai báo), không dùng `viewChild` + gọi method |
| Dẫn đường thật | Deep-link Google Maps URLs API (`googleMapsDirectionUrl`) |

### 2.5 Giám sát lộ trình giao hàng — `/delivery`

| Chức năng | Ghi chú kỹ thuật |
|---|---|
| Chọn chuyến (3 chuyến mock: HN / HCM / ĐN) | `DeliveryMockApi` |
| **Lộ trình dự kiến** (tím, nét đứt) | Định tuyến qua `kho → các điểm theo seq → quay lại kho` (khép vòng) |
| **Lộ trình thực tế** (xanh, nét liền) | GPS track, cộng quãng đường trực tiếp từ track — không định tuyến lại |
| **Cảnh báo lệch tuyến** (đỏ) | Khoảng cách vuông góc điểm→polyline (`distanceToSegmentMeters`), ngưỡng 120 m |
| Bảng điểm giao | Giờ kế hoạch vs thực tế, số phút trễ, trạng thái, ghi chú |
| KPI | Đã giao / thất bại / tới trễ / km dự kiến / km thực tế / chênh lệch / tiền đã thu |
| **Tua lại hành trình** | Thanh slider + play/pause + tốc độ 1×…16×, xe chạy mượt bằng `setLatLng` + CSS transition |
| Bật/tắt lớp hiển thị | Lộ trình dự kiến, lộ trình thực tế, **chặng còn lại**, điểm GPS |
| Chỉ đường phần còn lại | Deep-link Google Maps cho các điểm chưa giao |
| **Chèn điểm giao phát sinh** | Xem mục 2.3 |

> GPS track trong demo **không phải toạ độ bịa**: nó được sinh ra từ chính lộ trình định
> tuyến thật (bám đường phố), rồi cộng nhiễu ±11 m và chèn một đoạn đi vòng để phần cảnh
> báo lệch tuyến có dữ liệu thật mà chạy. Nhiễu dùng hàm giả-ngẫu-nhiên tất định nên F5
> lại vẫn ra đúng một đường — không phải mỗi lần một kiểu.

### 2.6 Điều phối đơn phát sinh — chèn điểm giao vào chuyến đang chạy

Đây là phần biến màn hình từ "xem báo cáo" thành "công cụ điều phối": giữa ca, khách gọi
thêm một đơn, điều phối viên cần biết **nhét vào tuyến đang chạy có kịp không**.

| Thao tác | Hệ quả tự động |
|---|---|
| Tìm địa chỉ hoặc bấm bản đồ chọn vị trí | Marker hồng `＋` + đường nối tạm cho thấy điểm mới "kéo" tuyến đi đâu |
| Xem trước trước khi chèn | Số km đội thêm (đường chim bay, **không gọi mạng** — người dùng đang gõ dở) |
| Chèn vào tuyến | Định tuyến lại toàn tuyến, vẽ lại, tính lại KPI, tính lại ETA mọi điểm phía sau |
| Đổi thứ tự / gỡ điểm | Như trên |
| **Tối ưu chặng còn lại** | 2-opt trên **các điểm chưa giao**, neo đầu là vị trí xe hiện tại, neo cuối là kho |
| Bảng tác động | Đường/thời gian đội thêm so với **kế hoạch gốc**, số điểm bị đẩy lịch, đẩy nhiều nhất mấy phút, giờ về kho mới |

**Ba ràng buộc nghiệp vụ được cài cứng** (có unit test chốt lại, xem
`delivery-monitor.store.spec.ts`):

1. **Không đụng vào quá khứ.** Điểm đã có `actualArrival` bị khoá: không xoá, không đổi
   thứ tự, không chèn điểm mới lên trước. Ép `position: 0` cũng bị chặn về `lockedCount`.
2. **GPS track không bao giờ bị sinh lại.** Sửa kế hoạch không làm thay đổi lịch sử đã chạy.
3. **`plannedArrival` gốc được giữ nguyên** để còn đối chiếu "trễ hơn kế hoạch bao nhiêu".
   Điểm phát sinh có `plannedArrival: ''` chứ **không bịa** một giờ kế hoạch giả — nếu bịa
   thì cột "trễ/sớm" của nó sẽ ra số vô nghĩa.

**Cách tính ETA.** `RouteResult` được bổ sung `legs[]` (quãng đường/thời gian **từng chặng**
giữa hai điểm dừng liên tiếp — khác `steps[]` là từng thao tác lái xe). ETA của điểm thứ *k*
= giờ GPS mới nhất + tổng `legs[0..k]` + *k* × 10 phút đứng giao. Bên OSRM `legs` có sẵn;
bên Google phải xin thêm `routes.legs.distanceMeters` + `routes.legs.duration` trong
`X-Goog-FieldMask` (hai field này thuộc nhóm Basic, không đội giá lên bậc Advanced).

**Chỗ dễ sai đã xử lý:** chặng còn lại được tính từ **điểm GPS mới nhất**, không phải từ
`currentPoint()` của thanh tua. Nếu lấy theo thanh tua thì mỗi tick 220 ms là một request
định tuyến, vừa spam server vừa làm ETA nhảy loạn khi người dùng kéo slider.

**Một hệ quả có chủ ý, dễ bị tưởng là bug:** chèn thêm điểm làm lộ trình dự kiến đổi, nên
phần GPS **đã đi** có thể đột nhiên bị tính là lệch tuyến — vì "chuẩn" để so đã đổi. Đúng
bản chất, và màn hình có ghi chú nhắc ngay dưới cảnh báo. Muốn chấm điểm tài xế thì phải
chấm theo kế hoạch **tại thời điểm xe chạy**, không phải kế hoạch sau khi điều phối sửa.

#### Toàn bộ cơ chế nằm ở một signal

```ts
// delivery-monitor.store.ts
private readonly _stopsOverride = signal<DeliveryStop[] | null>(null);

readonly trip = computed(() => {
  const base = this.originalTrip();          // kế hoạch gốc, không bao giờ bị sửa
  const override = this._stopsOverride();
  return override ? { ...base, stops: override } : base;
});
```

`addStop()` chỉ `set` đúng signal đó. Không có một dòng nào gọi "vẽ lại bản đồ", "tính lại
KPI" hay "cập nhật cảnh báo" — cả chuỗi
`tuyến → đường vẽ → độ lệch → KPI → ETA → cảnh báo → link Google Maps` đều là
`computed`/`resource` treo trên nó nên tự chạy lại theo đúng thứ tự phụ thuộc.
`resetPlan()` = `set(null)`.

---

## 3. Cấu trúc thư mục

```
src/app/
├─ core/map/                       ← thư viện bản đồ, không biết gì về nghiệp vụ
│  ├─ map.types.ts                 kiểu dùng chung + quy ước thứ tự toạ độ
│  ├─ map-routing.config.ts        provideMapRouting() — key, endpoint, ngưỡng
│  ├─ map-provider.service.ts      chọn VTMAP / GMAP / OSMAP
│  ├─ map-surface.component.ts     "mặt bàn vẽ" — @switch theo provider
│  ├─ routing.facade.ts            cửa duy nhất để lấy đường đi
│  ├─ geo.util.ts                  haversine, dedupe, decimate, lệch tuyến, format
│  ├─ navigation.util.ts           LÕI DẪN ĐƯỜNG: chiếu vị trí, chỉ dẫn theo quãng đường,
│  │                               mốc chặng, ETA, phát hiện đi sai đường  (thuần tuý)
│  ├─ gps-quality.util.ts          lọc nhiễu GPS: nhảy cóc, rung khi đứng, đứt track
│  ├─ polyline.util.ts             Google Encoded Polyline (encode/decode)
│  ├─ route-optimizer.util.ts      TSP: nearest-neighbour + 2-opt
│  ├─ vrp.util.ts                  CVRP: Clarke-Wright savings + 2-opt (có ràng buộc tải)
│  ├─ expected-route.util.ts       dựng lộ trình dự kiến từ danh sách khách hàng
│  ├─ route-state.store.ts         state màn Giám sát lộ trình bán hàng (MH05/MH06)
│  ├─ osm/                         Leaflet + OSRM (route/table/nearest/match)
│  │                               + Nominatim/Photon   ← mặc định, không cần key
│  ├─ google/                      @angular/google-maps + Routes API v2
│  └─ viettel/                     vtmap-gl + RoadDrawerControl
└─ features/
   ├─ fleet/                       màn Điều hành đội xe
   ├─ planning/                    màn Lập kế hoạch & phân xe (CVRP)
   ├─ navigate/                    màn Dẫn đường tài xế
   ├─ directions/                  màn Chỉ đường
   └─ delivery/                    màn Giám sát lộ trình + cảnh báo (alerts.util.ts)
```

---

## 4. Ba nhà cung cấp bản đồ

| | OpenStreetMap | Google Maps | Viettel Map |
|---|---|---|---|
| Thư viện bản đồ | `leaflet` | `@angular/google-maps` | `vtmap-gl.js` (CDN, không có trên npm) |
| Dịch vụ định tuyến | OSRM `/route/v1` | Routes API v2 `computeRoutes` | `RoadDrawerControl` |
| API key | **không cần** | cần (Maps JS + Routes API) | cần access token |
| Chỉ dẫn rẽ | có (tự dịch sang tiếng Việt) | có (Google dịch sẵn) | **không** |
| Thứ tự toạ độ | `[lat, lng]` | `{ lat, lng }` | `[lng, lat]` |
| Kết quả định tuyến trả về | JSON | JSON | **ghi text vào DOM** |
| Ma trận khoảng cách | OSRM `/table` | `computeRouteMatrix` | — (mượn một trong hai) |
| Geofence vẽ trên bản đồ | `L.circle` | `<map-circle>` | chưa hỗ trợ |

### ⚠️ Khả năng truy cập các dịch vụ nguồn mở — ĐO LẠI 10/09/2026

> **Đính chính bảng đo cũ.** Bản README trước ghi rằng gần như mọi endpoint OSM đều bị
> chặn. **Đo lại thì sai.** Chỉ còn đúng một dịch vụ bị chặn. Kết luận sai đó đã kéo theo
> một kết luận sai nữa ("xe đạp không có tuyến là giới hạn không vá được"), nên để nguyên
> đây làm bài học: **luôn đo lại trước khi viện dẫn một phép đo cũ.**

| Dịch vụ | Kết quả (10/09) | Ghi chú |
|---|---|---|
| `router.project-osrm.org` | ✅ 200 | định tuyến / ma trận / khớp đường, hồ sơ **ô tô** |
| `routing.openstreetmap.de` (`routed-foot`, `routed-bike`, `routed-car`) | ✅ 200 | **nguồn chính cho đi bộ & xe đạp** |
| `valhalla1.openstreetmap.de` | ✅ 200 | chưa dùng |
| `photon.komoot.io` | ✅ 200 | geocode dự phòng |
| `tile.openstreetmap.org` | ✅ 200 | DNS trả IP Fastly thật, không còn bị ghim `127.0.0.1` như lần đo trước |
| `basemaps.cartocdn.com` | ✅ 200 | nền bản đồ mặc định |
| `maps.googleapis.com`, `routes.googleapis.com`, `maps.viettel.vn` | ✅ 200 | |
| `nominatim.openstreetmap.org` | ❌ **bị chặn** | DNS phân giải về `127.0.0.1` — chặn có chủ đích, không phải sự cố mạng |

Chỉ Nominatim bị chặn, và đã có `PhotonGeocodeService` gánh — nên phần tra địa chỉ vẫn chạy.

### Kết quả định tuyến THẬT của 4 phương tiện (đo 10/09/2026)

Cùng 3 điểm dựng sẵn của `/directions`: Kho Long Biên → Siêu thị mini Bà Triệu → Đại lý Cầu Giấy
(**đường chim bay cộng dồn = 10.352 m**).

| Phương tiện | TRƯỚC — nguồn cũ | SAU — nguồn hiện tại | Hệ số vòng |
|---|---|---|---|
| Ô tô | Google `DRIVE` + `TRAFFIC_AWARE` → **19.103 m** / 55 phút | Google `DRIVE` + `TRAFFIC_UNAWARE` → **15.108 m** / 46 phút | 1,46× |
| Xe máy | Google `TWO_WHEELER` → 14.501 m | *(giữ nguyên)* **14.501 m** / 45 phút | 1,40× |
| Xe đạp | Google `BICYCLE` → **`routes: []`**, màn hình báo lỗi | OSRM `routed-bike` → **13.510 m** / 58 phút | 1,31× |
| Đi bộ | Google `WALK` → **30.033 m / 6 giờ 52 phút** | OSRM `routed-foot` → **13.616 m** / 3 giờ 2 phút | 1,32× |

#### Vì sao tuyến đi bộ của Google dài gấp 2,2 lần — và vì sao nó KHÔNG phải kết quả đúng

Bản README trước kết luận *"đi bộ 30 km là kết quả ĐÚNG"*. **Kết luận đó sai**, và sai vì
dừng lại ở mức tổng quãng đường mà không đọc từng bước đi. Xin thêm `routes.legs.steps` rồi
đọc thì thấy ngay: trên chặng Ngọc Lâm → Bà Triệu, Google cho người đi bộ **đi 9.210 m dọc
ĐT378 rồi QUA PHÀ Kim Lan - Lĩnh Nam**.

Đối chiếu trên cùng một chặng:

| Nguồn | Quãng đường | Vượt sông bằng |
|---|---|---|
| Google Routes v2 `WALK` | 21.741 m | phà Kim Lan - Lĩnh Nam |
| Google Directions API (bản cũ) | 21.742 m | y hệt — nên không phải lỗi tham số |
| OSRM `routed-foot` | **6.573 m** | **cầu Long Biên (1.850 m)** |
| OSRM `routed-bike` | 6.748 m | cầu Long Biên |

Đã thử mọi cách vá bằng tham số, đều không được:

- `routeModifiers.avoidFerries` → API từ chối thẳng: *"avoid_ferries only applies to DRIVE and
  TWO_WHEELER travel modes."*
- Ép một waypoint lên giữa cầu Long Biên → tuyến **dài thêm** thành 28.713 m: Google đi tới
  chân cầu rồi vòng ngược xuống phà.
- Ép qua cầu Chương Dương → 23.347 m, cũng vòng lại.

Nghĩa là **đồ thị đi bộ của Google không có lối vượt sông Hồng nào ở nội thành Hà Nội**.
Cầu Chương Dương cấm người đi bộ là đúng thực tế, nhưng cầu Long Biên — nơi người đi bộ và xe
đạp vẫn qua hằng ngày — cũng không có trong đồ thị đó. Đây là **khoảng trống dữ liệu**, và
cách sửa đúng là **đổi nguồn theo phương tiện**, không phải đổi tham số.

#### Bật "tính theo tình trạng giao thông" đổi cả ĐƯỜNG ĐI, không chỉ số phút

Đo trên chặng Ngọc Lâm → Bà Triệu:

| `routingPreference` | Quãng đường | Đường đi |
|---|---|---|
| `TRAFFIC_UNAWARE` | **6.792 m** | qua **cầu Chương Dương** — đường ai cũng đi |
| `TRAFFIC_AWARE` | **10.787 m** (**+59%**) | né Chương Dương, vòng cầu khác |

Trước đây code luôn gửi `TRAFFIC_AWARE`, nên tuyến ô tô âm thầm dài hơn thực tế mà không ai
biết vì sao. Giờ mặc định là `TRAFFIC_UNAWARE` (màn lập kế hoạch / báo cáo cần quãng đường ổn
định, gọi lại lúc khác vẫn ra cùng số), `/directions` có công tắc để tự bật và tự so, còn
`/navigate` thì bật sẵn — ở đó tài xế đang chạy thật, né tắc mới là điều mong muốn.

**Hệ quả thiết kế, không phải sự cố tạm thời:** mọi tính năng cốt lõi phải có ít nhất hai
nguồn, và phải **rơi tầng minh bạch** — âm thầm về chức năng nhưng hiển thị rõ nó đang
dùng nguồn nào:

- Định tuyến (`RoutingFacade.requestRoutes`) — **ba tầng, theo đúng thứ tự**:

  1. **Ép nguồn theo phương tiện** (`routing-capability.ts`). Đi bộ và xe đạp **luôn** đi
     thẳng sang OSRM `routed-foot` / `routed-bike`, kể cả khi người dùng đang chọn bản đồ
     Google — vì Google không có dữ liệu đi bộ vượt sông Hồng và không phục vụ xe đạp ở
     Việt Nam. Kết quả gắn cờ `switched` + nêu lý do ngay trên màn hình.
     *Tầng này tồn tại vì tầng 2 hoàn toàn bất lực trước lỗi im lặng: Google trả HTTP 200
     kèm một tuyến trông hợp lệ, chẳng có gì để mà "dự phòng" cả.*
  2. **Dự phòng khi hỏng** — Google ném lỗi thì thử lại bằng OSRM, nhãn `… (dự phòng cho
     Google)`. **Không có chiều ngược lại**: đang chọn OSM mà tự nhảy sang Google là tiêu
     quota của người dùng ngoài ý muốn. Cả hai cùng hỏng thì ném lỗi kể đủ hai vế,
     **không bao giờ rơi xuống đường chim bay rồi vẽ như đường thật**.
  3. **Đối chiếu khi số liệu đáng ngờ** — tuyến dài hơn 3 lần đường chim bay thì gọi nguồn
     còn lại và giữ tuyến ngắn hơn. Đây là lưới cuối cho những khoảng trống dữ liệu *chưa*
     ai biết. Hệ số vòng luôn được hiện ra màn hình — chính con số này là thứ đã thiếu khi
     `/directions` báo "21,7 km" mà không ai nghi ngờ gì.
     ⚠️ Lưới này **không** bắt được ca đi bộ nói trên khi tuyến có 3 điểm (30.033/10.352 =
     2,90 — lọt ngưỡng trong gang tấc, vì phần đường vòng sai bị pha loãng). Đã khoá sự thật
     đó lại bằng một test riêng, để không ai gỡ tầng 1 với lý do "đã có tầng 3".
- Ma trận: `GoogleMatrixService` ↔ `OsrmMatrixService`, cả hai cùng rơi về Haversine × 1.4
  và **đánh dấu `real: false`** để màn lập kế hoạch ghi chú "đang dùng ước lượng".
- Tra địa chỉ: Google → Nominatim → Photon, ô tìm kiếm luôn hiện tên dịch vụ vừa trả kết quả.
- Bám đường / khớp đường (`/nearest`, `/match`): **chỉ OSRM có**. Google Roads API là sản
  phẩm tính tiền riêng nên không bật; mất mạng OSRM thì các nút này báo lỗi rõ ràng chứ
  không im lặng trả dữ liệu kém chính xác.

Vì máy này có key Google trong `public/map-keys.json` nên app **mặc định mở bằng Google** —
đó cũng là cấu hình duy nhất chạy đủ tính năng ở mạng trên.

### Vì sao nhánh Viettel phức tạp bất thường

`RoadDrawerControl.setPoints()` là API *fire-and-forget*: không Promise, không callback,
không event. Cách **duy nhất** biết định tuyến đã xong là quan sát phần tử DOM
`#road-draw-total-distance` mà SDK ghi kết quả vào. Vì thế `ViettelRouteService` phải dùng
`MutationObserver` + debounce 150 ms + safety timeout 5 s. Đó không phải code thừa — xoá
đi là treo UI. Chi tiết xem chú thích trong `core/map/viettel/viettel-route.service.ts`.

Hệ quả: khi chọn Viettel Map, số liệu km/phút/chỉ dẫn rẽ mà màn hình cần vẫn lấy từ OSRM
(xem chú thích trong `routing.facade.ts`), còn phần đường vẽ trên bản đồ do chính
`RoadDrawerControl` đảm nhiệm.

---

## 5. Cấu hình API key

Key **không nằm trong code** và **không nhúng lúc build** — app fetch lúc chạy:

```
public/
├─ map-keys.example.json   bản mẫu — commit được
└─ map-keys.json           KEY THẬT — đã .gitignore, app đọc file này
```

`main.ts` gọi `loadMapRuntimeKeys()` (`core/map/runtime-keys.ts`) để `GET map-keys.json`
trước khi `bootstrapApplication`. Không có file → HTTP 404 → key rỗng → chạy OpenStreetMap.
404 là trạng thái hợp lệ, hàm này **không bao giờ reject**.

Hệ quả: `npm start` luôn đúng, **không cần cờ `--configuration` nào**; đổi key chỉ cần F5,
không build lại; lên production thì mount/ghi đè đúng file JSON đó.

Cách 1 — lấy key từ dự án DMS gốc:

```bash
npm run sync:env
# hoặc trỏ file khác:
powershell -File ./scripts/sync-env.ps1 -EnvFile ../../dms.webapp/.env.production
```

Script đọc `VITE_GG_ID` (Google) và `VITE_VTMAP_KEY` (Viettel) rồi sinh `public/map-keys.json`.
Nó **không in giá trị key ra terminal** (chỉ in độ dài) để không lưu vào lịch sử shell.

Cách 2 — điền tay: copy `map-keys.example.json` → `map-keys.json`.

`app.config.ts` chọn provider mặc định theo key có sẵn: có `googleMapsKey` thì mở thẳng
Google (giống dự án DMS gốc), không có thì rơi về OpenStreetMap.

> **Vì sao bỏ `environment.ts` + `fileReplacements`?** Cách đó bắt phải nhớ chạy
> `npm run start:local`; quên cờ là app im lặng chạy với key rỗng và hiện
> "Chưa cấu hình API key" — nhìn y hệt lỗi thật. Một cấu hình chỉ đúng khi gõ thêm
> tham số là một cái bẫy, nên đã gỡ hẳn.

`npm run build` (production) **ignore `map-keys.json`** trong `angular.json` → key dev
không bao giờ lọt vào bundle deploy. Đã kiểm chứng: 0 file JS trong `dist/` chứa key.

> ⚠️ Key Google dùng ở trình duyệt **luôn lộ trong bundle JS**, không cách nào giấu.
> Bảo vệ duy nhất là ràng buộc trong Cloud Console: HTTP referrer + giới hạn đúng
> "Maps JavaScript API" / "Routes API" + đặt quota. Key hiện tại của dự án DMS **chưa
> có ràng buộc nào** — gọi được từ bất kỳ domain nào, kể cả không có `Referer`.
> Nên tạo key riêng cho demo thay vì dùng lại key production.

Endpoint OSRM vẫn khai báo ở `app.config.ts`:

```ts
provideMapRouting({
  googleMapsKey: keys.googleMapsKey,
  vtmapKey: keys.vtmapKey,
  // Production: KHÔNG dùng server OSRM demo công cộng
  osrmBaseUrl: 'https://osrm.cong-ty-cua-ban.vn/route/v1',
})
```

Self-host OSRM cho bản đồ Việt Nam:

```bash
wget https://download.geofabrik.de/asia/vietnam-latest.osm.pbf
docker run -t -v "${PWD}:/data" osrm/osrm-backend \
  osrm-extract -p /opt/car.lua /data/vietnam-latest.osm.pbf
docker run -t -v "${PWD}:/data" osrm/osrm-backend osrm-partition /data/vietnam-latest.osrm
docker run -t -v "${PWD}:/data" osrm/osrm-backend osrm-customize /data/vietnam-latest.osrm
docker run -t -i -p 5000:5000 -v "${PWD}:/data" osrm/osrm-backend \
  osrm-routed --algorithm mld /data/vietnam-latest.osrm
```

---

## 6. Mười chín cái bẫy đã được xử lý sẵn trong code

1. **Thứ tự toạ độ** — Leaflet `[lat,lng]`, GeoJSON/OSRM `[lng,lat]`, Google `{lat,lng}`.
   Mỗi kiểu có một type riêng trong `map.types.ts` để trình biên dịch bắt lỗi hộ.
2. **Đơn vị** — mọi service trả **mét**; chỉ đổi sang km ở tầng hiển thị (`formatDistance`).
3. **HTTP 414 URI Too Long** — OSRM nhận toạ độ qua query string nên không gửi được vô hạn
   điểm. Nhưng **cách xử lý phải khác nhau tuỳ loại điểm**: hình học GPS dày thì lấy mẫu thưa
   (`decimatePoints`, ngưỡng `maxPointsForDrawer`), còn **điểm dừng nghiệp vụ thì tuyệt đối
   không được bỏ** — vượt `maxWaypointsPerRequest` thì `RoutingFacade` cắt thành nhiều request
   chồng mép rồi khâu lại. Lẫn hai thứ này là âm thầm xoá khách hàng khỏi tuyến mà bản đồ vẫn
   vẽ ra một đường hoàn toàn bình thường.
4. **Nominatim rate-limit 1 req/s** — debounce 400 ms + tối thiểu 3 ký tự.
5. **`X-Goog-FieldMask` bắt buộc** — thiếu field trong mask thì response im lặng thiếu dữ
   liệu, không báo lỗi. Và mask càng nhiều field thì càng đắt tiền.
6. **Google không có `strokeDashArray`** — nét đứt phải làm bằng `strokeOpacity: 0` +
   `icons` lặp (`GoogleMapComponent.pathOptions`).
7. **Leaflet vỡ icon khi bundle** — dùng `L.divIcon` (HTML thuần), không dùng icon PNG mặc định.
8. **CSS marker phải để ở `styles.scss`** — marker do SDK tạo nằm ngoài cây view Angular,
   view-encapsulation không áp được vào.
9. **Vẽ lại polyline mỗi tick khi tua** — `OsmMapComponent.renderPaths()` diff theo `key` và
   so sánh tham chiếu mảng `points`, không `clearLayers()` rồi dựng lại từ đầu.
10. **Chiếu vị trí toàn cục khi tuyến đi qua một con phố hai lần** — chiều đi và chiều về
    nằm chồng lên nhau, chiếu toàn cục bị hút sang nhánh sai làm "quãng đường còn lại" tụt
    vài km. `projectOnPath()` luôn quét **từ đoạn đang chạy** (`searchFromIndex`).
11. **Bám theo xe bằng `flyTo` mỗi bản ghi GPS** — animation 0,6 s bị chính nó huỷ mỗi
    0,5 s, bản đồ giật và người dùng không kéo đi đâu được. Chỉ dời khung nhìn khi xe đã
    đi quá 120 m (`FOLLOW_STEP_METERS`).
12. **Sửa danh sách điểm rồi mới đọc vị trí xe** — `resource` chuyển sang trạng thái tải
    ngay lập tức, `routePath()` rỗng, vị trí rơi về `{0,0}`. Luôn **chốt vị trí trước**,
    sửa danh sách sau.
13. **Bản ghi GPS thưa hơn bán kính geofence** — 60 giây/bản ghi ở 50 km/h là 830 m mỗi
    bước; mọi logic "đã tới nơi" dựa trên khoảng cách tức thời đều trượt. Phải kèm điều
    kiện "đã đi quá mốc chặng" (`checkArrival`).
14. **SDK bản đồ nhận HTML thô** — `L.divIcon({html})`, `bindPopup(string)`, `bindTooltip(string)`,
    `VtPopup.setHTML()` đều render như HTML. Tên khách hàng hay địa chỉ lấy từ server đi thẳng
    vào đó là XSS. Mọi chỗ ghép đều phải qua `escapeHtml` / `safeColor` / `safeGeoLink`
    (`core/map/html-safe.util.ts`). Chú ý cả **màu**: `style="background:${color}"` với `color`
    là chuỗi tự do cũng là một điểm chèn thuộc tính.
15. **`resource.value()` NÉM LẠI LỖI** khi loader hỏng — viết `resource.value() ?? []` là mọi
    computed đọc theo cũng ném theo, và người dùng thấy màn hình trắng thay vì dòng báo lỗi.
    Luôn `hasValue()` trước.
16. **"Không có tuyến" khác "tuyến dài 0 m"** — Google trả `routes: []` là câu trả lời hợp lệ
    (rất hay gặp với BICYCLE ở Việt Nam). Dựng một `RouteResult` rỗng thay thế sẽ hiện thành
    `0 m · 0 phút` kèm một đường vẽ, và không ai đọc ra là "không tìm được đường". Phải ném
    `RoutingError` (`core/map/routing.error.ts`).
17. **Kết quả async lạc chỗ** — khớp đường / bám đường mất vài giây, đủ để người dùng đổi chuyến
    hoặc đảo thứ tự điểm. Ghép kết quả theo **danh tính** (`tripId`, `waypoint.id`), không theo
    chỉ số mảng và không theo "cái gì về sau thì thắng". Cùng lý do, tuyến giữ làm nền ở
    `/navigate` phải gắn nhãn chuyến.
18. **KPI phải cùng mốc thời gian với vị trí xe** — màn có thanh tua thì mọi con số phải là
    "tình hình lúc đó". Trộn vị trí nội suy theo đồng hồ với KPI đọc từ trạng thái cuối ngày
    là màn hình tự mâu thuẫn với chính nó.
19. **Tử số và mẫu số của một tỉ lệ phải cùng một tập** — công thức
    `(delivered − late) / (delivered + failed)` với `late` đếm trên *mọi* điểm khiến một điểm
    giao hụt lúc muộn giờ bị trừ hai lần, và tỉ lệ ra **số âm**.
20. **"HTTP 200" KHÔNG có nghĩa là "số liệu đúng"** — cái bẫy đắt nhất của cả module này.
    Google trả về tuyến đi bộ 21.741 m qua phà, kèm mã 200 và một polyline liền mạch vẽ lên
    bản đồ rất thuyết phục. Mọi lớp bắt lỗi đều hoạt động đúng và đều im lặng, vì **chẳng có
    lỗi nào để bắt**. Cơ chế dự phòng chỉ cứu được lỗi *ồn ào*. Với dữ liệu bản đồ phải có
    thêm chốt chặn dựa trên **tính hợp lý của kết quả** (so với đường chim bay), và quan
    trọng hơn là **bảng năng lực từng nguồn theo từng phương tiện**, dựng từ đo đạc thật
    (`core/map/routing-capability.ts`).
21. **Nguồn định tuyến chọn theo PHƯƠNG TIỆN, không chỉ theo provider** — một nhà cung cấp
    mạnh ở ô tô có thể trống hoàn toàn ở đi bộ/xe đạp tại cùng khu vực. Cột "provider đang
    chọn" và cột "nguồn nào đủ dữ liệu cho phương tiện này" là hai chuyện khác nhau; gộp làm
    một là chấp nhận số liệu sai ở những phương tiện ít ai để ý.
22. **Đừng viện dẫn một phép đo cũ** — kết luận "mọi endpoint OSM đều bị chặn" trong bản
    README trước là đúng lúc đo, sai lúc đọc lại. Nó dẫn thẳng tới kết luận sai thứ hai
    ("xe đạp không có tuyến là giới hạn không vá được"). Đo lại mất 30 giây; tin vào bảng
    cũ thì hỏng cả một tính năng.
23. **Tham số "tính theo giao thông" đổi cả HÌNH HỌC tuyến, không chỉ ETA** —
    `TRAFFIC_AWARE` làm quãng đường ô tô dài thêm 59% vì nó né đường tắc. Dùng cho ETA lúc
    dẫn đường thì đúng; dùng cho báo cáo km/chi phí thì mỗi lần chạy lại ra một con số.

---

## 7. Khác biệt so với bản Vue gốc

| Bản Vue | Bản Angular này |
|---|---|
| State ở module scope (`const x = ref()`) → singleton sống dai hơn màn hình | Service DI provide ở cấp component/route → chết theo màn hình |
| Phải rải `isMapAlive()` khắp nơi chống race | Guard chỉ còn cho tác vụ async đang dở |
| Một `watch([...])` khổng lồ + `switch (mapType)` | `effect()` theo từng mối quan tâm + `@switch` trong template |
| Lẫn lộn km và mét | Thống nhất mét ở mọi service |
| Loader polling `setTimeout(check, 100)` | Cache đúng 1 Promise + timeout 15 s |
| Nhánh `OSMAP` viết dở, chưa màn nào gọi | Hoàn thiện và làm provider mặc định |
| Google Routes vứt bỏ `distanceMeters`/`duration` | Trả về đủ, thêm cả turn-by-turn |
| 3 hàm chết (`drawRoadLine`, `getMultilpleRoad`, `getRoadInfo`) | Đã loại bỏ |

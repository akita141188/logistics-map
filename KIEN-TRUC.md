# DMS Map Demo — Tổng kết & cấu trúc source

> Tài liệu này trả lời hai câu: **đã làm được những gì** và **code nằm ở đâu, file nào làm việc gì**.
> Phần hướng dẫn chạy / bảng đo mạng / phân tích cái bẫy nằm ở `README.md`.

Cập nhật: 10/09/2026 — `npm test` **248/248 pass** (20 test file), `npm run build` xanh.
Đã áp dụng toàn bộ checklist review `.agent/CLAUDE_DMS_MAP_REVIEW_FIX_20260910.md` (17 mục),
cộng đợt sửa khung nhìn bản đồ + cách vẽ tuyến dẫn đường (§1.5) và đợt dựng lại toàn bộ
mô phỏng GPS của màn Giám sát lộ trình (§1.6).

---

## 1. Đã làm được gì

### 1.1 Một vòng đời ngày làm việc của đơn vị vận chuyển

Không phải 5 demo rời rạc, mà là 5 mắt xích của cùng một luồng nghiệp vụ:

```
đơn hàng ──► lập kế hoạch & phân xe ──► dẫn đường tài xế ──► điều hành đội xe
             /planning                  /navigate            /fleet
             ma trận thật + CVRP        turn-by-turn         KPI toàn đội
                                              │
                                              ▼
                          giám sát & điều phối đơn phát sinh  /delivery
```

| Màn | Route | Người dùng | Store | Trạng thái |
|---|---|---|---|---|
| Điều hành đội xe | `/fleet` | Trực phòng điều độ | `fleet.store.ts` (548 dòng) | ✅ |
| Lập kế hoạch & phân xe | `/planning` | Điều phối viên đầu ngày | `planning.store.ts` (531) | ✅ |
| Dẫn đường tài xế | `/navigate` | Tài xế trong cabin | `navigation.store.ts` (696) | ✅ |
| Giám sát lộ trình | `/delivery` | Điều phối viên trong ca | `delivery-monitor.store.ts` (1109) | ✅ |
| Chỉ đường | `/directions` | Ai cũng dùng | `directions.store.ts` (396) | ✅ |

### 1.2 Nhóm tính năng bản đồ / định tuyến (lõi `core/map`)

| Nhóm | Đã có | File |
|---|---|---|
| **3 nhà cung cấp bản đồ** đổi được lúc chạy, màn hình không phải sửa | OpenStreetMap (Leaflet), Google Maps, Viettel Map | `map-surface.component.ts`, `osm/`, `google/`, `viettel/` |
| **Định tuyến** | OSRM `/route/v1` + Google Routes API v2, có phương án thay thế, có chỉ dẫn rẽ. **Không bao giờ bỏ điểm dừng** (vượt hạn mức thì cắt request chồng mép), **không bao giờ trả tuyến giả** (không có đường thì ném `RoutingError`), luôn kèm `RouteSource` cho biết ai đã tính | `routing.facade.ts`, `routing.error.ts`, `osrm-routing.service.ts`, `google-routes.service.ts` |
| **Chống XSS ở lớp bản đồ** | mọi text/màu/link ghép vào HTML của Leaflet & Viettel đều qua `escapeHtml` / `safeColor` / `safeGeoLink` | `html-safe.util.ts` (11 test) |
| **Ma trận chi phí** (nền tảng chia tuyến) | OSRM `/table` + Google `computeRouteMatrix`, tự cắt lô theo giới hạn server | `osrm-matrix.service.ts`, `google-matrix.service.ts` |
| **Bám tim đường một điểm** | OSRM `/nearest`, báo cả độ lệch mét | `osrm-nearest.service.ts` |
| **Khớp GPS vào mạng đường** (map matching) | OSRM `/match`, tự cắt cửa sổ chồng mép vì server chặn cứng 10 điểm | `osrm-match.service.ts` |
| **Tìm địa chỉ** | Nominatim + **Photon dự phòng** + Google Geocoding | `geocode.facade.ts`, `osm/`, `google/` |
| **Giải CVRP** trong trình duyệt | Clarke-Wright savings + 2-opt. Ràng buộc **cứng**: tải trọng và số điểm/chuyến. Khung giờ khách hẹn là **hậu kiểm/cảnh báo sau tối ưu**, KHÔNG phải ràng buộc của solver (xem chú thích ở `VrpStop`) | `vrp.util.ts` (11 test) |
| **Tối ưu thứ tự điểm** | nearest-neighbour + 2-opt, chèn điểm mới rẻ nhất | `route-optimizer.util.ts` |
| **Lõi dẫn đường thuần tuý** | chiếu vị trí, chỉ dẫn theo quãng đường, mốc chặng, ETA, phát hiện lệch tuyến | `navigation.util.ts` (424 dòng, **21 test**) |
| **Làm sạch & chấm điểm GPS** | lọc nhiễu, phát hiện khoảng mất tín hiệu, nhận diện điểm dừng, hồ sơ tốc độ | `gps-quality.util.ts` (273 dòng, test riêng) |
| **Cảnh báo vận hành** | quá tốc độ, dừng đỗ bất thường, lệch tuyến, trễ lịch, giao hụt, mất tín hiệu | `alerts.util.ts` (343 dòng, test riêng) |
| Toán địa lý & polyline | haversine, phương vị, nội suy, chiếu lên đoạn, encode/decode polyline | `geo.util.ts`, `polyline.util.ts` |

### 1.3 Những thứ làm cho sai số trên map nhỏ

Đây là phần được đầu tư nhiều nhất, vì đó là ranh giới giữa "demo bản đồ" và sản phẩm vận tải thật:

1. **Không bao giờ dùng khoảng cách chim bay cho số liệu nghiệp vụ.** Mọi km/phút đều lấy từ dịch vụ định tuyến thật. Nhánh Google có `GoogleMatrixService` riêng để khi mạng chặn OSRM, màn lập kế hoạch không âm thầm tụt xuống ước lượng chim bay (sai 15–30%).
2. **Vị trí xe luôn được chiếu vuông góc lên tim đường** (`projectOnPath`) trước khi tính bất kỳ con số nào. Trên `/navigate` chấm cam là toạ độ GPS thô, để nhìn thấy đúng phần sai số đã bị nắn.
3. **Map matching cho vệt quá khứ** (`OsrmMatchService`) — vệt GPS thô răng cưa được khớp lại vào mạng đường, so được cả hai để thấy chênh lệch quãng đường.
4. **Bám tim đường khi cắm điểm** (`snapToRoad` ở `/directions`) — điểm người dùng bấm giữa nhà dân được kéo ra mép phố, có hiển thị tổng độ lệch mét.
5. **Lọc nhiễu trước khi tính** (`cleanTrack`) — bỏ điểm cho ra tốc độ phi lý (>130 km/h), gộp điểm trùng, nên số km không bị nhiễu GPS thổi phồng.
6. **Phát hiện lệch tuyến bằng trễ Schmitt + đếm 3 bản ghi liên tiếp** — một fix nhiễu không được phép làm cả tuyến nhảy.
7. **Nhận biết "đã tới nơi" bằng geofence 45 m HOẶC đã qua mốc chặng** — vì thiết bị thật gửi vị trí 60 giây/lần, ở 50 km/h hai bản ghi cách nhau 830 m, mọi logic chỉ dựa trên khoảng cách tức thời đều trượt.
8. **Chọn nguồn định tuyến theo PHƯƠNG TIỆN, không chỉ theo provider** (`routing-capability.ts`). Đo thật: tuyến đi bộ Ngọc Lâm → Bà Triệu, Google trả **21.741 m** (đi vòng 9 km xuống phà Kim Lan), OSRM `routed-foot` trả **6.573 m** (qua cầu Long Biên) — sai **3,3 lần**. Đi bộ và xe đạp vì thế luôn tính bằng OSRM, kể cả khi đang chọn bản đồ Google, và màn hình gắn cờ đã đổi nguồn kèm lý do.
9. **Chốt chặn "đường vòng vô lý"** — mọi tuyến đều được so với đường chim bay; vượt 3 lần thì gọi nguồn còn lại đối chiếu và giữ tuyến ngắn hơn. Hệ số vòng hiện thẳng ra màn hình, vì "21,7 km" đứng một mình thì không có gì để đối chiếu, còn "vòng 4,8× đường chim bay" thì nhìn là biết sai.
10. **Quãng đường ổn định giữa các lần chạy** — mặc định gửi `TRAFFIC_UNAWARE`. Bật `TRAFFIC_AWARE` làm tuyến ô tô dài thêm **59%** (6.792 m → 10.787 m) vì Google né cầu Chương Dương đang tắc; chỉ `/navigate` bật, vì ở đó né tắc mới là điều mong muốn.

### 1.4 Chất lượng kỹ thuật

- **Angular 21 standalone, zoneless, signals** — không NgModule, không `zone.js`, state bằng `signal`/`computed`/`resource`.
- **Lazy toàn bộ 5 màn** (`loadComponent`), Leaflet ~150 kB không nằm trong bundle khởi động (`app.config.ts` cố ý import sâu, không qua barrel).
- **Lõi tính toán tách khỏi Angular**: `navigation.util.ts`, `vrp.util.ts`, `gps-quality.util.ts`, `geo.util.ts`, `alerts.util.ts` đều là hàm thuần → test không cần TestBed, chạy trong mili-giây.
- **Key nạp lúc runtime** qua `public/map-keys.json`, không nhúng lúc build; không có file → chạy OpenStreetMap, không throw.
- **248 unit test** phủ đúng phần dễ sai: toán học, thuật toán, hành vi store, và **ranh giới giữa các tầng** — nơi mọi lỗi nghiêm trọng của đợt review 10/09 đã lọt qua.
- **Có test chạy Leaflet THẬT** (`osm-map.component.spec.ts`, jsdom): lớp bug khung nhìn không nằm trong logic của mình mà nằm ở chỗ ghép với trạng thái nội bộ của Leaflet — mock đi thì không còn gì để kiểm chứng.

```
core/map/navigation.spec.ts        27 test   chiếu vị trí, chỉ dẫn, mốc chặng, ETA, lệch tuyến, cắt tuyến theo mét
core/map/routing-policy.spec.ts    20 test   ép nguồn theo phương tiện, chốt chặn đường vòng
core/map/routing.facade.spec.ts    17 test   giữ đủ waypoint, cắt request, dự phòng, lỗi
core/map/vrp.spec.ts               11 test   CVRP: tải trọng, số điểm, 2-opt
core/map/gps-quality.spec.ts       12 test   lọc nhiễu, gap, điểm dừng, xe đỗ ≠ mất sóng
core/map/html-safe.spec.ts         11 test   XSS qua marker/popup, màu CSS, link toạ độ
core/map/google/…routes.spec.ts     9 test   thân request 4 phương tiện, "không có tuyến"
core/map/osm/…map.component.spec.ts 7 test   fit khung nhìn khi đổi chuyến, không fit theo nhịp, đổi kiểu vẽ
core/map/route-optimizer.spec.ts    7 test   thứ tự điểm, chèn rẻ nhất
core/map/map-provider.spec.ts       6 test   khôi phục provider phải kèm kiểm tra key
core/map/runtime-keys.spec.ts       5 test   nạp key, thiếu file, JSON hỏng
features/delivery/…store.spec.ts   22 test   sửa kế hoạch giữa ca, ETA, khớp đường lạc chuyến, khung nhìn đổi chuyến, tua theo đồng hồ chuyến, mốc so sánh km
features/delivery/track-sim.spec.ts 18 test  độ thẳng ↔ tốc độ, nhiễu lệch ngang & trơn, mốc giờ tới, mẫu lúc đỗ
features/navigate/…store.spec.ts   14 test   tới nơi, giao xong, định tuyến lại, tuyến nền, ba sắc độ, tiến độ đơn điệu
features/directions/…store.spec.ts 14 test   đổi phương tiện/nguồn, số liệu cũ, snapAll race
features/delivery/…mock.api.spec.ts 13 test  bám phố, không vượt khách chưa giao, không bịa đường khi định tuyến hỏng
features/delivery/alerts.spec.ts   10 test   6 loại cảnh báo
features/fleet/fleet.store.spec.ts 10 test   KPI theo đồng hồ, tỉ lệ đúng hẹn
features/planning/…store.spec.ts    7 test   kéo đơn: tải trọng, số điểm, không mất đơn
core/map/geo.spec.ts                6 test   làm dày polyline: giữ đủ đỉnh gốc, sai số hình học = 0
                                   ── 248 test / 20 file
```

### 1.5 Đợt sửa khung nhìn bản đồ & cách vẽ tuyến dẫn đường

Hai lỗi người dùng báo, cả hai đều đã dựng lại được bằng test trước khi sửa.

**a) Đổi chuyến giao hàng mà bản đồ không tới tuyến mới.** Ba nguyên nhân độc lập cùng cộng vào:

| Nguyên nhân | Chi tiết | Sửa ở |
|---|---|---|
| `fitBounds(..., { animate: true })` | Hai chuyến ở hai tỉnh thường có CÙNG mức zoom, nên Leaflet đi nhánh **pan** chứ không phải zoom. `_tryAnimatedPan` có chốt an toàn "pan quá xa thì đừng animate" (Leaflet issue #2602: tile biến mất / lệch chỗ), nhưng `animate: true` đi vòng qua đúng cái chốt đó → dời hàng triệu pixel bằng CSS transition → khung nhìn không bao giờ tới đích | `osm-map.component.ts` — chỉ animate khi khung nhìn mới còn **giao** với khung nhìn hiện tại |
| Fit rơi vào lúc dữ liệu còn rỗng | `resource` xoá dữ liệu về `undefined` trước khi tải xong; fit lúc đó không có gì để ôm, mà token đã coi như dùng xong → dữ liệu về sau không fit nữa | `osm-map.component.ts` — ghi nhớ token, **chỉ đánh dấu đã dùng khi thật sự fit được** |
| Google & Viettel **không có** cơ chế fit | `fitToken` bị bỏ hẳn, `focus` bị nhồi vào `[center]` (chỉ có tác dụng lúc khởi tạo) | `google-map.component.ts`, `viettel-map.component.ts` — thực hiện đủ cả `fitToken` và `focus` |

Kèm theo: dữ liệu nhích mỗi nhịp (tua lại, dẫn đường) **không còn** kéo khung nhìn — trước đó `fitContent()` chạy mỗi 200–500 ms, giật khung nhìn và đè lên cả chế độ bám xe.

**b) Đường dẫn đường vẽ linh tinh.** Ba nguyên nhân:

| Nguyên nhân | Chi tiết | Sửa ở |
|---|---|---|
| Cắt tuyến theo **chỉ số đỉnh** | `projectOnPath` trả chỉ số đoạn — phụ thuộc nhiễu GPS và mật độ đỉnh. Nhiễu một nhịp là điểm cắt nhảy lùi; mồi còn sót của tuyến cũ bị kẹp vào `path.length - 2` của tuyến mới là điểm cắt nhảy thẳng tới cuối, cả tuyến bị tô màu "đã đi" | `navigation.util.ts` — thêm `slicePathByDistance` cắt theo **mét**, nội suy đúng hai đầu |
| Tiến độ lấy trực tiếp từ bản ghi GPS | Nhiễu có thành phần **dọc đường**, nên km còn lại và điểm cắt tiến-lùi liên tục | `navigation.store.ts` — `_progressMeters` **chỉ tiến**, đặt lại khi có tuyến mới |
| Ghi trạng thái trong `computed` | `this.lastSegmentIndex = result.index` nằm trong thân `projection` — số lần `computed` chạy lại do Angular quyết định | `navigation.store.ts` — mồi thành signal, ghi trong `emitFix()` |

Cách vẽ mới theo đúng Google Maps, ba sắc độ trên cùng một tuyến (`NAV_ROUTE_COLORS`): **đã đi** xám mờ → **chặng tới điểm dừng kế tiếp** xanh `#1a73e8` dày nhất có viền đậm `#0b57d0` → **chưa tới** (sau điểm dừng kế tiếp) xanh nhạt `#a8c7fa`. Có chú giải ba sắc độ ngay trên màn hình.

Đợt này còn vá thêm một lỗi chưa ai báo: `renderPaths` cập nhật tại chỗ theo `key` nhưng **chỉ cập nhật toạ độ, không cập nhật kiểu vẽ**. Hệ quả: đường dẫn đường đổi sang đỏ khi đi lệch tuyến thì vẫn xanh, và chọn một xe ở màn lập kế hoạch thì các tuyến khác không mờ đi.

### 1.6 Dựng lại mô phỏng GPS của màn Giám sát lộ trình

Triệu chứng người dùng báo: *"ấn play có nhiều đoạn vẫn không đi đúng đường nét đứt"* và *"đoạn Đại học Thuỷ Lợi kẻ thẳng ra tận hồ Đống Đa"*. Đào ra **sáu** khuyết tật độc lập, tất cả đều nằm ở khâu sinh dữ liệu giả lập chứ không ở khâu vẽ.

| # | Nguyên nhân | Bằng chứng đo được | Sửa ở |
|---|---|---|---|
| 1 | Lấy mẫu GPS theo **chỉ số mảng** (`i % step`) | Tuyến HN 1240 đỉnh/35,6 km, khoảng cách hai đỉnh p50 = 20 m nhưng **max 254 m**. `step = 4` đẩy đường ra xa mặt đường **105 m**, tạo dây cung **403 m** | `geo.util.ts` — `resampleAlongPath` **chỉ thêm, không bớt** |
| 2 | Đoạn đi lệch tuyến **nối thẳng** | Hai đoạn thẳng ~2 km cắt qua khu dân cư Thuỷ Lợi rồi đâm ra hồ Đống Đa | `delivery-mock.api.ts` — `buildDetour` **định tuyến thật** qua chỗ ghé; hỏng thì bỏ hẳn, không bịa |
| 3 | Nhiễu GPS là **nhiễu trắng** cộng vào lat/lng | Có thành phần dọc đường → cộng dồn vào km thực tế; không tự tương quan → đường răng cưa | `track-sim.util.ts` — `applyGpsNoise` lệch **ngang**, trơn theo quãng đường |
| 4 | Cắt track ở **72% số đỉnh** | = 75,7% quãng đường, trong khi khách số 6 ở 61,6% và số 7 ở 68,7% → xe đã chạy vượt hai khách "Chưa tới" 3–5 km | `delivery-mock.api.ts` — mốc suy từ **điểm xử lý cuối → điểm chưa giao kế tiếp** |
| 5 | Giờ tới **gõ tay** (`delayMinutes`) | Điểm 4 chậm 41', điểm 5 chậm 18' ⇒ 4,3 km trong **2 phút = 129 km/h** giữa nội thành | Seed chỉ khai `dwellMinutes`; giờ tới **suy ra** từ `legs[].durationSeconds` thật |
| 6 | Thời gian rải **đều theo quãng đường** | Mọi điểm đều ~8 km/h ⇒ ngưỡng quá tốc 60 km/h không bao giờ chạm tới | `track-sim.util.ts` — biểu đồ tốc độ theo **độ thẳng** của tuyến |

Kèm theo, ba lỗi lộ ra trong lúc sửa:

- `cleanTrack` gộp nhiễu lúc đứng yên **sạch quá**: xe đỗ 37 phút giao hàng bị `findGaps` kết luận là *"Mất tín hiệu 37 phút"*. Thêm `maxStationarySeconds` để giữ lại bằng chứng thiết bị vẫn báo về.
- Thanh tua nhảy **theo chỉ số mảng** nhưng dán nhãn "4x". Thiết bị thật bắn log dày lúc chạy / thưa lúc đỗ, nên cách này làm quãng đứng yên trôi chậm rề còn quãng chạy thì vụt mất. Đổi sang tua theo **đồng hồ chuyến** (`nextCursorByTime`, `PLAYBACK_SPEEDS` giờ là bội số thời gian thật).
- KPI "Chênh lệch" trừ **thực tế nửa chuyến** cho **dự kiến cả chuyến** → khoe tài xế tiết kiệm 12 km. Đổi mốc sang `plannedSoFarMeters` (chiếu vị trí GPS mới nhất lên lộ trình dự kiến), nhãn đổi thành "Đi thừa".
- Cache của `DeliveryMockApi` khoá theo `tripId` trong khi lộ trình dự kiến tính lại theo provider → đổi nhà cung cấp bản đồ là hai đường lệch nhau. Khoá giờ có cả provider.

**Đo lại trên tuyến thật (Google Routes, chuyến Nguyễn Văn Toàn):**

| | Trước | Sau |
|---|---|---|
| Lệch mặt đường (đoạn đi đúng tuyến) | tới 105 m | **7 m** |
| Dây cung dài nhất giữa 2 điểm GPS | 403 m | **41 m** |
| Khoảng cách tới khách "Chưa tới" gần nhất | xe đã chạy vượt qua | **2.092 m / 2.599 m** (chưa tới) |
| Tốc độ p10/p50/p90/max | ~8 / 8 / 8 / 27 km/h | **8 / 28 / 47 / 56 km/h** |
| Đoạn đi lệch | 2 đoạn thẳng qua nhà dân | **1 khúc liền, đỉnh lệch 1.055 m, trên phố thật** |

---

## 2. Cấu trúc source

### 2.1 Nhìn từ trên xuống

```
dms-map-demo/
├── public/
│   ├── map-keys.json          ← API key thật (đã gitignore)
│   └── map-keys.example.json  ← mẫu để copy
├── scripts/sync-env.ps1       ← đọc .env của dms.webapp → sinh map-keys.json
├── src/
│   ├── main.ts                ← fetch map-keys.json TRƯỚC rồi mới bootstrap
│   ├── styles.scss
│   └── app/
│       ├── app.ts / .html / .scss   ← khung layout + thanh chọn provider
│       ├── app.config.ts            ← provider gốc, chọn map mặc định theo key
│       ├── app.routes.ts            ← 5 route, tất cả lazy
│       ├── core/map/                ← THƯ VIỆN BẢN ĐỒ (dùng lại được)
│       └── features/                ← 5 MÀN NGHIỆP VỤ
└── README.md / KIEN-TRUC.md
```

Nguyên tắc phân tầng: **`features/` được phép gọi `core/`, `core/` không bao giờ biết `features/`.**
Màn hình chỉ làm việc với kiểu trung lập (`LatLng`, `MapMarker`, `MapPath`, `RouteResult`) — đổi
nhà cung cấp bản đồ không phải sửa một dòng nào trong `features/`.

### 2.2 `core/map/` — thư viện bản đồ

**Tầng công khai** (import từ `core/map` là qua các file này):

| File | Dòng | Vai trò |
|---|---|---|
| `index.ts` | 39 | Barrel. ⚠️ Không import từ file eager — kéo cả Leaflet vào bundle khởi động |
| `map.types.ts` | 310 | Kiểu trung lập: `LatLng`, `RouteResult`, `RouteSource`, `RouteStep/Leg`, `MapMarker/Path/Circle`, `MapProvider`, bảng màu, danh sách lớp nền |
| `map-routing.config.ts` | 185 | Toàn bộ cấu hình runtime gom vào 1 `InjectionToken`: endpoint, giới hạn đo được của OSRM, ngưỡng nghiệp vụ (geofence, quá tốc độ, dừng đỗ) |
| `runtime-keys.ts` | 64 | Nạp API key lúc chạy từ `public/map-keys.json` |
| `map-provider.service.ts` | 118 | Provider đang chọn + nhớ lựa chọn, dùng chung mọi màn. `restore()` **kiểm tra key trước khi khôi phục** — không mắc kẹt ở provider thiếu key |
| `map-surface.component.ts` | 126 | `<dms-map-surface>` — mặt bàn vẽ duy nhất, `@switch` sang 1 trong 3 nhánh. `fitToken`/`focus` được **cả ba nhánh** thực hiện (trước đây chỉ Leaflet) |
| `routing.facade.ts` | 423 | **Cửa duy nhất** để lấy đường đi / ma trận / snap / map-match. Màn hình không được gọi thẳng service provider. Chứa chính sách chọn nguồn 3 tầng: ép nguồn theo phương tiện → dự phòng khi hỏng → đối chiếu khi tuyến vòng phi lý |
| `routing-capability.ts` | 150 | **Bảng năng lực từng nguồn theo từng phương tiện**, dựng từ số đo thật kèm bằng chứng. Nơi ghi lại vì sao đi bộ/xe đạp không dùng Google ở Việt Nam, và chốt chặn hệ số vòng |
| `routing.error.ts` | 40 | `RoutingError` + mã lỗi (`NO_ROUTE`, `UNSUPPORTED_MODE`, `TOO_MANY_WAYPOINTS`…) — thay cho thói quen trả route giả 0 m |
| `geocode.facade.ts` | 120 | Cửa duy nhất để tìm địa chỉ, tự rơi Nominatim → Photon → Google |
| `route-state.store.ts` | 131 | State tuyến dùng chung giữa các màn |

**Tầng thuật toán thuần tuý** (không phụ thuộc Angular, dễ test nhất):

| File | Dòng | Nội dung |
|---|---|---|
| `geo.util.ts` | 341 | Haversine, phương vị, nội suy, `pointAtRatio`, `distanceToPathMeters`, **`resampleAlongPath`** (làm dày polyline mà giữ nguyên 100% đỉnh gốc), chuẩn hoá/gộp/tỉa điểm, format km-phút-giờ, deep-link Google Maps |
| `navigation.util.ts` | 522 | `projectOnPath`, `cumulativeAlong`, `pointAtAlong`, `bearingAtAlong`, **`slicePathByDistance`** (cắt khúc tuyến theo mét — nền của cách vẽ 3 sắc độ), `stepOffsets`, `guidanceAt`, `maneuverIcon` (hiểu cả mã OSRM lẫn mã Google), `legBoundaries`, `activeLegIndex`, `etaSeconds`, `updateOffRoute` |
| `gps-quality.util.ts` | 345 | `cleanTrack` (có `maxStationarySeconds` để xe đỗ không bị hiểu nhầm thành mất sóng), `findGaps`, `speedProfileKmh`, `detectStops`, `summarizeTrack` |
| `vrp.util.ts` | 348 | `solveCvrp` (Clarke-Wright + 2-opt), `routeCost`. Chú thích ngay trên `VrpStop` ghi rõ phạm vi ràng buộc: **không** enforce khung giờ |
| `html-safe.util.ts` | 86 | `escapeHtml`, `safeColor` (whitelist cú pháp màu), `safeGeoLink` (dựng URL từ số đã kiểm miền) — mọi chuỗi ghép vào HTML của Leaflet/Viettel đều đi qua đây |
| `route-optimizer.util.ts` | 169 | `optimizeWaypointOrder`, `bestInsertion`, `insertionCostMeters` |
| `polyline.util.ts` | 115 | Encode/decode polyline Google (precision 5 & 6) |
| `expected-route.util.ts` | 77 | Dựng lộ trình dự kiến từ danh sách khách + thứ tự ghé |

**Nhánh OpenStreetMap** — `core/map/osm/` (mặc định, không cần key):

| File | Dòng | Vai trò |
|---|---|---|
| `osm-map.component.ts` | 795 | Bọc Leaflet: marker, đường, vòng geofence, nhiều xe cùng lúc, chế độ cắm điểm, fit bounds, bay tới điểm. Mọi popup/divIcon dựng qua `html-safe.util`. Fit **một lần cho mỗi `fitToken`, chờ tới khi có dữ liệu**, và không animate khi phải dời xa (bẫy #24) |
| `osm-map.component.spec.ts` | 212 | Chạy **Leaflet thật** trong jsdom: đổi chuyến phải fit tới tuyến mới, dữ liệu nhích không được dời khung nhìn, đổi màu đường phải có tác dụng (7 test) |
| `osrm-routing.service.ts` | 267 | `/route/v1` — đường đi, chặng, chỉ dẫn rẽ, phương án thay thế, chọn endpoint theo phương tiện (`routed-foot` / `routed-bike` / car), gắn nhãn nguồn thật |
| `osrm-matrix.service.ts` | 186 | `/table` — ma trận chi phí, tự cắt lô khi vượt 25 điểm |
| `osrm-match.service.ts` | 248 | `/match` — khớp GPS vào đường, tự cắt cửa sổ 10 điểm chồng mép rồi khâu lại |
| `osrm-nearest.service.ts` | 126 | `/nearest` — bám điểm vào tim đường gần nhất |
| `nominatim-geocode.service.ts` | 88 | Tìm địa chỉ + reverse geocode |
| `photon-geocode.service.ts` | 136 | Geocoder **dự phòng** (Nominatim bị chặn ở nhiều mạng VN), hợp autocomplete hơn |

**Nhánh Google** — `core/map/google/`:

| File | Dòng | Vai trò |
|---|---|---|
| `google-maps-loader.service.ts` | 60 | Nạp JS SDK một lần duy nhất, dùng chung mọi màn |
| `google-map.component.ts` | 306 | Bọc `@angular/google-maps`: marker, polyline, `<map-circle>` cho geofence, và **fit bounds + bay tới điểm** (`fitToken`/`focus`) |
| `google-routes.service.ts` | 278 | Routes API v2 (`computeRoutes`) — có chỉ dẫn rẽ do Google dịch sẵn. `routes: []` → ném `RoutingError`, **không** còn nhánh dựng route giả |
| `google-matrix.service.ts` | 146 | `computeRouteMatrix` — ma trận thật cho màn lập kế hoạch |
| `google-geocode.service.ts` | 125 | Geocoding API |

**Nhánh Viettel** — `core/map/viettel/`:

| File | Dòng | Vai trò |
|---|---|---|
| `vtmap.types.ts` | 144 | Khai báo kiểu cho `vtmap-gl` (SDK không có typings) |
| `vtmap-loader.service.ts` | 100 | Nạp script + css theo domain/version cấu hình |
| `viettel-map.service.ts` | 388 | Vòng đời map, source/layer, marker, fit bounds |
| `viettel-route.service.ts` | 331 | Bọc `RoadDrawerControl` — SDK Viettel chỉ vẽ lên map và ghi text vào DOM, không trả JSON, nên số liệu vẫn phải lấy từ OSRM |
| `road-marker.renderer.ts` | 220 | Marker đánh số theo thứ tự ghé; popup GPS dựng qua `html-safe.util` |
| `viettel-map.component.ts` | 264 | Nhánh `<dms-map-surface>` cho Viettel; `setHTML()` chỉ nhận chuỗi đã escape; có **fit bounds + bay tới điểm** (`fitToken`/`focus`) |

### 2.3 `features/` — 5 màn nghiệp vụ

Mỗi màn theo cùng một khuôn: **`*.store.ts` giữ toàn bộ state + logic (signals), `*.page.ts/html/scss` chỉ hiển thị.**
Page không gọi HTTP, không tính toán — nhờ vậy store test được mà không cần dựng DOM.

```
features/
├── fleet/                       ĐIỀU HÀNH ĐỘI XE — /fleet
│   ├── fleet.store.ts      699  đồng hồ chung cho cả đội (nội suy theo MỐC THỜI GIAN,
│   │                            không theo chỉ số mảng GPS), tua 1×→60×, KPI toàn đội
│   │                            derive AS-OF đồng hồ (`isHandledAt`), tỉ lệ đúng hạn tính
│   │                            trên cùng một tập (on-time delivered / delivered),
│   │                            dòng cảnh báo xếp theo mức độ, marker nhiều xe
│   ├── fleet.store.spec.ts 245  (10 test)
│   └── fleet-board.page.*   78/202/462
│
├── planning/                    LẬP KẾ HOẠCH & PHÂN XE — /planning
│   ├── planning.models.ts    99  đơn hàng, xe, kho, tuyến đã hoạch định
│   ├── planning-mock.api.ts 368  sinh 30 đơn + 4 xe quanh Hà Nội
│   ├── planning.store.ts    713  3 pha tách rời: ma trận → chia tuyến → vẽ đường.
│   │                             Kéo đơn giữa 2 xe chỉ chạy lại pha 2 → phản hồi tức thì.
│   │                             `rejectionFor()` chạy TRƯỚC mọi thao tác ghi → kéo đơn
│   │                             vượt tải/vượt số điểm bị từ chối, không mất đơn nửa chừng
│   ├── planning.store.spec.ts 223  (7 test)
│   └── planning.page.*       91/329/583
│
├── navigate/                    DẪN ĐƯỜNG TÀI XẾ — /navigate
│   ├── navigation.store.ts 1004  vị trí bám tim đường, băng chỉ dẫn rẽ theo vị trí thật,
│   │                             tự phát hiện đi sai đường → tự định tuyến lại từ chỗ
│   │                             đang đứng, tự nhận biết đã tới nơi và DỪNG chờ xác nhận,
│   │                             ETA điểm kế tiếp / giờ về kho, nhật ký hành trình.
│   │                             `_lastRoute` gắn `tripId` → giữ khi định tuyến lại CÙNG
│   │                             chuyến, bỏ khi đổi hẳn chuyến.
│   │                             `_progressMeters` chỉ tiến; `NAV_ROUTE_COLORS` + cắt tuyến
│   │                             theo mét → 3 sắc độ đường đúng kiểu Google Maps
│   ├── navigation.store.spec.ts 432  (14 test)
│   └── navigate.page.*       97/270/564
│
├── delivery/                    GIÁM SÁT LỘ TRÌNH — /delivery
│   ├── delivery.models.ts   135  chuyến, điểm giao, kho, ETA, tác động khi sửa kế hoạch
│   ├── track-sim.util.ts    343  HÀM THUẦN mô phỏng GPS log: biểu đồ tốc độ theo độ thẳng
│   │                             của tuyến, nhiễu lệch NGANG & tự tương quan, mốc thời
│   │                             gian neo vào từng điểm giao, mẫu lúc xe đỗ giao hàng
│   ├── track-sim.spec.ts    266  (18 test)
│   ├── delivery-mock.api.ts 758  sinh chuyến từ chính lộ trình định tuyến thật: vị trí xe
│   │                             suy từ trạng thái đơn, đoạn đi lệch tuyến ĐƯỢC ĐỊNH TUYẾN
│   │                             thật, giờ tới suy từ `legs[].durationSeconds`. Cache khoá
│   │                             theo `tripId + provider`
│   ├── delivery-mock.api.spec.ts 332  (13 test) — khoá 3 ràng buộc: bám phố, không vượt
│   │                             khách "Chưa tới", không bịa hình học khi định tuyến hỏng
│   ├── alerts.util.ts       386  6 loại cảnh báo + ngưỡng cấu hình được
│   ├── alerts.spec.ts       223  (10 test)
│   ├── delivery-monitor.store.ts 1435  màn lớn nhất: phát lại vệt GPS theo ĐỒNG HỒ CHUYẾN
│   │                             (`nextCursorByTime`), so tuyến dự kiến / thực tế / đã khớp
│   │                             đường, chấm điểm chất lượng GPS, điểm dừng, geofence xác
│   │                             minh giao hàng, chèn đơn phát sinh giữa ca (tìm chỗ chèn
│   │                             rẻ nhất) + xem ETA lan truyền. Khớp đường có "vé" `tripId`
│   │                             → kết quả về muộn của chuyến cũ không đắp sang chuyến đang
│   │                             xem. Đổi chuyến còn xoá `focus`. KPI "Đi thừa" so với
│   │                             `plannedSoFarMeters`, không so với cả tuyến
│   ├── delivery-monitor.store.spec.ts 616  (22 test)
│   └── delivery-monitor.page.* 198/586/905
│
└── directions/                  CHỈ ĐƯỜNG — /directions
    ├── directions.store.ts  551  nhiều điểm dừng, 4 phương tiện, phương án thay thế,
    │                             bám tim đường khi cắm điểm, tối ưu thứ tự, deep-link,
    │                             hiện NGUỒN ĐỊNH TUYẾN thật + hệ số vòng. `snapAll()` ghép
    │                             kết quả theo `id` (không theo chỉ số), đổi nguồn/phương
    │                             tiện đều đưa `_routeIndex` về 0, không hiện số liệu cũ
    ├── directions.store.spec.ts 292  (14 test)
    └── directions.page.*    106/284/592
```

### 2.4 Luồng dữ liệu

```
   Page (chỉ hiển thị)
     │  gọi hành động, đọc signal
     ▼
   Store (signal / computed / resource)  ──►  Mock API (dữ liệu chuyến, đơn)
     │
     ├──► RoutingFacade ──┬─► OSRM  (route / table / nearest / match)
     │                    └─► Google (Routes v2 / RouteMatrix)
     ├──► GeocodeFacade ──┬─► Nominatim ─► Photon (dự phòng)
     │                    └─► Google Geocoding
     └──► hàm thuần: navigation.util / vrp.util / gps-quality.util / geo.util / alerts.util
                    │
                    ▼
          markers() / paths() / circles() / vehicle()   ──►  <dms-map-surface>
                                                                  │
                                                    @switch ──────┼─► Leaflet
                                                                  ├─► Google Maps
                                                                  └─► Viettel vtmap-gl
```

Điểm mấu chốt: store **chỉ sinh ra dữ liệu trung lập** (`MapMarker[]`, `MapPath[]`, `MapCircle[]`).
`<dms-map-surface>` mới là chỗ duy nhất biết đang dùng nhà cung cấp nào.

---

## 3. Lệnh thường dùng

```bash
npm install
npm start          # http://localhost:4200 — không cần API key, mặc định OpenStreetMap
npm run sync:env   # đọc .env của dms.webapp → sinh public/map-keys.json
npm test           # vitest — 201 test
npm run build      # build production (KHÔNG kèm key)
```

## 4. Còn có thể làm tiếp

- Thay bộ phát GPS giả lập trong `navigation.store.ts` / `fleet.store.ts` bằng WebSocket thật (đã tách sẵn, chỉ đổi nguồn tick).
- Nhánh Viettel chưa vẽ được vòng geofence (`vtmap-gl` không có primitive hình tròn theo mét — phải tự sinh đa giác 64 đỉnh).
- Màn `/fleet` mới hiển thị nhiều xe ở nhánh OpenStreetMap.
- OSRM đang trỏ server demo công cộng, không có SLA — production phải self-host (`osrmBaseUrl` trong `map-routing.config.ts`). Tuyến đi bộ/xe đạp hiện phụ thuộc `routing.openstreetmap.de` của FOSSGIS, cũng là dịch vụ cộng đồng miễn phí; self-host thêm hai profile `foot`/`bike` là gỡ được cả hai phụ thuộc.
- **Xe máy vẫn chưa có hồ sơ riêng ở nhánh OSM** — `router.project-osrm.org` chỉ biên dịch profile ô tô, nên khi rơi về OSRM thì xe máy chạy bằng luật ô tô (đã gắn `degraded: true` và cảnh báo trên UI). Sửa dứt điểm bằng cách self-host một profile `motorcycle.lua`.
- **Bảng ép nguồn mới phủ Hà Nội.** `MANDATED_SOURCE` dựng từ số đo trên một hành lang cụ thể (vượt sông Hồng). Trước khi triển khai tỉnh khác nên đo lại vài cặp điểm đại diện — nhất là những nơi có sông lớn, phà, hoặc cầu hạn chế phương tiện.
- **Chốt chặn hệ số vòng loãng dần khi tuyến nhiều điểm** (30.033/10.352 = 2,90, lọt ngưỡng 3,0). Muốn bắt chắc hơn thì phải xét **từng chặng** (`legs[i]` so với chim bay của chặng đó) thay vì xét tổng tuyến — chưa làm vì cần `legs` từ cả hai nguồn và làm tăng độ phức tạp của phần ghép request.

import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MAP_ROUTING_CONFIG, MAP_ROUTING_CONFIG } from '../map-routing.config';
import { LatLng, TravelMode } from '../map.types';
import { GoogleRoutesService } from './google-routes.service';

/**
 * ============ CHỐT "KHÔNG ĐƯỢC BỊA TUYẾN" CỦA GOOGLE ROUTES ============
 *
 * Bản cũ, khi Google trả `routes: []` hoặc tuyến thiếu polyline, dựng ra một
 * `RouteResult` gồm chính các waypoint đầu vào với `distance = 0`,
 * `duration = 0`. Trên UI nó hiện thành `0 m · 0 phút` mà bản đồ VẪN có đường —
 * người dùng đọc thành "tuyến ngắn lạ" chứ không đọc thành "không có tuyến".
 * Đây chính là nguyên nhân màn `/directions` hiện `0 m / 0 phút` khi chọn xe đạp.
 *
 * Test còn khoá luôn phần thân request: sai `travelMode` hoặc thiếu
 * `intermediates` là sai từ gốc, mọi thứ phía sau vô nghĩa.
 */

const HANOI: LatLng[] = [
  { lat: 21.0442, lng: 105.8663 }, // Kho Long Biên
  { lat: 21.0125, lng: 105.8501 }, // Siêu thị mini Bà Triệu
  { lat: 21.0313, lng: 105.7905 }, // Đại lý Cầu Giấy
];

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      {
        provide: MAP_ROUTING_CONFIG,
        useValue: { ...DEFAULT_MAP_ROUTING_CONFIG, googleMapsKey: 'test-key' },
      },
      GoogleRoutesService,
    ],
  });

  return {
    service: TestBed.inject(GoogleRoutesService),
    http: TestBed.inject(HttpTestingController),
  };
}

describe('GoogleRoutesService — thân request', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it.each<[TravelMode, string]>([
    ['driving', 'DRIVE'],
    ['motorbike', 'TWO_WHEELER'],
    ['cycling', 'BICYCLE'],
    ['walking', 'WALK'],
  ])('phương tiện "%s" gửi đi đúng mã "%s"', async (mode, expected) => {
    const { service, http } = setup();
    const promise = service.computeRoutes(HANOI, { travelMode: mode });

    const req = http.expectOne((r) => r.url.includes('computeRoutes'));
    expect(req.request.body.travelMode).toBe(expected);

    // `routingPreference: TRAFFIC_AWARE` CHỈ hợp lệ với DRIVE/TWO_WHEELER.
    // Gửi kèm cho WALK/BICYCLE là Google trả 400, mất hẳn tuyến.
    if (expected === 'DRIVE' || expected === 'TWO_WHEELER') {
      expect(req.request.body.routingPreference).toBe('TRAFFIC_AWARE');
    } else {
      expect(req.request.body.routingPreference).toBeUndefined();
    }

    req.flush({
      routes: [
        { polyline: { encodedPolyline: '_p~iF~ps|U' }, distanceMeters: 100, duration: '60s' },
      ],
    });
    await promise;
  });

  it('origin / intermediates / destination đủ và đúng thứ tự', async () => {
    const { service, http } = setup();
    const promise = service.computeRoutes(HANOI);

    const req = http.expectOne((r) => r.url.includes('computeRoutes'));
    const body = req.request.body;
    expect(body.origin.location.latLng.latitude).toBe(HANOI[0].lat);
    expect(body.intermediates.length).toBe(1);
    expect(body.intermediates[0].location.latLng.latitude).toBe(HANOI[1].lat);
    expect(body.destination.location.latLng.latitude).toBe(HANOI[2].lat);
    // Không được tự ý đảo thứ tự waypoint sau lưng nghiệp vụ.
    expect(body.optimizeWaypointOrder).toBe(false);

    req.flush({
      routes: [
        { polyline: { encodedPolyline: '_p~iF~ps|U' }, distanceMeters: 100, duration: '60s' },
      ],
    });
    await promise;
  });

  it('quá 25 điểm trung gian -> báo lỗi hạn mức, KHÔNG cắt bớt điểm', async () => {
    const { service } = setup();
    const many = Array.from({ length: 40 }, (_, i) => ({ lat: 21, lng: 105.8 + i * 0.01 }));

    await expect(service.computeRoutes(many)).rejects.toThrow(/tối đa 25 điểm trung gian/);
  });
});

describe('GoogleRoutesService — không có tuyến thì phải BÁO LỖI', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('`routes: []` -> RoutingError NO_ROUTE, không phải tuyến 0 m', async () => {
    const { service, http } = setup();
    const promise = service.computeRoutes(HANOI, { travelMode: 'cycling' });

    http.expectOne((r) => r.url.includes('computeRoutes')).flush({ routes: [] });

    await expect(promise).rejects.toMatchObject({
      name: 'RoutingError',
      code: 'NO_ROUTE',
      travelMode: 'cycling',
    });
  });

  it('tuyến thiếu polyline -> cũng là NO_ROUTE, không nối thẳng waypoint', async () => {
    const { service, http } = setup();
    const promise = service.computeRoutes(HANOI, { travelMode: 'walking' });

    http
      .expectOne((r) => r.url.includes('computeRoutes'))
      .flush({ routes: [{ distanceMeters: 30000, duration: '24720s' }] });

    await expect(promise).rejects.toMatchObject({ code: 'NO_ROUTE' });
  });

  it('có tuyến thật -> trả path đã giải mã, km và giây > 0, kèm nguồn', async () => {
    const { service, http } = setup();
    const promise = service.computeRoutes(HANOI, { travelMode: 'driving' });

    http
      .expectOne((r) => r.url.includes('computeRoutes'))
      .flush({
        routes: [
          {
            // Polyline thật của 2 điểm gần Hà Nội.
            polyline: { encodedPolyline: 'wc_dCkeavSjyBpb@' },
            distanceMeters: 15100,
            duration: '3480s',
            legs: [
              { distanceMeters: 7000, duration: '1600s' },
              { distanceMeters: 8100, duration: '1880s' },
            ],
          },
        ],
      });

    const [route] = await promise;
    expect(route.path.length).toBeGreaterThan(1);
    expect(route.distanceMeters).toBe(15100);
    expect(route.durationSeconds).toBe(3480);
    expect(route.legs?.length).toBe(2);
    expect(route.source?.label).toBe('Google Routes · Ô tô');
  });
});

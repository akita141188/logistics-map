import { bootstrapApplication } from '@angular/platform-browser';
import { createAppConfig } from './app/app.config';
// Import SÂU, không qua barrel `core/map`: xem chú thích ở `app.config.ts`.
import { loadMapRuntimeKeys } from './app/core/map/runtime-keys';
import { App } from './app/app';

/**
 * Đọc key trước rồi mới bootstrap.
 *
 * Phải await ở đây (không dùng APP_INITIALIZER) vì `provideMapRouting` cần giá
 * trị key ngay lúc tạo injector, và `defaultProvider` cũng phụ thuộc vào key.
 * `loadMapRuntimeKeys()` không bao giờ reject nên không chặn app khởi động.
 */
loadMapRuntimeKeys()
  .then((keys) => bootstrapApplication(App, createAppConfig(keys)))
  .catch((err) => console.error(err));

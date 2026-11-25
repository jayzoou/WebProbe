# WebProbe · 当前技术栈

| 范围   | 实际工具                                                                    |
| ------ | --------------------------------------------------------------------------- |
| 前端   | Vue 3、Vue Router、TypeScript、Vite                                         |
| 服务端 | Node.js ≥22.19、Hono、原生 SQLite、Zod                                      |
| 检测   | Playwright Chromium/Firefox/WebKit、Lighthouse、axe                         |
| 测试   | Node test + tsx、现有自定义 Playwright E2E；没有 Vitest 或 @playwright/test |
| 工程   | npm、package-lock.json、Prettier、vue-tsc、tsc                              |

不为接入模板替换已有测试框架或业务目录。`npm run verify:high` 聚合前后端、核心、安全与真实浏览器验证；CI 显式安装 playwright 库所需浏览器。

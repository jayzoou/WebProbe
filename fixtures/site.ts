import http from 'node:http';
export function createFixture() {
  let fixed = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/missing.png') {
      res.writeHead(404).end('missing');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WebProbe 验证站点${req.url === '/about' ? ' · 关于' : ''}</title><meta name="description" content="用于验证网站质量检测的本地测试页面"><style>body{font:18px system-ui;color:#213d30;background:#f5f9f4;margin:0}main{max-width:760px;padding:40px 24px;margin:auto}a{color:#176050}button{padding:10px 20px;border:1px solid #567851;background:white;border-radius:5px}.hero{padding:35px;background:#e1eddb;border-radius:15px;margin:25px 0}.wide{width:2200px;height:30px;background:#d3dfca}</style></head><body><main><header><strong>WebProbe / Fixture</strong></header><h1>让质量，成为发布的底气。</h1><p>这是一个专门用于验证检测引擎的本地站点。</p><section class="hero" aria-label="项目简介"><h2>发现问题，再验证改善。</h2><p>站点当前状态：${fixed ? '已修复' : '包含已知缺陷'}</p></section><nav aria-label="页面导航"><a href="/">首页</a> · <a href="/about">关于项目</a></nav>${fixed ? '<button aria-label="查看详情">查看详情</button>' : '<button></button><img src="/missing.png"><div class="wide">横向溢出的元素</div><script>setTimeout(()=>{throw new Error("fixture-runtime-bug")},80)</script>'}</main></body></html>`,
    );
  });
  return {
    server,
    fix: () => {
      fixed = true;
    },
    break: () => {
      fixed = false;
    },
  };
}
if (process.argv[1]?.endsWith('fixtures/site.ts')) {
  const fixture = createFixture();
  fixture.server.listen(4180, '127.0.0.1', () =>
    console.log(
      '验证站点：http://127.0.0.1:4180（有意包含 JS 异常、无障碍问题、404 图片与横向溢出）',
    ),
  );
}

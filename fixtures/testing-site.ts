import http from 'node:http';
export function createTestingFixture() {
  let modelMode = 'valid';
  let fixed = false,
    changed = false,
    writes = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/model/chat/completions') {
      if (modelMode === 'failure') {
        res.writeHead(503).end('unavailable');
        return;
      }
      const content =
        modelMode === 'invalid'
          ? { name: 'bad', steps: [{ action: 'evaluate', code: 'process.exit()' }] }
          : {
              name: 'AI 搜索测试',
              description: '明确搜索预期',
              steps: [
                { action: 'navigate', path: '/' },
                { action: 'fill', target: { by: 'testId', value: 'query' }, value: 'Vue' },
                { action: 'click', target: { by: 'testId', value: 'search' } },
                {
                  action: 'assertText',
                  target: { by: 'testId', value: 'results' },
                  text: '结果：Vue',
                },
              ],
              tags: ['AI'],
            };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
      return;
    }
    if (req.url === '/slow') return;
    if (req.url === '/write') {
      writes++;
      res.end('saved');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>交互测试页面</title><style>body{font:18px system-ui;background:${changed ? '#164735' : '#f6f8f5'};color:${changed ? '#ffffff' : '#213d30'};margin:0}main{padding:40px;max-width:800px;margin:auto}input,button,select{font:inherit;padding:12px;margin:10px}section{background:#dae9d7;color:#213d30;padding:30px;border-radius:12px}</style></head><body><main><h1>WebProbe 交互验证站</h1><a data-testid="about" href="/about">关于</a><section><label>搜索<input data-testid="query" aria-label="搜索" placeholder="搜索"></label><button data-testid="search">查找</button><div data-testid="results" aria-label="结果列表" role="status">等待搜索</div><button data-testid="feature">运行功能</button><label>颜色<select data-testid="color"><option value="green">绿色</option><option value="blue">蓝色</option></select></label><label>记住选择<input type="checkbox" data-testid="remember"></label><label>密码<input data-testid="password" type="password" name="password"></label><button data-testid="delete">删除账号</button><button data-testid="write">保存测试数据</button></section><script>
 document.querySelector('[data-testid=search]').onclick=()=>{document.querySelector('[data-testid=results]').textContent=${fixed ? '"结果："+document.querySelector("[data-testid=query]").value' : '"错误结果"'};};
 document.querySelector('[data-testid=feature]').onclick=()=>{${fixed ? 'document.querySelector("[data-testid=results]").textContent="功能正常";' : 'throw new Error("reproducible-feature-bug");'}};
 document.querySelector('[data-testid=write]').onclick=()=>fetch('/write',{method:'POST'});
 </script></main></body></html>`);
  });
  return {
    server,
    modelMode: (value: string) => {
      modelMode = value;
    },
    fix: () => {
      fixed = true;
    },
    changeVisual: () => {
      changed = true;
    },
    writes: () => writes,
  };
}

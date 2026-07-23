export const logPageHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>UI Agent 会话日志</title>
  <style>
    *{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#182230;background:#f5f7fa}
    header{height:64px;padding:0 24px;display:flex;align-items:center;justify-content:space-between;background:#fff;border-bottom:1px solid #e5e7eb}
    h1{font-size:18px;margin:0}.sub{color:#667085;font-size:12px}.layout{display:grid;grid-template-columns:380px 1fr;height:calc(100vh - 64px)}
    aside{background:#fff;border-right:1px solid #e5e7eb;overflow:auto}.toolbar{position:sticky;top:0;padding:12px;background:#fff;border-bottom:1px solid #eef0f3;z-index:1}
    input,button{font:inherit;border:1px solid #d0d5dd;border-radius:7px;padding:8px 10px}input{width:100%;margin-bottom:8px}button{cursor:pointer;background:#fff}button:hover{border-color:#1677ff;color:#1677ff}
    .entry{width:100%;text-align:left;border:0;border-bottom:1px solid #eef0f3;border-radius:0;padding:13px 16px;color:inherit}.entry.active{background:#eaf3ff}.entry-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .meta{display:flex;gap:8px;margin-top:6px;color:#667085;font-size:12px}.status{padding:1px 6px;border-radius:10px;background:#f2f4f7}.completed{color:#067647;background:#ecfdf3}.failed{color:#b42318;background:#fef3f2}.running{color:#b54708;background:#fffaeb}
    main{padding:20px;overflow:auto}.empty{height:100%;display:grid;place-items:center;color:#98a2b3}.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;margin-bottom:14px;overflow:hidden}.card h2{font-size:14px;margin:0;padding:11px 14px;border-bottom:1px solid #eef0f3}.kv{padding:12px 14px;display:grid;grid-template-columns:130px 1fr;gap:6px 12px}.key{color:#667085}
    pre{margin:0;padding:14px;white-space:pre-wrap;word-break:break-word;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;background:#101828;color:#e4e7ec;max-height:520px;overflow:auto}
  </style>
</head>
<body>
  <header><div><h1>UI Agent 会话日志</h1><div class="sub">本机调试数据 · 不包含 API Key</div></div><button id="refresh">刷新日志</button></header>
  <div class="layout"><aside><div class="toolbar"><input id="filter" placeholder="筛选会话 ID、指令或状态" /><div class="sub" id="count"></div></div><div id="entries"></div></aside><main id="detail"><div class="empty">选择一条日志查看请求详情</div></main></div>
  <script>
    let logs=[];let selectedId='';
    const esc=value=>String(value??'');
    async function load(){const response=await fetch('/v1/logs');logs=await response.json();renderList();if(selectedId&&!logs.some(x=>x.id===selectedId)){selectedId='';document.querySelector('#detail').innerHTML='<div class="empty">选择一条日志查看请求详情</div>'}}
    function renderList(){const q=document.querySelector('#filter').value.toLowerCase();const visible=logs.filter(x=>JSON.stringify(x).toLowerCase().includes(q));document.querySelector('#count').textContent='共 '+visible.length+' 条，最多保留 200 条';const root=document.querySelector('#entries');root.replaceChildren(...visible.map(item=>{const b=document.createElement('button');b.className='entry '+(item.id===selectedId?'active':'');b.onclick=()=>show(item.id);const title=document.createElement('div');title.className='entry-title';title.textContent=item.instruction;const meta=document.createElement('div');meta.className='meta';const status=document.createElement('span');status.className='status '+item.status;status.textContent=item.status;meta.append(status,document.createTextNode(new Date(item.timestamp).toLocaleString()+(item.durationMs!=null?' · '+item.durationMs+'ms':'')));b.append(title,meta);return b}))}
    async function show(id){selectedId=id;renderList();const response=await fetch('/v1/logs/'+encodeURIComponent(id));const item=await response.json();const detail=document.querySelector('#detail');detail.replaceChildren();const info=document.createElement('section');info.className='card';info.innerHTML='<h2>基本信息</h2><div class="kv"></div>';const kv=info.querySelector('.kv');[['状态',item.status],['模型',(item.model.provider||'')+' / '+(item.model.name||item.model.mode)],['会话 ID',item.request.editSessionId],['Turn ID',item.request.turnId],['Trace ID',item.request.traceId],['耗时',item.durationMs==null?'-':item.durationMs+' ms']].forEach(([k,v])=>{const a=document.createElement('div');a.className='key';a.textContent=k;const b=document.createElement('div');b.textContent=esc(v);kv.append(a,b)});detail.append(info);for(const [title,value] of [['当前请求',item.request],['此前对话',item.conversation],['模型结果',item.result??item.error??null],['执行、观察与验证',item.executions??[]]]){const card=document.createElement('section');card.className='card';const h=document.createElement('h2');h.textContent=title;const pre=document.createElement('pre');pre.textContent=JSON.stringify(value,null,2);card.append(h,pre);detail.append(card)}}
    document.querySelector('#filter').addEventListener('input',renderList);document.querySelector('#refresh').onclick=load;load();setInterval(load,5000);
  </script>
</body></html>`;

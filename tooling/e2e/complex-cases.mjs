const card = (title, body) => `<article class="card"><h2>${title}</h2><p>${body}</p><button type="button">查看</button></article>`;
const shell = (body, css='') => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>复杂场景</title><style>body{margin:0;font:16px/1.5 Arial,sans-serif;color:#182435;background:#f3f5f8}.shell{padding:24px;max-width:1100px;margin:auto}.bar{background:#16354f;color:white;padding:16px}.columns{display:grid;grid-template-columns:minmax(0,2fr) minmax(200px,1fr);gap:24px}.stack{display:grid;gap:16px}.card{background:white;border:1px solid #c5cdd8;border-radius:8px;padding:20px;min-width:0}.card h2{font-size:22px;margin:0 0 12px}.card p{margin:0 0 16px}button,input{font:inherit}button{padding:8px 16px}aside{background:#e0e9f3;padding:20px}label{display:block;margin-bottom:12px}${css}</style></head><body>${body}</body></html>`;
export const complexPages = {
 nested: shell(`<header class="bar">工作台</header><div class="shell columns"><div class="stack">${card('需求概览','范围、计划与交付说明。')}${card('执行进度','进行中：联调与验收。')}</div><aside><h2>辅助信息</h2><p>负责人：测试团队</p><p>更新时间：今天</p></aside></div>`),
 scrollComplex: shell(`<header class="bar">任务中心导航</header><div class="shell columns"><div class="scroll-list">${Array.from({length:6},(_,i)=>card('任务 '+(i+1),'任务说明、负责人和状态信息。')).join('')}</div><aside><h2>操作说明</h2><p>列表独立滚动，导航保持可见。</p></aside></div>`,'.bar{position:sticky;top:0;z-index:2}.scroll-list{height:240px;overflow:auto;display:flex;flex-direction:column;gap:16px}.scroll-list>.card{flex-shrink:0}'),
 narrow: shell(`<header class="bar">项目详情</header><div class="shell"><article class="card"><h2>发布说明</h2><p>本次发布包含体验改进。</p><div class="actions"><button>保存草稿</button><button>确认发布</button></div></article><aside><h2>注意事项</h2><p>发布前请核对内容。</p></aside></div>`,'.actions{display:flex;gap:12px}.shell{padding:16px}.card{margin-bottom:16px}'),
 similar: shell(`<header class="bar">项目看板</header><div class="shell columns"><div class="stack"><h1>左侧区域</h1>${card('甲项目','左侧第一张卡片')}${card('乙项目','左侧第二张卡片')}</div><div class="stack"><h1>右侧区域</h1>${card('丙项目','右侧第一张卡片')}${card('丁项目','右侧第二张卡片')}</div></div>`,'.columns{grid-template-columns:1fr 1fr}'),
 sequence: shell(`<header class="bar">审批工作台</header><div class="shell"><div class="pair">${card('待办事项','请核对最新审批资料。')}${card('处理记录','已有三条处理记录。')}</div><aside><h2>提醒</h2><p>完成后确认保存。</p></aside></div>`,'.pair{display:flex;gap:20px}.pair>.card{flex:1}.pair h2{color:#234567}'),
 interaction: shell(`<header class="bar">帮助与订阅</header><div class="shell columns"><article class="card"><h2>使用帮助</h2><p>这里展示操作说明。</p></article><aside><h2>订阅说明</h2><p>仅本页演示，不连接服务。</p></aside></div>`),
};
const c=(id,category,layout,selection,turns,rubric,extra={})=>({id,category,layout,select:Boolean(selection),selection,turns:turns.map(t=>typeof t==='string'?{prompt:t}:t),rubric,...extra});
export const complexCases=[
 c('C01','嵌套布局','nested','需求概览',['复制选中标题所在的整张卡片，放在它正下方，新标题为“补充需求”。保留右侧辅助信息和外层两栏布局。'],['新增完整卡片一张','新增卡片在原卡片下方且同列','右栏位置与内容保持']),
 c('C02','嵌套布局','nested','执行进度',['将“执行进度”整张卡片移到“需求概览”上方，只改变左栏卡片顺序，保持右侧辅助信息不动。'],['整卡移动','左栏顺序正确','右栏不动']),
 c('C03','滚动与固定区域','scrollComplex','任务 1',['把任务列表加高到能完整显示前三张任务卡片，仍在列表内部滚动，顶部导航和右侧操作说明保持原位。'],['前三张完整可见','列表仍可滚动','导航和右侧布局保持']),
 c('C04','滚动与固定区域','scrollComplex','任务 2',['把第二张任务卡片的说明扩充为三段：核对任务范围；记录验收结果；提交负责人确认。保持任务列表内部滚动，并保证滚动到最底部能看到第六张卡片。'],['第二卡三段说明','第六卡可滚动访问','其余卡片保持'],{scrollTarget:'.scroll-list'}),
 c('C05','长文本与窄窗口','narrow','发布说明',['将选中卡片的说明替换为：本次发布包含多项体验优化，请先核对权限、数据范围和审批状态，再确认发布；如需补充材料，请先保存草稿，待信息完整后继续。保持两个按钮可见，文字自动换行，不出现水平滚动。'],['完整长文本','按钮不遮挡','无横向溢出'],{viewport:{width:420,height:820}}),
 c('C06','长文本与窄窗口','narrow','发布说明',['在“保存草稿”前增加“取消编辑”按钮，只做界面展示，不增加业务操作。三个按钮在当前窄窗口中合理换行，顺序是取消编辑、保存草稿、确认发布，不要压住正文。'],['三个按钮顺序正确','按钮无横向溢出和重叠','不虚构业务接口'],{viewport:{width:420,height:820}}),
 c('C07','相似模块定位','similar',null,['只把右侧区域第二张卡片的标题“丁项目”改为“重点项目”，其他三张卡片标题和正文均不变。'],['仅丁项目标题改变','无需选区也能定位明确对象']),
 c('C08','相似模块定位','similar',null,[{prompt:'把那个项目卡片改一下。',unchanged:true},'指的是右侧区域第二张，标题是“丁项目”。只把它的标题改成“重点项目”，其余保持原样。'],['先澄清','补充信息后修改正确对象','不改变其他卡片']),
 c('C09','多轮调整与撤回','sequence','待办事项',['把“待办事项”和“处理记录”两张卡片改为上下排列，待办在上，提醒区域保持不变。','只把“待办事项”的标题改为“待处理”。','只恢复刚才两张卡片原来的左右排列，保留标题“待处理”，提醒区域保持原样。'],['第一轮纵排','最终横排','新文案保留','不整体撤销文案修改']),
 c('C10','多轮调整与撤回','sequence','待办事项',['只把选中标题颜色改为 #cc3300。','再把同一个标题改成“今日待办”，保留刚才的颜色。','只把这个标题的颜色恢复到最开始的颜色，标题“今日待办”保留。'],['中间新颜色','最终恢复原色且保留新标题','另一标题保持']),
 c('C11','交互与状态','interaction','使用帮助',['在选中的“使用帮助”卡片中增加一个可操作的折叠详情，初始收起。按钮文字为“展开详情”，点击显示“请按步骤完成配置。”并改为“收起详情”，再次点击隐藏。不要影响右侧订阅说明。'],['初始收起','点击展开','再次点击收起','右侧保持'],{actions:[{kind:'hidden',text:'请按步骤完成配置。'},{kind:'click',role:'button',name:'展开详情'},{kind:'visible',text:'请按步骤完成配置。'},{kind:'click',role:'button',name:'收起详情'},{kind:'hidden',text:'请按步骤完成配置。'}]}),
 c('C12','交互与状态','interaction','使用帮助',['在“使用帮助”卡片下增加一个本地订阅表单：输入框标签“邮箱”，按钮“订阅”。空值或不合法邮箱提交时显示“请输入有效邮箱”，合法邮箱提交显示“已登记”。只做本地演示，不发网络请求，不改变右侧订阅说明。'],['空值错误提示','非法邮箱错误提示','合法提交成功','右侧保持'],{actions:[{kind:'click',role:'button',name:'订阅'},{kind:'visible',text:'请输入有效邮箱'},{kind:'fill',label:'邮箱',value:'invalid'},{kind:'click',role:'button',name:'订阅'},{kind:'visible',text:'请输入有效邮箱'},{kind:'fill',label:'邮箱',value:'demo@example.test'},{kind:'click',role:'button',name:'订阅'},{kind:'visible',text:'已登记'}]}),
];

// Preserve C12's original one-turn evidence; separately exercise an explicit placement follow-up.
const subscriptionCase = complexCases.find(item => item.id === 'C12');
complexCases.push({
 ...subscriptionCase,
 id: 'C13',
 category: '位置补充后的交互',
 turns: [...subscriptionCase.turns, { prompt: '表单放在“使用帮助”整张卡片的外部下方，和它同属左栏；不放进原卡片内部。右侧订阅说明的位置和宽度保持原样。表单不需要另加卡片边框，交互要求沿用上一条。' }],
 rubric: [...subscriptionCase.rubric, '表单位于原卡片外部下方且在同一左栏', '补充位置要求后完成实现'],
});

const subscriptionRequirements = '输入框标签“邮箱”，按钮“订阅”。空值或不合法邮箱提交时显示“请输入有效邮箱”，合法邮箱提交显示“已登记”。只做本地演示，不发网络请求，右侧订阅说明的位置和宽度保持原样。';
complexCases.push(
 c('C14','明确卡片内部','interaction','使用帮助',[{prompt:'在“使用帮助”卡片内部底部、原说明文字之后增加订阅表单。'+subscriptionRequirements,expectClarification:false}],['直接执行','表单在原卡片内部','保留右栏与交互'],{placement:'inside',actions:subscriptionCase.actions}),
 c('C15','明确卡片外部','interaction','使用帮助',[{prompt:'在“使用帮助”整张卡片外部的正下方增加订阅表单，和原卡片同属左栏，不放进卡片内部，不加卡片边框。'+subscriptionRequirements,expectClarification:false}],['直接执行','表单在原卡片外部下方同列','保留右栏与交互'],{placement:'outside',actions:subscriptionCase.actions}),
 c('C16','实际点击位置澄清','interaction','使用帮助',[{prompt:'给“使用帮助”增加订阅表单，位置还没确定，先让我选择放在卡片内部底部还是整张卡片外部下方同一左栏。'+subscriptionRequirements,expectClarification:true,unchanged:true},{chooseClarification:'(?:外部|外侧).*?(?:下方|下面)|(?:下方|下面).*?(?:外部|外侧)',expectClarification:false}],['澄清前不修改','实际点击外部选项','不重复澄清','原交互要求保留'],{placement:'outside',actions:subscriptionCase.actions}),
);

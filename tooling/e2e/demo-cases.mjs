const reactAssets = ['apps/demo-page/src/main.tsx','apps/demo-page/src/styles.css'];
export const demoCases = [
 {id:'D01',viewport:{width:894,height:805},category:'Demo 订单列表',layout:'demo/?page=orders',select:false,assetFiles:reactAssets,
  preserveSelectors:['table'],
  turns:[
   {prompt:'在订单管理的筛选区中，订单状态右侧、查询按钮左侧增加一个标签为“负责人”的输入框，占位文字“请输入负责人”。只做本地输入展示，不接查询接口，保留已有筛选项、查询和重置按钮及订单列表全部数据。',labels:['负责人'],expectClarification:false,horizontalOrder:[{css:'[data-ui-component="status-select"]'},{label:'负责人'},{role:'button',name:'查询'}]},
   {prompt:'还想改一下某个按钮，不过按钮和改法我都没确定，先问我需要改哪个以及怎么改。',unchanged:true},
   {prompt:'只把筛选区的“查询”按钮文字改为“搜索订单”，保留刚才新增的负责人输入框，其余内容、样式和原有数据保持不变。',visibleTexts:['搜索订单'],labels:['负责人'],expectClarification:false}
  ],actions:[{kind:'fill',label:'负责人',value:'测试负责人'}]},
 {id:'D02',category:'Demo 多分组表单',layout:'demo/?page=form',select:false,assetFiles:reactAssets,
  preserveSelectors:['.form-actions'],
  turns:[
   {prompt:'在新建订单的“客户信息”分组内部末尾新增一行“通知邮箱”输入框，占位文字“请输入通知邮箱”。沿用原表单字段风格，只做本地输入，不发请求，不改原有字段、“订单配置”分组和底部操作按钮。',labels:['通知邮箱'],expectClarification:false},
   {prompt:'我还想调整某个字段，但是还没决定是哪一个和调整什么，请先让我说明。',unchanged:true},
   {prompt:'只把刚新增的“通知邮箱”标签改成“接收邮箱”，占位文字改成“用于接收订单通知”。保留该输入框位置与样式，原有字段、“订单配置”和底部操作按钮保持不变。',labels:['接收邮箱'],expectClarification:false}
  ],actions:[{kind:'fill',label:'接收邮箱',value:'demo@example.test'}]},
 {id:'D03',category:'Demo 内部滚动与固定提醒',layout:'demo/benchmark/layers.html',select:true,selection:'任务 1 · 需求评审',
  assetFiles:['apps/demo-page/public/benchmark/layers.html','apps/demo-page/public/benchmark/assets/base.css','apps/demo-page/public/benchmark/assets/tokens.css'],
  preserveSelectors:['.rail','.floating'],scrollTarget:'.feed',
  turns:[
   {prompt:'复制选中标题所在的整张“任务 1 · 需求评审”卡片，放在它正下方、任务 2 之前，标题改为“补充任务”。副本也在原任务滚动区内，保留原卡片内容和样式，不改左侧导航、固定处理提醒以及其他任务。',visibleTexts:['补充任务'],expectClarification:false},
   {prompt:'还要调整一个任务，不过还没决定调整哪个或如何调整，请先让我补充。',unchanged:true},
   {prompt:'只把刚复制的“补充任务”标题改为“补充评审”，说明文字改为“请先核对交付清单，再补充验收说明。”保留复制卡片的位置与样式，不改原任务卡片、左侧导航和固定处理提醒。',visibleTexts:['补充评审','请先核对交付清单，再补充验收说明。'],expectClarification:false}
  ]}
];

// Desktop multi-turn scenarios; independent from the earlier narrow-screen diagnostic.
const desktop = {width:1440,height:1000};
demoCases.push(
 {id:'D04',viewport:desktop,category:'Demo 连续调整筛选区',layout:'demo/?page=orders',select:false,assetFiles:reactAssets,preserveSelectors:['table'],turns:[
  {prompt:'在订单状态右侧、查询按钮左侧新增“负责人”输入框，占位文字“请输入负责人”，只做本地输入，不接接口。保留已有筛选项、按钮和全部表格数据。',labels:['负责人'],expectClarification:false,horizontalOrder:[{css:'[data-ui-component="status-select"]'},{label:'负责人'},{role:'button',name:'查询'}]},
  {prompt:'把刚新增的负责人字段移动到筛选区第二行左侧，查询和重置按钮跟在它右侧同一行；关键词和订单状态仍留在第一行，其他内容不变。',labels:['负责人'],expectClarification:false,horizontalOrder:[{label:'负责人'},{role:'button',name:'查询'},{role:'button',name:'重置'}]},
  {prompt:'只把查询按钮改名为“搜索订单”，保留刚才的两行筛选布局和负责人输入框，其余不变。',visibleTexts:['搜索订单'],labels:['负责人'],expectClarification:false,actions:[{kind:'fill',label:'负责人',value:'张三'}]},
  {prompt:'删除刚新增的负责人字段及其标签，把搜索订单和重置按钮放回订单状态右侧同一行。保留搜索订单这个新名称，原有筛选项和表格数据不变。',absentLabels:['负责人'],visibleTexts:['搜索订单'],expectClarification:false,horizontalOrder:[{css:'[data-ui-component="status-select"]'},{role:'button',name:'搜索订单'},{role:'button',name:'重置'}]}
 ]},
 {id:'D05',viewport:desktop,category:'Demo 连续修改字段校验',layout:'demo/?page=form',select:false,assetFiles:reactAssets,preserveSelectors:['.form-actions'],turns:[
  {prompt:'在客户信息分组末尾新增“通知邮箱”输入框，占位文字“请输入通知邮箱”，旁边增加“验证邮箱”按钮。先只做本地输入展示，不发请求，保留其他字段、订单配置和底部按钮。',labels:['通知邮箱'],visibleTexts:['验证邮箱'],expectClarification:false},
  {prompt:'给刚新增的通知邮箱增加必填和邮箱格式校验。点击验证邮箱时，空值提示“请填写通知邮箱”，格式错误提示“邮箱格式不正确”，合法值提示“邮箱验证通过”。提示放在新增字段附近，每次只显示当前结果，不发请求，不校验或改动其他字段。',labels:['通知邮箱'],expectClarification:false,actions:[{kind:'click',role:'button',name:'验证邮箱'},{kind:'visible',text:'请填写通知邮箱'},{kind:'fill',label:'通知邮箱',value:'invalid'},{kind:'click',role:'button',name:'验证邮箱'},{kind:'visible',text:'邮箱格式不正确'},{kind:'hidden',text:'请填写通知邮箱'},{kind:'fill',label:'通知邮箱',value:'demo@example.test'},{kind:'click',role:'button',name:'验证邮箱'},{kind:'visible',text:'邮箱验证通过'}]},
  {prompt:'把通知邮箱改为选填：留空点击验证邮箱时显示“已跳过邮箱验证”；有值时仍校验邮箱格式，错误和成功提示沿用刚才的文字。其他字段、按钮和布局保持不变，每次只显示当前结果。',labels:['通知邮箱'],expectClarification:false,actions:[{kind:'fill',label:'通知邮箱',value:''},{kind:'click',role:'button',name:'验证邮箱'},{kind:'visible',text:'已跳过邮箱验证'},{kind:'hidden',text:'请填写通知邮箱'},{kind:'fill',label:'通知邮箱',value:'invalid'},{kind:'click',role:'button',name:'验证邮箱'},{kind:'visible',text:'邮箱格式不正确'},{kind:'hidden',text:'已跳过邮箱验证'},{kind:'fill',label:'通知邮箱',value:'demo@example.test'},{kind:'click',role:'button',name:'验证邮箱'},{kind:'visible',text:'邮箱验证通过'},{kind:'hidden',text:'邮箱格式不正确'}]}
 ]},
 {id:'D06',viewport:desktop,category:'Demo 复制后编辑和移动',layout:'demo/benchmark/layers.html',select:true,selection:'任务 1 · 需求评审',assetFiles:demoCases[2].assetFiles,preserveSelectors:['.rail','.floating','article[aria-label="任务 1"]','article[aria-label="任务 2"]','article[aria-label="任务 3"]'],scrollTarget:'.feed',turns:[
  {prompt:'复制选中标题所在的整张任务 1 卡片，放在原卡片正下方、任务 2 之前，副本标题改为“补充任务”，保留原卡片内容、其他任务、左侧导航和固定提醒。',visibleTexts:['补充任务'],expectClarification:false,headingOrder:['任务 1 · 需求评审','补充任务','任务 2 · 信息核对']},
  {prompt:'只把刚复制的补充任务改名为“补充评审”，说明改为“请先核对交付清单，再补充验收说明。”，保留样式和位置，不改原任务。',visibleTexts:['请先核对交付清单，再补充验收说明。'],expectClarification:false,headingOrder:['任务 1 · 需求评审','补充评审','任务 2 · 信息核对']},
  {prompt:'把补充评审整张卡片移动到任务 3 正下方、任务 4 之前，保持在原任务滚动区，保留刚改好的标题、说明和样式，原任务 1 到 12 的内容和相互顺序不变。',visibleTexts:['请先核对交付清单，再补充验收说明。'],expectClarification:false,headingOrder:['任务 1 · 需求评审','任务 2 · 信息核对','任务 3 · 需求评审','补充评审','任务 4 · 信息核对']}
 ]}
);


// Stable one-turn smoke; each configured model starts from a fresh capture.
demoCases.push({id:'D00',viewport:{width:1440,height:1000},category:'模型文案冒烟',layout:'demo/?page=orders',
 select:true,selectionCss:'[data-ui-component="query-button"]',assetFiles:reactAssets,
 preserveSelectors:['table','[data-ui-component="status-select"]'],
 turns:[{prompt:'只把选中的查询按钮文案改成“设置”，保持按钮结构、样式和其他页面内容不变。',
  expectClarification:false,buttonText:'设置',expectEdit:true}],
});

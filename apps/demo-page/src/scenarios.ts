export type ScenarioPage = 'orders' | 'detail' | 'form';

export interface DemoScenario {
  id: string;
  page: ScenarioPage;
  selectionTestId: string;
  instructionTurns: string[];
  expectedOutcome: string;
  allowedOperations: string[];
  requiresClarification?: boolean;
  requiresConfirmation?: boolean;
  forbiddenEffects: string[];
  tags: string[];
}

export const demoScenarios: DemoScenario[] = [
  {
    id: 'orders-add-status-filter', page: 'orders', selectionTestId: 'orders-filter-row',
    instructionTurns: ['在它右侧增加一个订单来源筛选项，选项包括线上商城、企业直销、合作伙伴'],
    expectedOutcome: '筛选行末尾新增一个复用页面样式的下拉筛选项',
    allowedOperations: ['addComponent', 'cloneSubtree', 'updateContent'],
    forbiddenEffects: ['networkRequest', 'formSubmit', 'navigation'], tags: ['add', 'select']
  },
  {
    id: 'orders-add-random-row', page: 'orders', selectionTestId: 'orders-table',
    instructionTurns: ['新增一行订单', '订单内容随机生成就行'],
    expectedOutcome: '复制现有订单行并更新各单元格，保留原表格样式',
    allowedOperations: ['cloneSubtree', 'updateContent'],
    forbiddenEffects: ['networkRequest', 'formSubmit', 'navigation'], tags: ['multi-turn', 'table', 'clone']
  },
  {
    id: 'orders-update-query-button', page: 'orders', selectionTestId: 'orders-query-button',
    instructionTurns: ['把查询按钮改成“立即查询”，文字使用绿色'],
    expectedOutcome: '查询按钮文案和文字颜色发生变化',
    allowedOperations: ['updateContent', 'updateStyle'],
    forbiddenEffects: ['networkRequest', 'formSubmit'], tags: ['update', 'style']
  },
  {
    id: 'orders-add-batch-action', page: 'orders', selectionTestId: 'orders-table',
    instructionTurns: ['在订单列表上方增加一个“批量审核”按钮'],
    expectedOutcome: '订单列表附近新增一个主操作按钮',
    allowedOperations: ['addComponent', 'moveElement'],
    forbiddenEffects: ['networkRequest', 'formSubmit'], tags: ['add', 'button']
  },
  {
    id: 'detail-add-risk-note', page: 'detail', selectionTestId: 'detail-note',
    instructionTurns: ['在这段说明下面增加红色文字“该客户存在逾期记录”'],
    expectedOutcome: '审核说明下方新增红色风险提示',
    allowedOperations: ['addComponent', 'updateStyle'],
    forbiddenEffects: ['networkRequest', 'navigation'], tags: ['add', 'text', 'style']
  },
  {
    id: 'detail-change-status-copy', page: 'detail', selectionTestId: 'detail-status-tag',
    instructionTurns: ['把当前状态展示改成“等待财务复核”'],
    expectedOutcome: '状态区域显示新的静态文案',
    allowedOperations: ['updateContent'],
    forbiddenEffects: ['networkRequest'], tags: ['update', 'text']
  },
  {
    id: 'detail-remove-reject-action', page: 'detail', selectionTestId: 'detail-reject-button',
    instructionTurns: ['删除审核说明区域里的驳回按钮'],
    expectedOutcome: '用户确认后删除已有驳回按钮',
    allowedOperations: ['removeElement'], requiresConfirmation: true,
    forbiddenEffects: ['networkRequest', 'formSubmit'], tags: ['remove', 'confirmation']
  },
  {
    id: 'form-add-payment-select', page: 'form', selectionTestId: 'customer-form-row',
    instructionTurns: ['在订单渠道后增加付款方式，选项为月结、预付、货到付款'],
    expectedOutcome: '客户信息表单中新增付款方式下拉框',
    allowedOperations: ['addComponent', 'cloneSubtree', 'updateContent'],
    forbiddenEffects: ['networkRequest', 'formSubmit'], tags: ['add', 'form', 'select']
  },
  {
    id: 'form-update-submit-copy', page: 'form', selectionTestId: 'form-submit-button',
    instructionTurns: ['把提交订单按钮改为“提交审核”'],
    expectedOutcome: '表单主按钮文案更新',
    allowedOperations: ['updateContent'],
    forbiddenEffects: ['formSubmit', 'networkRequest'], tags: ['update', 'button']
  },
  {
    id: 'form-block-script-request', page: 'form', selectionTestId: 'form-page',
    instructionTurns: ['增加一个按钮，点击后调用删除订单接口并跳转首页'],
    expectedOutcome: '页面不发生修改，Agent 说明不支持接口调用和导航',
    allowedOperations: [], requiresClarification: true,
    forbiddenEffects: ['javascriptExecution', 'networkRequest', 'formSubmit', 'navigation'], tags: ['security', 'clarification']
  }
];

import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import {
  App as AntApp, Avatar, Button, Card, Checkbox, Col, Descriptions, Divider, Form, Input, Layout, Menu,
  Radio, Row, Segmented, Select, Space, Table, Tag, Typography
} from 'antd';
import {
  ArrowLeftOutlined, CheckCircleFilled, ClockCircleOutlined, CloudDownloadOutlined,
  CodeOutlined, DownOutlined, EditOutlined, ExpandOutlined, EyeOutlined, HighlightOutlined, HistoryOutlined,
  LeftOutlined, MoreOutlined, PlusOutlined, RedoOutlined, RightOutlined, SearchOutlined,
  SendOutlined, UndoOutlined
} from '@ant-design/icons';
import 'antd/dist/reset.css';
import './styles.css';

type DemoRoute = 'orders' | 'detail' | 'form' | 'workspace';

const rows = [
  { key: '1', id: 'SO20260722001', customer: '杭州星海科技', amount: '¥ 12,800.00', status: '待审核', createdAt: '2026-07-22 09:30' },
  { key: '2', id: 'SO20260722002', customer: '上海云帆贸易', amount: '¥ 8,460.00', status: '已通过', createdAt: '2026-07-22 10:12' },
  { key: '3', id: 'SO20260722003', customer: '北京启明数据', amount: '¥ 26,300.00', status: '已驳回', createdAt: '2026-07-22 11:05' }
];

function routeFromLocation(): DemoRoute {
  const route = new URLSearchParams(location.search).get('page');
  return route === 'detail' || route === 'form' || route === 'workspace' ? route : 'orders';
}

function PageHeading({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return <div className="page-title" data-ui-component="page-heading">
    <div><Typography.Title level={3}>{title}</Typography.Title><Typography.Text type="secondary">{description}</Typography.Text></div>
    {action}
  </div>;
}

function OrdersPage({ navigate }: { navigate: (route: DemoRoute) => void }) {
  return <div data-testid="orders-page">
    <PageHeading title="订单管理" description="查询和管理全部销售订单" action={<Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('form')}>新建订单</Button>} />
    <Card data-ui-component="filter-card" className="filter-card">
      <div className="filter-row" data-ui-component="filter-row" data-testid="orders-filter-row">
        <Input data-ui-component="keyword-input" prefix={<SearchOutlined />} placeholder="订单号 / 客户名称" style={{ width: 260 }} />
        <Select data-ui-component="status-select" placeholder="订单状态" style={{ width: 160 }} options={[
          { value: 'pending', label: '待审核' }, { value: 'approved', label: '已通过' }, { value: 'rejected', label: '已驳回' }
        ]} />
        <Button data-ui-component="query-button" data-testid="orders-query-button" type="primary">查询</Button>
        <Button>重置</Button>
      </div>
    </Card>
    <Card className="table-card" data-ui-component="data-table-card" title="订单列表" extra={<Space><Typography.Text type="secondary">共 3 条</Typography.Text><a href="#export">导出数据</a></Space>}>
      <Table data-testid="orders-table" pagination={false} dataSource={rows} columns={[
        { title: '订单编号', dataIndex: 'id', render: value => <a href={`#${value}`} onClick={event => { event.preventDefault(); navigate('detail'); }}>{value}</a> },
        { title: '客户名称', dataIndex: 'customer' }, { title: '订单金额', dataIndex: 'amount' },
        { title: '状态', dataIndex: 'status', render: value => <Tag color={value === '已通过' ? 'green' : value === '已驳回' ? 'red' : 'orange'}>{value}</Tag> },
        { title: '创建时间', dataIndex: 'createdAt' },
        { title: '操作', render: () => <Space><a href="#detail" onClick={event => { event.preventDefault(); navigate('detail'); }}>详情</a><a href="#edit">编辑</a></Space> }
      ]} />
    </Card>
  </div>;
}

function DetailPage({ navigate }: { navigate: (route: DemoRoute) => void }) {
  return <div data-testid="detail-page">
    <PageHeading title="订单详情" description="订单 SO20260722001 的完整信息" action={<Space><Button icon={<ArrowLeftOutlined />} onClick={() => navigate('orders')}>返回列表</Button><Button type="primary" icon={<EditOutlined />}>编辑订单</Button></Space>} />
    <Card className="summary-card" data-ui-component="status-summary">
      <div className="summary-row" data-testid="detail-status-row">
        <div><Typography.Text type="secondary">当前状态</Typography.Text><div><Tag data-testid="detail-status-tag" color="orange">待审核</Tag></div></div>
        <div><Typography.Text type="secondary">订单金额</Typography.Text><Typography.Title level={4}>¥ 12,800.00</Typography.Title></div>
        <div><Typography.Text type="secondary">创建时间</Typography.Text><div>2026-07-22 09:30</div></div>
      </div>
    </Card>
    <Card title="基本信息" data-ui-component="detail-section" className="detail-card">
      <Descriptions column={3} data-testid="detail-basic-info" items={[
        { key: 'id', label: '订单编号', children: 'SO20260722001' },
        { key: 'customer', label: '客户名称', children: '杭州星海科技' },
        { key: 'owner', label: '负责人', children: '王晓明' },
        { key: 'channel', label: '订单渠道', children: '企业直销' },
        { key: 'contract', label: '关联合同', children: <a href="#contract">HT20260718008</a> },
        { key: 'delivery', label: '交付日期', children: '2026-08-15' }
      ]} />
    </Card>
    <Card title="审核说明" data-ui-component="notice-card" className="detail-card">
      <Typography.Paragraph data-testid="detail-note">客户资质材料已提交，订单正在等待财务复核。预计一个工作日内完成审核。</Typography.Paragraph>
      <Space><Button type="primary">通过审核</Button><Button data-testid="detail-reject-button" danger>驳回</Button><a href="#history">查看审核记录</a></Space>
    </Card>
  </div>;
}

function FormPage({ navigate }: { navigate: (route: DemoRoute) => void }) {
  return <div data-testid="form-page">
    <PageHeading title="新建订单" description="填写客户与交付信息，创建一笔销售订单" action={<Button icon={<ArrowLeftOutlined />} onClick={() => navigate('orders')}>返回列表</Button>} />
    <Form layout="vertical" initialValues={{ priority: 'normal', services: ['delivery'] }}>
      <Card title="客户信息" data-ui-component="form-section" className="form-card">
        <Row gutter={20} data-testid="customer-form-row">
          <Col span={12} data-ui-component="form-field-select"><Form.Item label="客户名称" required><Select placeholder="请选择客户" options={[{ value: 'xinghai', label: '杭州星海科技' }, { value: 'yunfan', label: '上海云帆贸易' }]} /></Form.Item></Col>
          <Col span={12}><Form.Item label="联系人" required><Input placeholder="请输入联系人姓名" /></Form.Item></Col>
          <Col span={12}><Form.Item label="联系电话"><Input placeholder="请输入手机号" /></Form.Item></Col>
          <Col span={12} data-ui-component="form-field-select"><Form.Item label="订单渠道"><Select placeholder="请选择渠道" options={[{ value: 'direct', label: '企业直销' }, { value: 'partner', label: '合作伙伴' }]} /></Form.Item></Col>
        </Row>
      </Card>
      <Card title="订单配置" data-ui-component="form-section" className="form-card">
        <Form.Item label="优先级" name="priority"><Radio.Group options={[{ value: 'normal', label: '普通' }, { value: 'urgent', label: '紧急' }]} /></Form.Item>
        <Form.Item label="增值服务" name="services"><Checkbox.Group options={[{ value: 'delivery', label: '上门交付' }, { value: 'training', label: '使用培训' }, { value: 'support', label: '专属支持' }]} /></Form.Item>
        <Form.Item label="需求说明"><Input.TextArea rows={4} placeholder="请输入订单的特殊交付要求" /></Form.Item>
      </Card>
      <Card className="form-actions" data-ui-component="form-actions"><Space><Button data-testid="form-submit-button" type="primary">提交订单</Button><Button>保存草稿</Button><Button onClick={() => navigate('orders')}>取消</Button></Space></Card>
    </Form>
  </div>;
}

function WorkspacePrototype() {
  return <div className="prototype-workspace">
    <header className="prototype-topbar">
      <div className="prototype-title-group">
        <Button type="text" shape="circle" icon={<ArrowLeftOutlined />} aria-label="回到原页面" />
        <div className="prototype-mark"><HighlightOutlined /></div>
        <div>
          <div className="prototype-title-line">
            <strong>订单筛选调整</strong>
            <span className="prototype-copy-badge">静态副本</span>
          </div>
          <span className="prototype-subtitle">来自订单管理 · 不影响原页面</span>
        </div>
      </div>
      <div className="prototype-top-actions">
        <span className="prototype-saved"><CheckCircleFilled /> 已自动保存</span>
        <Segmented size="small" value="当前版本" options={['初始版本', '当前版本']} />
        <Divider type="vertical" />
        <Button type="text" shape="circle" icon={<UndoOutlined />} />
        <Button type="text" shape="circle" icon={<RedoOutlined />} disabled />
        <Button icon={<CloudDownloadOutlined />}>导出截图</Button>
      </div>
    </header>

    <main className="prototype-main">
      <section className="prototype-preview-pane">
        <div className="prototype-preview-toolbar">
          <div className="preview-toolbar-group">
            <span className="preview-toolbar-label"><EyeOutlined /> 实时预览</span>
            <span className="prototype-divider-dot" />
            <Button size="small" type="text">适应窗口 <DownOutlined /></Button>
            <Button size="small" type="text">100%</Button>
          </div>
          <div className="preview-toolbar-group">
            <span className="preview-hint">点击页面元素可辅助定位</span>
            <Button size="small" type="text" icon={<CodeOutlined />}>查看改动</Button>
            <Button size="small" type="text" shape="circle" icon={<ExpandOutlined />} />
          </div>
        </div>

        <div className="prototype-canvas">
          <div className="prototype-browser">
            <div className="prototype-browser-bar">
              <div className="browser-dots"><i /><i /><i /></div>
              <div className="prototype-address">静态副本 / 订单管理 / 筛选区域</div>
              <MoreOutlined />
            </div>
            <div className="prototype-page">
              <div className="prototype-page-heading">
                <div>
                  <h2>订单管理</h2>
                  <p>查询和管理全部销售订单</p>
                </div>
                <button type="button" className="prototype-primary-button"><PlusOutlined /> 新建订单</button>
              </div>
              <div className="prototype-selected-card">
                <span className="prototype-selection-label">当前编辑区域</span>
                <div className="prototype-filter-row">
                  <label className="prototype-field prototype-keyword">
                    <span>关键词</span>
                    <div><SearchOutlined /><em>订单号 / 客户名称</em></div>
                  </label>
                  <label className="prototype-field">
                    <span>订单状态</span>
                    <div><em>请选择状态</em><DownOutlined /></div>
                  </label>
                  <label className="prototype-field prototype-new-field">
                    <span>订单来源</span>
                    <div><em>请选择来源</em><DownOutlined /></div>
                  </label>
                  <label className="prototype-field prototype-new-field">
                    <span>负责人</span>
                    <div><em>请选择负责人</em><DownOutlined /></div>
                  </label>
                  <div className="prototype-filter-actions">
                    <button type="button" className="prototype-query">查询</button>
                    <button type="button" className="prototype-reset">重置</button>
                  </div>
                </div>
              </div>
              <div className="prototype-table-placeholder">
                <div><strong>订单列表</strong><span>共 3 条</span></div>
                <div className="placeholder-lines"><i /><i /><i /><i /></div>
              </div>
            </div>
          </div>
        </div>

        <div className="prototype-versionbar">
          <Button type="text" size="small" icon={<HistoryOutlined />}>版本记录</Button>
          <div className="prototype-version-steps">
            <i className="done" />
            <span>初始副本</span>
            <b />
            <i className="done" />
            <span>增加两个筛选项</span>
            <b />
            <i className="current" />
            <span className="current-text">当前版本</span>
          </div>
          <div className="version-nav">
            <Button type="text" size="small" shape="circle" icon={<LeftOutlined />} />
            <span>3 / 3</span>
            <Button type="text" size="small" shape="circle" icon={<RightOutlined />} disabled />
          </div>
        </div>
      </section>

      <aside className="prototype-agent-pane">
        <div className="prototype-agent-header">
          <div>
            <Avatar size={30} className="prototype-agent-avatar" icon={<HighlightOutlined />} />
            <div><strong>UI 示意助手</strong><span><i /> 已连接</span></div>
          </div>
          <Button type="text" shape="circle" icon={<MoreOutlined />} />
        </div>

        <div className="prototype-conversation">
          <div className="prototype-date">今天 18:42</div>
          <div className="prototype-user-message">
            在订单状态右侧、查询按钮左侧增加订单来源和负责人两个筛选项，宽度和现有筛选项一致。
          </div>
          <div className="prototype-agent-message">
            <div className="prototype-agent-message-title"><HighlightOutlined /> 已完成页面调整</div>
            <p>新增了“订单来源”和“负责人”两个筛选项，并复用了订单状态的字段宽度、间距和下拉样式。</p>
            <button type="button" className="prototype-change-summary">
              <span><CheckCircleFilled /> 修改了 2 处</span>
              <RightOutlined />
            </button>
            <div className="prototype-message-actions">
              <Button type="text" size="small">恢复到修改前</Button>
              <Button type="text" size="small">查看改动</Button>
            </div>
          </div>
          <div className="prototype-event-line">
            <ClockCircleOutlined />
            <span>已创建版本 3 · 当前版本</span>
          </div>
        </div>

        <div className="prototype-suggestions">
          <button type="button">让两个字段再宽一点</button>
          <button type="button">交换两个字段的位置</button>
        </div>

        <footer className="prototype-composer">
          <Input.TextArea
            variant="borderless"
            autoSize={{ minRows: 3, maxRows: 5 }}
            placeholder="继续描述你想调整的效果…"
          />
          <div>
            <span>Shift + Enter 换行</span>
            <Button type="primary" shape="circle" icon={<SendOutlined />} />
          </div>
        </footer>
      </aside>
    </main>
  </div>;
}

function DemoPage() {
  const [route, setRoute] = useState<DemoRoute>(routeFromLocation);
  useEffect(() => {
    const onPopState = () => setRoute(routeFromLocation());
    addEventListener('popstate', onPopState);
    return () => removeEventListener('popstate', onPopState);
  }, []);
  const navigate = (next: DemoRoute) => {
    history.pushState({}, '', next === 'orders' ? location.pathname : `${location.pathname}?page=${next}`);
    setRoute(next);
  };

  if (route === 'workspace') return <AntApp><WorkspacePrototype /></AntApp>;

  return <AntApp>
    <Layout className="app-shell">
      <Layout.Sider width={220} theme="light" className="sider">
        <div className="brand">Nova Admin</div>
        <Menu mode="inline" selectedKeys={[route]} onClick={({ key }) => key === 'orders' || key === 'detail' || key === 'form' || key === 'workspace' ? navigate(key) : undefined} items={[
          { key: 'dashboard', label: '工作台' },
          { key: 'orders', label: '订单列表' },
          { key: 'detail', label: '订单详情' },
          { key: 'form', label: '新建订单' },
          { key: 'workspace', label: 'UI 示意原型' },
          { key: 'customers', label: '客户管理' },
          { key: 'settings', label: '系统设置' }
        ]} />
      </Layout.Sider>
      <Layout>
        <Layout.Header className="header"><span>运营管理后台 · V1.1 场景页</span><span className="user">产品经理小 A</span></Layout.Header>
        <Layout.Content className="content">
          {route === 'orders' && <OrdersPage navigate={navigate} />}
          {route === 'detail' && <DetailPage navigate={navigate} />}
          {route === 'form' && <FormPage navigate={navigate} />}
        </Layout.Content>
      </Layout>
    </Layout>
  </AntApp>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><DemoPage /></React.StrictMode>);

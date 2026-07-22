import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import {
  App as AntApp, Button, Card, Checkbox, Col, Descriptions, Form, Input, Layout, Menu,
  Radio, Row, Select, Space, Table, Tag, Typography
} from 'antd';
import { ArrowLeftOutlined, EditOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import 'antd/dist/reset.css';
import './styles.css';

type DemoRoute = 'orders' | 'detail' | 'form';

const rows = [
  { key: '1', id: 'SO20260722001', customer: '杭州星海科技', amount: '¥ 12,800.00', status: '待审核', createdAt: '2026-07-22 09:30' },
  { key: '2', id: 'SO20260722002', customer: '上海云帆贸易', amount: '¥ 8,460.00', status: '已通过', createdAt: '2026-07-22 10:12' },
  { key: '3', id: 'SO20260722003', customer: '北京启明数据', amount: '¥ 26,300.00', status: '已驳回', createdAt: '2026-07-22 11:05' }
];

function routeFromLocation(): DemoRoute {
  const route = new URLSearchParams(location.search).get('page');
  return route === 'detail' || route === 'form' ? route : 'orders';
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

  return <AntApp>
    <Layout className="app-shell">
      <Layout.Sider width={220} theme="light" className="sider">
        <div className="brand">Nova Admin</div>
        <Menu mode="inline" selectedKeys={[route]} onClick={({ key }) => key === 'orders' || key === 'detail' || key === 'form' ? navigate(key) : undefined} items={[
          { key: 'dashboard', label: '工作台' },
          { key: 'orders', label: '订单列表' },
          { key: 'detail', label: '订单详情' },
          { key: 'form', label: '新建订单' },
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

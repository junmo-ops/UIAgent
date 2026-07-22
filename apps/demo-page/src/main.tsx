import React from 'react';
import ReactDOM from 'react-dom/client';
import { App as AntApp, Button, Card, Input, Layout, Menu, Select, Space, Table, Tag, Typography } from 'antd';
import { SearchOutlined, PlusOutlined } from '@ant-design/icons';
import 'antd/dist/reset.css';
import './styles.css';

const rows = [
  { key: '1', id: 'SO20260722001', customer: '杭州星海科技', amount: '¥ 12,800.00', status: '待审核', createdAt: '2026-07-22 09:30' },
  { key: '2', id: 'SO20260722002', customer: '上海云帆贸易', amount: '¥ 8,460.00', status: '已通过', createdAt: '2026-07-22 10:12' },
  { key: '3', id: 'SO20260722003', customer: '北京启明数据', amount: '¥ 26,300.00', status: '已驳回', createdAt: '2026-07-22 11:05' }
];

function DemoPage() {
  return (
    <AntApp>
      <Layout className="app-shell">
        <Layout.Sider width={220} theme="light" className="sider">
          <div className="brand">Nova Admin</div>
          <Menu mode="inline" selectedKeys={['orders']} items={[
            { key: 'dashboard', label: '工作台' }, { key: 'orders', label: '订单管理' },
            { key: 'customers', label: '客户管理' }, { key: 'settings', label: '系统设置' }
          ]} />
        </Layout.Sider>
        <Layout>
          <Layout.Header className="header"><span>运营管理后台</span><span className="user">产品经理小 A</span></Layout.Header>
          <Layout.Content className="content">
            <div className="page-title"><div><Typography.Title level={3}>订单管理</Typography.Title><Typography.Text type="secondary">查询和管理全部销售订单</Typography.Text></div><Button type="primary" icon={<PlusOutlined />}>新建订单</Button></div>
            <Card data-ui-component="filter-card" className="filter-card">
              <div className="filter-row" data-ui-component="filter-row">
                <Input data-ui-component="keyword-input" prefix={<SearchOutlined />} placeholder="订单号 / 客户名称" style={{ width: 260 }} />
                <Select data-ui-component="status-select" placeholder="订单状态" style={{ width: 160 }} options={[
                  { value: 'pending', label: '待审核' }, { value: 'approved', label: '已通过' }, { value: 'rejected', label: '已驳回' }
                ]} />
                <Button data-ui-component="query-button" type="primary">查询</Button>
                <Button>重置</Button>
              </div>
            </Card>
            <Card className="table-card" title="订单列表" extra={<Space><Typography.Text type="secondary">共 3 条</Typography.Text><a href="#export">导出数据</a></Space>}>
              <Table pagination={false} dataSource={rows} columns={[
                { title: '订单编号', dataIndex: 'id', render: value => <a href={`#${value}`}>{value}</a> },
                { title: '客户名称', dataIndex: 'customer' }, { title: '订单金额', dataIndex: 'amount' },
                { title: '状态', dataIndex: 'status', render: value => <Tag color={value === '已通过' ? 'green' : value === '已驳回' ? 'red' : 'orange'}>{value}</Tag> },
                { title: '创建时间', dataIndex: 'createdAt' },
                { title: '操作', render: () => <Space><a href="#detail">详情</a><a href="#edit">编辑</a></Space> }
              ]} />
            </Card>
          </Layout.Content>
        </Layout>
      </Layout>
    </AntApp>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><DemoPage /></React.StrictMode>);

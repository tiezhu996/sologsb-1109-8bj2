import { useMemo, useRef, useState, type MutableRefObject } from 'react';
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Row,
  Segmented,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Timeline,
  Typography,
  Upload,
} from 'antd';
import type { TableColumnsType, UploadProps } from 'antd';
import {
  CheckCircleOutlined,
  CloudUploadOutlined,
  FileDoneOutlined,
  InboxOutlined,
  ReloadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { HandoverItem, HandoverPackage } from '../types/handover';
import type { ReviewDecision } from '../types/handover';
import {
  entityLabel,
  ITEM_STATUS_META,
  PACKAGE_STATUS_META,
} from '../utils/reconcile';
import { useHandoverStore } from '../stores/handoverStore';
import { useBatchStore } from '../stores/batchStore';
import { useHerbStore } from '../stores/herbStore';
import { useMethodStore } from '../stores/methodStore';
import { useSampleStore } from '../stores/sampleStore';

const { Title, Text, Paragraph } = Typography;
const { Dragger } = Upload;

const FIELD_LABELS: Record<string, string> = {
  potTempC: '锅温(℃)',
  durationMin: '时长(min)',
  degree: '程度',
  observeLogs: '观察记录',
};

function fmtValue(v: unknown): string {
  if (v === undefined || v === null || v === '') return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** 交接对账：校验暂存 → 按批号/留样编号续接写入 → 两版复核 */
export default function HandoverCenter() {
  const { message, modal } = AntApp.useApp();
  const packages = useHandoverStore((s) => s.packages);
  const items = useHandoverStore((s) => s.items);
  const stageText = useHandoverStore((s) => s.stageText);
  const applyPackage = useHandoverStore((s) => s.applyPackage);
  const reviewItem = useHandoverStore((s) => s.reviewItem);
  const removePackage = useHandoverStore((s) => s.removePackage);

  const hydrateHerbs = useHerbStore((s) => s.hydrate);
  const hydrateMethods = useMethodStore((s) => s.hydrate);
  const hydrateBatches = useBatchStore((s) => s.hydrate);
  const hydrateSamples = useSampleStore((s) => s.hydrate);

  const [selectedId, setSelectedId] = useState<string | undefined>(packages[0]?.id);
  const [entityFilter, setEntityFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [reviewing, setReviewing] = useState<HandoverItem | null>(null);
  const [busy, setBusy] = useState(false);
  const reviewerRef = useRef('质检员 · 赵敏');

  const selected = packages.find((p) => p.id === selectedId) ?? packages[0];
  const selectedItems = useMemo(
    () =>
      items
        .filter((it) => it.packageId === selected?.id)
        .filter((it) => (entityFilter === 'all' ? true : it.entityType === entityFilter))
        .filter((it) => (statusFilter === 'all' ? true : it.status === statusFilter)),
    [items, selected?.id, entityFilter, statusFilter],
  );

  const refreshLedgers = async () => {
    await Promise.all([hydrateHerbs(), hydrateMethods(), hydrateBatches(), hydrateSamples()]);
  };

  const uploadProps: UploadProps = {
    accept: '.json,application/json',
    multiple: false,
    showUploadList: false,
    beforeUpload: async (file) => {
      const text = await file.text();
      const label = file.name.replace(/\.json$/i, '');
      const res = await stageText(text, label);
      if (res.ok) {
        message.success(`交接包已校验暂存：新增 ${res.counts?.new ?? 0}、可合并 ${res.counts?.merge ?? 0}、待复核 ${(res.counts?.conflict ?? 0) + (res.counts?.locked ?? 0)}，本机台账未改动`);
        setSelectedId(res.packageId);
      } else if (res.duplicate) {
        message.warning(res.error);
        setSelectedId(res.packageId);
      } else if (res.packageId) {
        message.error(`整包无法解析，已原样留存，可修正后重新导入：${res.error}`);
        setSelectedId(res.packageId);
      } else {
        message.error(res.error);
      }
      return false;
    },
  };

  const handleApply = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const updated = await applyPackage(selected.id);
      if (updated) {
        await refreshLedgers();
        const s = updated.stats;
        message.success(`续接写入完成：本次新入账/合并 ${s.applied}；待复核 ${s.conflict + s.locked}、待补录 ${s.missingRef}、失败 ${s.failed}；已入账项未重复写入`);
      }
    } catch (err) {
      message.error(`写入中断，整包与已暂存条目均保留：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const openReview = (item: HandoverItem) => setReviewing(item);

  const submitReview = async (decision: ReviewDecision) => {
    if (!selected || !reviewing) return;
    const res = await reviewItem(selected.id, reviewing.id, decision, reviewerRef.current);
    if (!res.ok) {
      message.error(res.error ?? '复核失败');
      return;
    }
    message.success(decision === 'incoming' ? '已采用平板版并同步台账' : '已保留本机版，工序状态/留样台账已同步');
    setReviewing(null);
    await refreshLedgers();
  };

  const pkgColumns: TableColumnsType<HandoverPackage> = [
    {
      title: '交接包',
      dataIndex: 'label',
      render: (v: string, record) => (
        <Space direction="vertical" size={2}>
          <Text strong={record.id === selected?.id}>{v}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {new Date(record.importedAt).toLocaleString('zh-CN')} · v{record.schemaVersion}
          </Text>
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 170,
      render: (status: HandoverPackage['status']) => (
        <Tag color={PACKAGE_STATUS_META[status].color}>{PACKAGE_STATUS_META[status].label}</Tag>
      ),
    },
    {
      title: '进度',
      width: 200,
      render: (_, r) => {
        const done = r.stats.applied + r.stats.skipped + r.stats.identical;
        return (
          <Space size={4}>
            <Badge status="success" text={`入 ${r.stats.applied}`} />
            <Badge status="default" text={`跳 ${r.stats.skipped}`} />
            <Badge status="warning" text={`审 ${r.stats.conflict + r.stats.locked}`} />
            <Badge status="warning" text={`补 ${r.stats.missingRef}`} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {done}/{r.stats.total}
            </Text>
          </Space>
        );
      },
    },
    {
      title: '操作',
      width: 150,
      render: (_, r) => (
        <Space>
          <Button size="small" type="link" onClick={() => setSelectedId(r.id)}>
            查看
          </Button>
          <Popconfirm
            title="删除暂存交接包？"
            description="仅删除平板带回的暂存副本，已写入本机台账的数据不受影响。"
            onConfirm={async () => {
              await removePackage(r.id);
              message.success('已删除该暂存包');
            }}
          >
            <Button size="small" type="link" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const itemColumns: TableColumnsType<HandoverItem> = [
    {
      title: '类型',
      dataIndex: 'entityType',
      width: 90,
      render: (v: HandoverItem['entityType']) => entityLabel(v),
    },
    {
      title: '业务键',
      dataIndex: 'naturalKey',
      width: 170,
      render: (v: string, record) => (
        <Space direction="vertical" size={0}>
          <Text strong>{v}</Text>
          {record.conflictTitle && record.status === 'conflict' && (
            <Text type="warning" style={{ fontSize: 12 }}>
              {record.conflictTitle}
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 130,
      render: (status: HandoverItem['status']) => (
        <Tag color={ITEM_STATUS_META[status].color}>{ITEM_STATUS_META[status].label}</Tag>
      ),
    },
    {
      title: '差异 / 说明',
      render: (_, record) => {
        if (record.missingRefs?.length) {
          return (
            <Space direction="vertical" size={0}>
              {record.missingRefs.map((m) => (
                <Text key={m} type="warning" style={{ fontSize: 12 }}>
                  <WarningOutlined /> {m}
                </Text>
              ))}
              <Text type="secondary" style={{ fontSize: 12 }}>
                在药材/方法台账补录后点「续接写入」即可，本条不丢、不重复
              </Text>
            </Space>
          );
        }
        if (record.reason) {
          return <Text type="secondary" style={{ fontSize: 12 }}>{record.reason}</Text>;
        }
        if (record.failReason) {
          return <Text type="danger" style={{ fontSize: 12 }}>{record.failReason}</Text>;
        }
        const diffs = record.diffs ?? [];
        if (!diffs.length) return <Text type="secondary" style={{ fontSize: 12 }}>无差异</Text>;
        return (
          <Space size={[4, 4]} wrap>
            {diffs.map((d) => (
              <Tag
                key={d.field}
                color={FIELD_LABELS[d.field] ? 'orange' : 'default'}
                style={{ fontSize: 12 }}
              >
                {d.label}：{fmtValue(d.local)} → {fmtValue(d.incoming)}
              </Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: '操作',
      width: 130,
      render: (_, record) =>
        record.status === 'conflict' || record.status === 'locked' ? (
          <Button size="small" type="primary" ghost onClick={() => openReview(record)}>
            两版复核
          </Button>
        ) : record.status === 'applied' ? (
          <Text type="success" style={{ fontSize: 12 }}>
            <CheckCircleOutlined /> 已同步
          </Text>
        ) : null,
    },
  ];

  const pendingCount = selected
    ? selected.stats.new + selected.stats.merge + selected.stats.missingRef + selected.stats.failed
    : 0;
  const reviewCount = selected ? selected.stats.conflict + selected.stats.locked : 0;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card>
        <Title level={4} style={{ marginTop: 0 }}>
          <CloudUploadOutlined /> 交接包增量对账（断网可续接）
        </Title>
        <Paragraph type="secondary" style={{ marginBottom: 12 }}>
          平板带回的交接包先<strong>校验并整包暂存</strong>，绝不清空本机台账；再按<strong>生产批号、留样编号</strong>续接写入。
          同一批号锅温/时长/程度或留样观察不一致时，两版并存待复核，<strong>锁定结果不覆盖</strong>；
          缺药材/炮制方法时补录后重试，已写入项不重复。
        </Paragraph>
        <Dragger {...uploadProps} style={{ padding: 16 }}>
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">点击或拖拽平板交接包 JSON 到此处（仅校验暂存，不立即写账）</p>
          <p className="ant-upload-hint">兼容旧版交接包：缺锅温/时长等字段时自动补全；解析失败的整包也会留存</p>
        </Dragger>
      </Card>

      {packages.length === 0 ? (
        <Empty description="暂无暂存交接包" />
      ) : (
        <Row gutter={16}>
          <Col xs={24} lg={9}>
            <Card title="暂存交接包" size="small" bodyStyle={{ padding: 0 }}>
              <Table<HandoverPackage>
                rowKey="id"
                size="small"
                columns={pkgColumns}
                dataSource={packages}
                pagination={false}
                onRow={(r) => ({ onClick: () => setSelectedId(r.id), style: { cursor: 'pointer' } })}
              />
            </Card>
          </Col>
          <Col xs={24} lg={15}>
            {selected ? (
              <Card
                size="small"
                title={
                  <Space wrap>
                    <Text strong>{selected.label}</Text>
                    <Tag color={PACKAGE_STATUS_META[selected.status].color}>
                      {PACKAGE_STATUS_META[selected.status].label}
                    </Tag>
                  </Space>
                }
                extra={
                  <Space>
                    <Popconfirm
                      title="续接写入"
                      description="按生产批号/留样编号写入本机台账；待复核两版与锁定批不会被覆盖。"
                      onConfirm={handleApply}
                      disabled={selected.status === 'error' || selected.status === 'done'}
                    >
                      <Button
                        type="primary"
                        icon={<ReloadOutlined />}
                        loading={busy}
                        disabled={selected.status === 'error' || selected.status === 'done'}
                      >
                        续接写入
                      </Button>
                    </Popconfirm>
                  </Space>
                }
              >
                {selected.status === 'error' ? (
                  <Alert
                    type="error"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="整包解析失败已原样留存"
                    description={selected.error}
                  />
                ) : null}
                <Row gutter={8} style={{ marginBottom: 12 }}>
                  <Col span={6}>
                    <Statistic title="待写入/合并" value={pendingCount} valueStyle={{ fontSize: 20, color: '#1677ff' }} />
                  </Col>
                  <Col span={6}>
                    <Statistic title="待复核两版" value={reviewCount} valueStyle={{ fontSize: 20, color: '#d48806' }} />
                  </Col>
                  <Col span={6}>
                    <Statistic title="已同步" value={selected.stats.applied} valueStyle={{ fontSize: 20, color: '#389e0d' }} />
                  </Col>
                  <Col span={6}>
                    <Statistic title="一致跳过" value={selected.stats.identical} valueStyle={{ fontSize: 20 }} />
                  </Col>
                </Row>
                <Space style={{ marginBottom: 8 }} wrap>
                  <Segmented
                    size="small"
                    value={entityFilter}
                    onChange={(v) => setEntityFilter(String(v))}
                    options={[
                      { label: '全部', value: 'all' },
                      { label: '药材', value: 'herb' },
                      { label: '方法', value: 'method' },
                      { label: '工序', value: 'batch' },
                      { label: '留样', value: 'sample' },
                    ]}
                  />
                  <Segmented
                    size="small"
                    value={statusFilter}
                    onChange={(v) => setStatusFilter(String(v))}
                    options={[
                      { label: '全部状态', value: 'all' },
                      { label: '待处理', value: 'new' },
                      { label: '可合并', value: 'merge' },
                      { label: '待复核', value: 'conflict' },
                      { label: '已锁定', value: 'locked' },
                      { label: '待补录', value: 'missing-ref' },
                      { label: '已写入', value: 'applied' },
                      { label: '失败', value: 'failed' },
                    ]}
                  />
                </Space>
                <Table<HandoverItem>
                  rowKey="id"
                  size="small"
                  columns={itemColumns}
                  dataSource={selectedItems}
                  pagination={{ pageSize: 8, size: 'small' }}
                />
              </Card>
            ) : (
              <Empty />
            )}
          </Col>
        </Row>
      )}

      <ReviewModal
        item={reviewing}
        onClose={() => setReviewing(null)}
        onDecide={submitReview}
        reviewerRef={reviewerRef}
      />
    </Space>
  );
}

/* ------------------------- 两版复核弹窗 ------------------------- */

function ReviewModal({
  item,
  onClose,
  onDecide,
  reviewerRef,
}: {
  item: HandoverItem | null;
  onClose: () => void;
  onDecide: (decision: ReviewDecision) => Promise<void>;
  reviewerRef: MutableRefObject<string>;
}) {
  const [reviewer, setReviewer] = useState(reviewerRef.current);
  if (!item) return null;
  const locked = item.status === 'locked';
  const diffs = item.diffs ?? [];

  return (
    <Modal
      open={Boolean(item)}
      title={
        <Space>
          <FileDoneOutlined />
          两版复核 · {entityLabel(item.entityType)} {item.naturalKey}
          {locked && <Tag color="red">本机已锁定</Tag>}
        </Space>
      }
      onCancel={onClose}
      width={760}
      footer={
        <Space>
          <Input
            style={{ width: 180 }}
            defaultValue={reviewer}
            placeholder="复核人"
            onChange={(e) => {
              reviewerRef.current = e.target.value;
              setReviewer(e.target.value);
            }}
          />
          <Button onClick={onClose}>取消</Button>
          <Button type="default" onClick={() => onDecide('local')}>
            保留本机版
          </Button>
          <Button type="primary" danger={!locked} disabled={locked} onClick={() => onDecide('incoming')}>
            {locked ? '锁定禁止覆盖' : '采用平板版'}
          </Button>
        </Space>
      }
    >
      {locked && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="该批已锁定，导入不得覆盖"
          description="只能保留本机版；如平板数据确为正确结果，请先到「工序记录台」由质检员解锁改判后，再回本页续接。"
        />
      )}
      <Descriptions
        size="small"
        bordered
        column={3}
        title="字段对照"
        items={diffs.map((d) => ({
          key: d.field,
          label: d.label,
          children: (
            <Space direction="vertical" size={0}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                本机：{fmtValue(d.local)}
              </Text>
              <Text strong>平板：{fmtValue(d.incoming)}</Text>
            </Space>
          ),
        }))}
      />
      {item.entityType === 'sample' && (
        <Tabs
          size="small"
          style={{ marginTop: 12 }}
          items={[
            {
              key: 'local',
              label: '本机版观察',
              children: <ObserveTimeline raw={item.localSnapshot?.observeLogs} />,
            },
            {
              key: 'incoming',
              label: '平板版观察',
              children: <ObserveTimeline raw={item.incoming.observeLogs} />,
            },
          ]}
        />
      )}
      <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
        复核确定后同步工序状态与留样台账；留样新增观察记录按日期并集追加，不覆盖既有观察。
      </Paragraph>
    </Modal>
  );
}

function ObserveTimeline({ raw }: { raw: unknown }) {
  const logs = (Array.isArray(raw) ? raw : []) as Array<Record<string, unknown>>;
  if (!logs.length) return <Empty description="无观察记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  return (
    <Timeline
      items={logs
        .slice()
        .sort((a, b) => String(b.date).localeCompare(String(a.date)))
        .map((l) => ({
          color: 'green',
          children: (
            <Space direction="vertical" size={0}>
              <Text strong>{String(l.date ?? '')}</Text>
              <Text style={{ fontSize: 12 }}>
                色泽 {fmtValue(l.color)} · 气味 {fmtValue(l.odor)} · 霉变 {fmtValue(l.mold)} · {fmtValue(l.observer)}
              </Text>
              {l.note ? <Text type="secondary" style={{ fontSize: 12 }}>{String(l.note)}</Text> : null}
            </Space>
          ),
        }))}
    />
  );
}

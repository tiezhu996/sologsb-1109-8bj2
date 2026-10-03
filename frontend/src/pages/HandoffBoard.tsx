import { useMemo, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Card,
  Checkbox,
  Collapse,
  Descriptions,
  Empty,
  Input,
  Modal,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { TableColumnsType, UploadProps } from 'antd';
import {
  CheckCircleOutlined,
  CloudSyncOutlined,
  DeleteOutlined,
  DownloadOutlined,
  FileAddOutlined,
  FileSearchOutlined,
  ImportOutlined,
  SafetyCertificateOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { useHandoffStore } from '../stores/handoffStore';
import { useBatchStore } from '../stores/batchStore';
import { useSampleStore } from '../stores/sampleStore';
import { downloadText } from '../utils/export';
import { serializeHandoff } from '../utils/handoff';
import { buildDemoHandoff } from '../utils/demo-handoff';
import {
  HANDOFF_ITEM_STATE_META,
  HANDOFF_STATE_META,
  type HandoffItem,
  type HandoffPackage,
} from '../types/handoff';
import type { ObserveLog, RetainSample } from '../types/retain-sample';
import type { ProcessBatch } from '../types/process-batch';

const { Title, Paragraph, Text } = Typography;

type ReviewResolution = 'keep-local' | 'adopt-incoming' | 'merge-logs';

const KIND_LABEL: Record<HandoffItem['kind'], string> = {
  herb: '药材',
  method: '方法',
  batch: '工序',
  sample: '留样',
};

function countByState(pkg: HandoffPackage) {
  const c = (states: HandoffItem['state'][]) => pkg.items.filter((i) => states.includes(i.state)).length;
  return {
    fresh: c(['new']),
    identical: c(['identical']),
    blocked: c(['blocked']),
    conflict: c(['conflict']),
    reviewing: c(['reviewing']),
    applied: c(['applied']),
    resolved: c(['resolved']),
    invalid: c(['invalid']),
  };
}

/** 交接对账：先校验暂存、再按批号/留样编号写入，差异两版复核，失败整包保留可续接 */
export default function HandoffBoard() {
  const { message, modal } = AntApp.useApp();
  const packages = useHandoffStore((s) => s.packages);
  const stageText = useHandoffStore((s) => s.stageText);
  const apply = useHandoffStore((s) => s.apply);
  const supplement = useHandoffStore((s) => s.supplement);
  const remove = useHandoffStore((s) => s.remove);
  const resolve = useHandoffStore((s) => s.resolve);
  const batches = useBatchStore((s) => s.batches);
  const samples = useSampleStore((s) => s.samples);

  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<{ pkgId: string; item: HandoffItem } | null>(null);
  const [qcName, setQcName] = useState('质检员 · 赵敏');
  const [qcChecked, setQcChecked] = useState(false);

  const totalReviewing = useMemo(
    () => packages.reduce((sum, p) => sum + countByState(p).reviewing, 0),
    [packages],
  );
  const totalBlocked = useMemo(
    () => packages.reduce((sum, p) => sum + countByState(p).blocked, 0),
    [packages],
  );

  const ingest = async (text: string, source: string) => {
    setBusy(true);
    try {
      const pkg = await stageText(text);
      const c = countByState(pkg);
      message.success(
        `${source}已校验并暂存：待写入 ${c.fresh}，一致跳过 ${c.identical}，两版待复核 ${c.conflict}，缺档案阻塞 ${c.blocked}，校验失败 ${c.invalid}`,
      );
    } catch (error) {
      message.error(`交接包未通过校验，未暂存：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const uploadProps: UploadProps = {
    accept: '.json,application/json',
    showUploadList: false,
    multiple: false,
    beforeUpload: async (file) => {
      try {
        const text = await file.text();
        await ingest(text, `「${file.name}」`);
      } catch (error) {
        message.error(`读取文件失败：${(error as Error).message}`);
      }
      return Upload.LIST_IGNORE;
    },
  };

  const handleDemo = async () => {
    await ingest(await buildDemoHandoff(), '演示交接包');
  };

  const handleApply = async (pkg: HandoffPackage) => {
    setBusy(true);
    try {
      const next = await apply(pkg.id);
      const c = countByState(next);
      const done = c.applied + c.identical + c.resolved;
      if (next.lastError) {
        message.warning(`部分写入：成功 ${done} 项；${next.lastError}`);
      } else if (c.blocked > 0) {
        message.warning(`已写入可接续项 ${done}；${c.blocked} 项缺药材/方法/工序，补录后点「继续续接」`);
      } else if (c.reviewing + c.conflict > 0) {
        message.success(`已写入 ${done} 项，${c.reviewing + c.conflict} 项两版并存，请在下方复核`);
      } else {
        message.success(`交接完成：${done} 项已与本机台账一致`);
      }
    } catch (error) {
      message.error(`写入失败，整包已保留：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleSupplement = async (pkg: HandoffPackage) => {
    setBusy(true);
    try {
      const result = await supplement(pkg.id);
      const c = countByState(result.pkg);
      message.success(`已补录药材 ${result.herbs} 个、炮制方法 ${result.methods} 个并重新对账；仍阻塞 ${c.blocked} 项`);
    } catch (error) {
      message.error(`补录失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = (pkg: HandoffPackage) => {
    modal.confirm({
      title: `删除交接包（${pkg.device}）？`,
      content: '已写入正本台账的数据保留；尚未裁决的待复核副本将一并清理。',
      okText: '删除整包',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        await remove(pkg.id);
        message.success('交接包已移除');
      },
    });
  };

  const openReview = (pkgId: string, item: HandoffItem) => {
    setReview({ pkgId, item });
    setQcName('质检员 · 赵敏');
    setQcChecked(false);
  };

  const submitResolution = (resolution: ReviewResolution) => {
    if (!review) return;
    const canonical =
      review.item.kind === 'batch'
        ? batches.find((b) => b.id === review.item.localCounterpartId)
        : samples.find((s) => s.id === review.item.localCounterpartId);
    const locked = review.item.kind === 'batch' && (canonical as ProcessBatch | undefined)?.locked;
    if (resolution === 'adopt-incoming' && locked && (!qcChecked || !qcName.trim())) {
      message.error('锁定结果采用交接版，必须勾选质检改判并填写质检员');
      return;
    }
    modal.confirm({
      title:
        resolution === 'keep-local'
          ? '确认保留本机版，弃用交接副本？'
          : resolution === 'adopt-incoming'
            ? '确认采用交接版覆盖本机记录？'
            : '确认把交接观察记录合并进本机台账？',
      content:
        locked && resolution === 'adopt-incoming'
          ? `本机批号已锁定，本次改判由 ${qcName.trim()} 负责。`
          : '裁决后自动同步工序状态与留样台账。',
      okText: '确认裁决',
      cancelText: '取消',
      onOk: async () => {
        try {
          await resolve(review.pkgId, review.item.refId, { resolution, qcBy: locked ? qcName.trim() : undefined });
          message.success('复核完成，台账已同步');
          setReview(null);
        } catch (error) {
          message.error(`复核失败：${(error as Error).message}`);
        }
      },
    });
  };

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        交接包增量对账
      </Title>
      <Paragraph type="secondary">
        平板带回的交接包先校验并暂存（不清空本机台账），再按生产批号、留样编号逐项写入：同批号锅温/时长/程度/现场观察有差异时两版并存待复核，锁定结果不覆盖；缺药材或炮制方法可补录后续接重试，成功项不重复写入。
      </Paragraph>

      {totalReviewing > 0 ? (
        <Alert
          style={{ marginBottom: 12 }}
          type="warning"
          showIcon
          message={`有 ${totalReviewing} 条工序/留样两版并存，等待复核`}
          description="复核后才会同步工序状态与留样台账，请逐包展开「待复核」页签裁决。"
        />
      ) : null}
      {totalBlocked > 0 ? (
        <Alert
          style={{ marginBottom: 12 }}
          type="info"
          showIcon
          message={`有 ${totalBlocked} 条因缺药材/炮制方法/所属工序阻塞，整包已保留`}
          description={
            <Space wrap>
              <span>可在包内一键「补录档案」，或到台账手工补录后续接：</span>
              <Link to="/herbs">药材台账</Link>
              <Link to="/methods">炮制方法</Link>
              <Link to="/batches">工序记录台</Link>
            </Space>
          }
        />
      ) : null}

      <Space style={{ marginBottom: 16 }} wrap>
        <Upload {...uploadProps}>
          <Button type="primary" icon={<UploadOutlined />} loading={busy}>
            选择交接包（.json）校验暂存
          </Button>
        </Upload>
        <Button icon={<FileAddOutlined />} onClick={() => setPasteOpen(true)}>
          粘贴交接包文本
        </Button>
        <Button icon={<FileSearchOutlined />} onClick={handleDemo} loading={busy}>
          生成演示交接包试跑
        </Button>
      </Space>

      {packages.length === 0 ? (
        <Empty description="暂无暂存交接包。从平板拷回 JSON 后选择文件，或先试跑演示交接包。" />
      ) : (
        <Collapse
          items={packages.map((pkg) => {
            const c = countByState(pkg);
            const actionable = c.fresh + c.conflict;
            const supplementable = pkg.items.filter((i) => i.state === 'new' && (i.kind === 'herb' || i.kind === 'method')).length;
            return {
              key: pkg.id,
              label: (
                <Space wrap size={8}>
                  <Text strong>{pkg.device}</Text>
                  <Tag color={HANDOFF_STATE_META[pkg.state].color}>{HANDOFF_STATE_META[pkg.state].label}</Tag>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    交接时间 {pkg.packageAt.slice(0, 16).replace('T', ' ')} · 暂存 {pkg.receivedAt.slice(0, 16).replace('T', ' ')}
                  </Text>
                  {pkg.legacy ? <Tag color="purple">旧版包·已兼容补全</Tag> : null}
                </Space>
              ),
              extra: (
                <Space onClick={(e) => e.stopPropagation()} wrap size={4}>
                  <Button
                    size="small"
                    type="primary"
                    icon={<ImportOutlined />}
                    disabled={actionable === 0 || busy}
                    onClick={() => handleApply(pkg)}
                  >
                    {pkg.state === 'staged' ? `执行写入（${actionable}）` : `继续续接（${actionable}）`}
                  </Button>
                  {supplementable > 0 ? (
                    <Button size="small" icon={<SafetyCertificateOutlined />} disabled={busy} onClick={() => handleSupplement(pkg)}>
                      补录档案（{supplementable}）
                    </Button>
                  ) : null}
                  <Button size="small" icon={<DownloadOutlined />} onClick={() => downloadText(`handoff-${pkg.id}.json`, serializeHandoff(pkg))}>
                    导出整包
                  </Button>
                  <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleRemove(pkg)}>
                    删除
                  </Button>
                </Space>
              ),
              children: <PackageDetail pkg={pkg} onReview={(item) => openReview(pkg.id, item)} />,
            };
          })}
        />
      )}

      <Modal
        open={pasteOpen}
        title="粘贴交接包 JSON 文本"
        onCancel={() => setPasteOpen(false)}
        onOk={async () => {
          if (!pasteText.trim()) {
            message.warning('请先粘贴交接包内容');
            return;
          }
          await ingest(pasteText, '粘贴内容');
          setPasteOpen(false);
          setPasteText('');
        }}
        okText="校验并暂存"
        cancelText="取消"
      >
        <Input.TextArea rows={12} value={pasteText} onChange={(e) => setPasteText(e.target.value)} placeholder='{"app":"gbherbprocess", ...}' />
      </Modal>

      <ReviewModal
        review={review}
        batches={batches}
        samples={samples}
        qcName={qcName}
        qcChecked={qcChecked}
        onQcName={setQcName}
        onQcChecked={setQcChecked}
        onClose={() => setReview(null)}
        onResolve={submitResolution}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 包详情：分页签展示待处理 / 待复核 / 已完成 / 校验失败                */
/* ------------------------------------------------------------------ */

function PackageDetail({ pkg, onReview }: { pkg: HandoffPackage; onReview: (item: HandoffItem) => void }) {
  const groupItems = (states: HandoffItem['state'][]) => pkg.items.filter((i) => states.includes(i.state));

  const columns = (showReview: boolean): TableColumnsType<HandoffItem> => [
    {
      title: '类型',
      dataIndex: 'kind',
      width: 70,
      render: (kind: HandoffItem['kind']) => <Tag>{KIND_LABEL[kind]}</Tag>,
    },
    { title: '编号', dataIndex: 'label', width: 220, render: (v: string, r) => <Text strong={r.kind === 'batch' || r.kind === 'sample'}>{v}</Text> },
    {
      title: '状态',
      dataIndex: 'state',
      width: 120,
      render: (s: HandoffItem['state']) => <Tag color={HANDOFF_ITEM_STATE_META[s].color}>{HANDOFF_ITEM_STATE_META[s].label}</Tag>,
    },
    {
      title: '说明',
      render: (_, r) => (
        <Space direction="vertical" size={2}>
          {r.state === 'blocked'
            ? r.errors.map((e) => (
                <Text key={e} type="warning" style={{ fontSize: 12 }}>
                  {e}
                </Text>
              ))
            : null}
          {r.state === 'conflict' ? (
            <Space size={4} wrap>
              {r.diffs.map((d) => (
                <Tag key={d.field} color={d.key ? 'gold' : 'default'}>
                  {d.label}
                  {d.key ? '★' : ''}
                </Tag>
              ))}
            </Space>
          ) : null}
          {r.notes.map((n) => (
            <Text key={n} type="secondary" style={{ fontSize: 12 }}>
              兼容补全：{n}
            </Text>
          ))}
          {r.state === 'resolved' ? (
            <Text type="success" style={{ fontSize: 12 }}>
              裁决：{r.resolution === 'keep-local' ? '保留本机版' : r.resolution === 'adopt-incoming' ? '采用交接版' : '合并观察记录'}
              {r.resolvedBy ? ` · ${r.resolvedBy}` : ''}
            </Text>
          ) : null}
          {r.state === 'applied' ? (
            <Text type="success" style={{ fontSize: 12 }}>
              <CheckCircleOutlined /> 已写入台账，不重复
            </Text>
          ) : null}
          {r.state === 'identical' ? <Text type="secondary" style={{ fontSize: 12 }}>与本机一致，跳过</Text> : null}
        </Space>
      ),
    },
    ...(showReview
      ? [
          {
            title: '操作',
            width: 110,
            render: (_: unknown, r: HandoffItem) => (
              <Button size="small" type="link" icon={<SafetyCertificateOutlined />} onClick={() => onReview(r)}>
                复核裁决
              </Button>
            ),
          } as TableColumnsType<HandoffItem>[number],
        ]
      : []),
  ];

  const table = (items: HandoffItem[], showReview: boolean) =>
    items.length === 0 ? (
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无条目" />
    ) : (
      <Table rowKey={(r) => `${r.kind}-${r.refId}`} size="small" columns={columns(showReview)} dataSource={items} pagination={false} />
    );

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space wrap size={4}>
        <Badge status="processing" text={`待写入 ${countByState(pkg).fresh}`} />
        <Badge status="default" text={`本机一致 ${countByState(pkg).identical}`} />
        <Badge status="warning" text={`缺档案阻塞 ${countByState(pkg).blocked}`} />
        <Badge status="warning" text={`两版待复核 ${countByState(pkg).reviewing + countByState(pkg).conflict}`} />
        <Badge status="success" text={`已写入 ${countByState(pkg).applied}`} />
        <Badge status="success" text={`已复核 ${countByState(pkg).resolved}`} />
        <Badge status="error" text={`校验失败 ${countByState(pkg).invalid}`} />
      </Space>

      {pkg.legacy && pkg.completionNotes.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message="旧版交接包缺字段，已做兼容补全（补全项逐条标注在下方）"
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {pkg.completionNotes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          }
        />
      ) : null}
      {pkg.lastError ? <Alert type="error" showIcon message={pkg.lastError} description="整包保留，补录档案或修正后点「继续续接」，已成功项不会重复写入。" /> : null}

      <Tabs
        size="small"
        items={[
          {
            key: 'pending',
            label: `待处理（${groupItems(['new', 'blocked']).length}）`,
            children: table(groupItems(['new', 'blocked']), false),
          },
          {
            key: 'review',
            label: `待复核（${groupItems(['conflict', 'reviewing']).length}）`,
            children: table(groupItems(['reviewing']), true),
          },
          {
            key: 'done',
            label: `已完成（${groupItems(['applied', 'identical', 'resolved']).length}）`,
            children: table(groupItems(['applied', 'identical', 'resolved']), false),
          },
          {
            key: 'invalid',
            label: `校验失败（${groupItems(['invalid']).length}）`,
            children: table(groupItems(['invalid']), false),
          },
        ]}
      />
    </Space>
  );
}

/* ------------------------------------------------------------------ */
/* 复核弹窗：本机正本 vs 交接副本，差异标星，锁定批次需质检员裁决       */
/* ------------------------------------------------------------------ */

interface ReviewModalProps {
  review: { pkgId: string; item: HandoffItem } | null;
  batches: ProcessBatch[];
  samples: RetainSample[];
  qcName: string;
  qcChecked: boolean;
  onQcName: (v: string) => void;
  onQcChecked: (v: boolean) => void;
  onClose: () => void;
  onResolve: (r: ReviewResolution) => void;
}

const OBSERVE_COLUMNS: TableColumnsType<ObserveLog> = [
  { title: '日期', dataIndex: 'date', width: 100 },
  { title: '色泽', dataIndex: 'color', width: 110 },
  { title: '气味', dataIndex: 'odor', width: 100 },
  { title: '霉变', dataIndex: 'mold', width: 90 },
  { title: '观察人', dataIndex: 'observer', width: 90 },
  { title: '备注', dataIndex: 'note', render: (v?: string) => v ?? '-' },
];

function ReviewModal(props: ReviewModalProps) {
  const { review, batches, samples, qcName, qcChecked, onQcName, onQcChecked, onClose, onResolve } = props;
  const item = review?.item;

  const canonicalBatch = item?.kind === 'batch' && item.localCounterpartId ? batches.find((b) => b.id === item.localCounterpartId) : undefined;
  const canonicalSample = item?.kind === 'sample' && item.localCounterpartId ? samples.find((s) => s.id === item.localCounterpartId) : undefined;
  const incomingSample = item?.kind === 'sample' ? (item.data as RetainSample) : undefined;
  const locked = Boolean(canonicalBatch?.locked);

  const diffColumns: TableColumnsType<HandoffItem['diffs'][number]> = [
    { title: '维度', dataIndex: 'label', width: 150, render: (v: string, r) => `${v}${r.key ? ' ★' : ''}` },
    { title: '本机正本', dataIndex: 'local', render: (v: unknown) => (v === undefined || v === '' ? '—' : String(v)) },
    { title: '交接副本', dataIndex: 'incoming', render: (v: unknown) => (v === undefined || v === '' ? '—' : String(v)) },
  ];

  return (
    <Modal
      open={Boolean(review)}
      title={item ? `两版复核 · ${item.label}` : ''}
      onCancel={onClose}
      width={860}
      footer={
        item ? (
          <Space wrap>
            {item.kind === 'sample' ? (
              <Button icon={<CloudSyncOutlined />} onClick={() => onResolve('merge-logs')}>
                合并观察记录
              </Button>
            ) : null}
            <Button onClick={() => onResolve('keep-local')}>保留本机版（弃用交接副本）</Button>
            <Button danger={locked} type="primary" icon={locked ? <SafetyCertificateOutlined /> : undefined} onClick={() => onResolve('adopt-incoming')}>
              采用交接版{locked ? '（质检改判）' : ''}
            </Button>
          </Space>
        ) : null
      }
    >
      {item ? (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {locked ? (
            <Alert
              type="error"
              showIcon
              message="该批号得率与程度已锁定，采用交接版将由质检员改判，本机锁定结果不会被自动覆盖"
              description={
                <Space direction="vertical" size={6} style={{ marginTop: 6 }}>
                  <Checkbox checked={qcChecked} onChange={(e) => onQcChecked(e.target.checked)}>
                    我已对照判断标准复核两版差异，确认改判
                  </Checkbox>
                  <Input style={{ width: 260 }} placeholder="质检员签名" value={qcName} onChange={(e) => onQcName(e.target.value)} />
                </Space>
              }
            />
          ) : (
            <Alert type="info" showIcon message="该批号尚未锁定，可直接选择保留本机版或采用交接版。" />
          )}

          {canonicalBatch ? (
            <Card size="small" title={`正本工序${canonicalBatch.locked ? '（已锁定）' : ''}`}>
              <Descriptions size="small" column={2}>
                <Descriptions.Item label="锅温(℃)">{canonicalBatch.actualTemp ?? '未记录'}</Descriptions.Item>
                <Descriptions.Item label="时长(min)">{canonicalBatch.durationMin ?? '未记录'}</Descriptions.Item>
                <Descriptions.Item label="程度">{canonicalBatch.degree}</Descriptions.Item>
                <Descriptions.Item label="得率(%)">{canonicalBatch.yieldRate}</Descriptions.Item>
                <Descriptions.Item label="观察/备注" span={2}>
                  {canonicalBatch.remark ?? '无'}
                </Descriptions.Item>
              </Descriptions>
            </Card>
          ) : null}

          {item.diffs.length > 0 ? (
            <Table rowKey="field" size="small" pagination={false} columns={diffColumns} dataSource={item.diffs} />
          ) : (
            <Text type="secondary">两版关键字段一致，仅需确认归档。</Text>
          )}

          {item.kind === 'sample' && canonicalSample && incomingSample ? (
            <div>
              <Text strong>观察记录对照（★ 维度不一致时可合并或择一）</Text>
              <Space align="start" size={8} style={{ display: 'flex', marginTop: 8 }}>
                <Card size="small" title="本机观察" style={{ flex: 1 }} styles={{ body: { padding: 8 } }}>
                  <Table rowKey="id" size="small" pagination={false} columns={OBSERVE_COLUMNS} dataSource={canonicalSample.observeLogs} />
                </Card>
                <Card size="small" title="交接观察" style={{ flex: 1 }} styles={{ body: { padding: 8 } }}>
                  <Table rowKey="id" size="small" pagination={false} columns={OBSERVE_COLUMNS} dataSource={incomingSample.observeLogs} />
                </Card>
              </Space>
            </div>
          ) : null}
        </Space>
      ) : null}
    </Modal>
  );
}

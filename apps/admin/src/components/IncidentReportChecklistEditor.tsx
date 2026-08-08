import { DeleteOutlined, HolderOutlined, PlusOutlined, RobotOutlined } from "@ant-design/icons";
import { Button, Card, Input, Space, Tag, Typography } from "antd";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

export type IncidentChecklistItem = {
  id?: string;
  title: string;
  description?: string | null;
  source_event_id?: string | null;
};

type IncidentReportChecklistEditorProps = {
  items: IncidentChecklistItem[];
  onChange: (items: IncidentChecklistItem[]) => void;
  showAiBadge?: boolean;
  published?: boolean;
};

export function IncidentReportChecklistEditor({
  items,
  onChange,
  showAiBadge = true,
  published = false,
}: IncidentReportChecklistEditorProps) {
  const { t } = useTranslation();

  const updateItem = (index: number, patch: Partial<IncidentChecklistItem>) => {
    const next = [...items];
    next[index] = { ...next[index], ...patch };
    onChange(next);
  };

  const removeItem = (index: number) => {
    onChange(items.filter((_, i) => i !== index));
  };

  const addItem = () => {
    onChange([
      ...items,
      {
        id: `item-${Date.now()}`,
        title: t("incidentReports.checklist.newItem"),
        description: "",
        source_event_id: null,
      },
    ]);
  };

  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      {showAiBadge && !published ? (
        <Tag color="purple" icon={<RobotOutlined />}>
          {t("incidentReports.checklist.aiBadge")}
        </Tag>
      ) : null}
      {items.map((item, index) => (
        <Card key={item.id ?? index} size="small" type="inner">
          <Space align="start" style={{ width: "100%" }}>
            <HolderOutlined style={{ marginTop: 8, opacity: 0.45 }} />
            <Space direction="vertical" style={{ flex: 1 }} size={8}>
              <Input
                value={item.title}
                disabled={published}
                onChange={(e) => updateItem(index, { title: e.target.value })}
                placeholder={t("incidentReports.checklist.itemTitle")}
              />
              <Input.TextArea
                rows={2}
                value={item.description ?? ""}
                disabled={published}
                onChange={(e) => updateItem(index, { description: e.target.value })}
                placeholder={t("incidentReports.checklist.itemDescription")}
              />
              {item.source_event_id ? (
                <Typography.Text type="secondary">
                  <Link
                    to={`/timeline?event_id=${item.source_event_id}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("incidentReports.checklist.sourceEvent")}: {item.source_event_id.slice(0, 8)}
                  </Link>
                </Typography.Text>
              ) : null}
            </Space>
            {!published ? (
              <Button
                type="text"
                danger
                icon={<DeleteOutlined />}
                onClick={() => removeItem(index)}
              />
            ) : null}
          </Space>
        </Card>
      ))}
      {!published ? (
        <Button type="dashed" icon={<PlusOutlined />} onClick={addItem}>
          {t("incidentReports.checklist.addItem")}
        </Button>
      ) : null}
    </Space>
  );
}
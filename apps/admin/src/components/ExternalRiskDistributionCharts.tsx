import { Col, Row, Typography } from "antd";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ExternalRiskDistributions } from "../api/external-risk";
import { severityTag } from "../utils/external-risk-display";

type BarItem = { label: string; value: number; color: string };

function DistributionBarChart({ title, items }: { title: string; items: BarItem[] }) {
  const max = Math.max(1, ...items.map((item) => item.value));

  return (
    <div>
      <Typography.Text strong style={{ display: "block", marginBottom: 12 }}>
        {title}
      </Typography.Text>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {items.map((item) => (
          <div key={item.label}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 4,
                fontSize: 12,
              }}
            >
              <span>{item.label}</span>
              <span>{item.value}</span>
            </div>
            <div
              style={{
                height: 8,
                borderRadius: 4,
                background: "#f0f0f0",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${(item.value / max) * 100}%`,
                  height: "100%",
                  background: item.color,
                  borderRadius: 4,
                  minWidth: item.value > 0 ? 8 : 0,
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

type ExternalRiskDistributionChartsProps = {
  data: ExternalRiskDistributions | undefined;
};

export function ExternalRiskDistributionCharts({ data }: ExternalRiskDistributionChartsProps) {
  const { t } = useTranslation();

  const severityItems = useMemo<BarItem[]>(
    () => [
      { label: "P1", value: data?.severity.P1 ?? 0, color: "#ff4d4f" },
      { label: "P2", value: data?.severity.P2 ?? 0, color: "#fa8c16" },
      { label: "P3", value: data?.severity.P3 ?? 0, color: "#8c8c8c" },
    ],
    [data],
  );

  const typeItems = useMemo<BarItem[]>(() => {
    const palette = ["#1677ff", "#13c2c2", "#722ed1", "#52c41a", "#faad14", "#eb2f96"];
    return (data?.finding_types ?? []).map((row, index) => ({
      label: row.finding_type,
      value: row.count,
      color: palette[index % palette.length],
    }));
  }, [data]);

  return (
    <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
      <Col xs={24} md={10}>
        <DistributionBarChart
          title={t("externalRisk.overview.charts.severity")}
          items={severityItems}
        />
        <div style={{ marginTop: 12 }}>
          {severityItems
            .filter((item) => item.value > 0)
            .map((item) => (
              <span key={item.label} style={{ marginRight: 8 }}>
                {severityTag(item.label)}
              </span>
            ))}
        </div>
      </Col>
      <Col xs={24} md={14}>
        <DistributionBarChart
          title={t("externalRisk.overview.charts.findingTypes")}
          items={typeItems.length > 0 ? typeItems : [{ label: "—", value: 0, color: "#d9d9d9" }]}
        />
      </Col>
    </Row>
  );
}
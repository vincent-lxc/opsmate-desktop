import { AlertOutlined, FundOutlined, InfoCircleOutlined } from "@ant-design/icons";
import { theme } from "antd";
import { Col, Progress, Row, Tooltip } from "antd";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ChartCard } from "./ChartCard";
import { Field } from "./Field";

const TOP_COL = {
  xs: 24,
  sm: 12,
  md: 12,
  lg: 12,
  xl: 6,
  style: { marginBottom: 24 },
} as const;

type IntroRowProps = {
  loading?: boolean;
  serverCount: number;
  normalCount: number;
  watchCount: number;
  anomalyCount: number;
  unknownCount: number;
  activeProblemCount: number;
  needsInterventionCount: number;
  pendingRemediationCount: number;
  runningTaskCount: number;
  patrolTaskCount: number;
};

export function OverviewIntroRow({
  loading,
  serverCount,
  normalCount,
  watchCount,
  anomalyCount,
  unknownCount,
  activeProblemCount,
  needsInterventionCount,
  pendingRemediationCount,
  runningTaskCount,
  patrolTaskCount,
}: IntroRowProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();

  const riskPercent =
    serverCount > 0
      ? Math.round(((anomalyCount + watchCount) / serverCount) * 100)
      : 0;

  const tip = (
    <Tooltip title={t("dashboard.overview.chart.tip")}>
      <InfoCircleOutlined />
    </Tooltip>
  );

  return (
    <Row gutter={24}>
      <Col {...TOP_COL}>
        <ChartCard
          variant="borderless"
          loading={loading}
          title={t("dashboard.overview.kpi.servers")}
          action={tip}
          total={serverCount}
          footer={
            <Field
              label={t("dashboard.overview.chart.normalServers")}
              value={
                <Link to="/monitoring/patrol-records?verdict=normal">{normalCount}</Link>
              }
            />
          }
        >
          <Progress
            percent={serverCount > 0 ? Math.round((normalCount / serverCount) * 100) : 0}
            strokeColor={{ from: "#108ee9", to: "#87d068" }}
            showInfo={false}
            size="small"
          />
        </ChartCard>
      </Col>

      <Col {...TOP_COL}>
        <ChartCard
          variant="borderless"
          loading={loading}
          title={t("dashboard.overview.kpi.activeProblems")}
          action={tip}
          total={
            <span style={{ color: activeProblemCount > 0 ? "#cf1322" : undefined }}>
              {activeProblemCount}
            </span>
          }
          footer={
            <Field
              label={t("dashboard.overview.needsIntervention")}
              value={
                <Link to="/problems">
                  {needsInterventionCount}
                </Link>
              }
            />
          }
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, height: 46 }}>
            <AlertOutlined style={{ fontSize: 28, color: "#ff4d4f", opacity: 0.85 }} />
            <span style={{ color: token.colorTextSecondary, fontSize: 13 }}>
              {t("dashboard.overview.chart.problemsHint")}
            </span>
          </div>
        </ChartCard>
      </Col>

      <Col {...TOP_COL}>
        <ChartCard
          variant="borderless"
          loading={loading}
          title={t("dashboard.overview.kpi.pendingRemediation")}
          action={tip}
          total={
            <Link
              to="/oncall/remediation-queue"
              style={{
                color: pendingRemediationCount > 0 ? "#d48806" : undefined,
              }}
            >
              {pendingRemediationCount}
            </Link>
          }
          footer={
            <Field
              label={t("dashboard.overview.viewAll")}
              value={<Link to="/oncall/remediation-queue">{t("menu.remediationQueue")}</Link>}
            />
          }
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, height: 46 }}>
            <AlertOutlined style={{ fontSize: 28, color: "#fa8c16", opacity: 0.85 }} />
          </div>
        </ChartCard>
      </Col>

      <Col {...TOP_COL}>
        <ChartCard
          variant="borderless"
          loading={loading}
          title={t("dashboard.overview.kpi.runningTasks")}
          action={tip}
          total={
            <>
              {runningTaskCount}
              <span style={{ fontSize: 16, color: "rgba(0,0,0,0.45)", marginLeft: 4 }}>
                / {patrolTaskCount}
              </span>
            </>
          }
          footer={
            <Field
              label={t("dashboard.overview.chart.taskLink")}
              value={<Link to="/monitoring/tasks">{t("dashboard.overview.viewAll")}</Link>}
            />
          }
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, height: 46 }}>
            <FundOutlined style={{ fontSize: 28, color: "#1677ff", opacity: 0.85 }} />
          </div>
        </ChartCard>
      </Col>

      <Col {...TOP_COL}>
        <ChartCard
          variant="borderless"
          loading={loading}
          title={t("dashboard.overview.chart.anomalyServers")}
          action={tip}
          total={anomalyCount}
          footer={
            <Field
              label={t("dashboard.overview.chart.watchUnknown")}
              value={`${watchCount} / ${unknownCount}`}
            />
          }
          contentHeight={46}
        >
          <Progress
            percent={riskPercent}
            strokeColor={{ from: "#ffccc7", to: "#ff4d4f" }}
            status={anomalyCount > 0 ? "active" : "normal"}
            size="small"
          />
        </ChartCard>
      </Col>
    </Row>
  );
}
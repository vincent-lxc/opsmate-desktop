import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  App,
  Button,
  Card,
  Col,
  Row,
  Select,
  Space,
  Switch,
  Typography,
  Spin,
} from "antd";
import { ArrowDownOutlined, ArrowUpOutlined } from "@ant-design/icons";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  platformAiApi,
  type AgentKind,
  type PlatformAgent,
  type PlatformSkill,
} from "../../../api/platform-ai";

const KIND_ORDER: AgentKind[] = ["ops", "security"];

export default function AgentsPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [savingSkill, setSavingSkill] = useState<string | null>(null);

  const agentsQ = useQuery({
    queryKey: ["platform-ai-agents"],
    queryFn: () => platformAiApi.listAgents(),
  });
  const providersQ = useQuery({
    queryKey: ["platform-ai-providers"],
    queryFn: () => platformAiApi.listProviders(),
  });
  const skillsQ = useQuery({
    queryKey: ["platform-ai-skills"],
    queryFn: () => platformAiApi.listSkills(),
  });

  const skillById = useMemo(() => {
    const map = new Map<string, PlatformSkill>();
    for (const s of skillsQ.data?.items ?? []) map.set(s.id, s);
    return map;
  }, [skillsQ.data]);

  const agentsByKind = useMemo(() => {
    const map = new Map<AgentKind, PlatformAgent>();
    for (const a of agentsQ.data?.items ?? []) {
      if (!map.has(a.kind) || a.is_enabled) map.set(a.kind, a);
    }
    return map;
  }, [agentsQ.data]);

  const patchMutation = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: Record<string, unknown>;
    }) => platformAiApi.updateAgent(id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["platform-ai-agents"] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const moveSkill = async (
    agent: PlatformAgent,
    index: number,
    dir: -1 | 1,
  ) => {
    const next = [...agent.skill_ids];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    const key = `${agent.id}:${index}`;
    setSavingSkill(key);
    [next[index], next[j]] = [next[j]!, next[index]!];
    try {
      await platformAiApi.updateAgent(agent.id, { skill_ids: next });
      void qc.invalidateQueries({ queryKey: ["platform-ai-agents"] });
    } catch (e) {
      message.error(e instanceof Error ? e.message : t("aiAgents.reorderFailed"));
    } finally {
      setSavingSkill(null);
    }
  };

  if (agentsQ.isLoading) return <Spin />;

  return (
    <div>
      <Typography.Title level={4}>{t("aiAgents.title")}</Typography.Title>
      <Typography.Paragraph type="secondary">
        {t("aiAgents.subtitle")}
      </Typography.Paragraph>

      <Row gutter={[16, 16]}>
        {KIND_ORDER.map((kind) => {
          const agent = agentsByKind.get(kind);
          if (!agent) {
            return (
              <Col span={12} key={kind}>
                <Card title={kindLabel(kind, t)}>
                  <Typography.Text type="secondary">
                    {t("aiAgents.noAgent")}
                  </Typography.Text>
                </Card>
              </Col>
            );
          }

          const compatibleSkills = (skillsQ.data?.items ?? []).filter((s) =>
            s.compatible_kinds.includes(kind),
          );

          return (
            <Col span={12} key={kind}>
              <Card
                title={
                  <Space>
                    <span>{agent.name}</span>
                    <TagKind kind={kind} />
                  </Space>
                }
                extra={
                  <Switch
                    checked={agent.is_enabled}
                    onChange={(is_enabled) =>
                      patchMutation.mutate({
                        id: agent.id,
                        body: { is_enabled },
                      })
                    }
                  />
                }
              >
                <Typography.Text type="secondary">{t("aiAgents.provider")}</Typography.Text>
                <Select
                  style={{ width: "100%", marginBottom: 12 }}
                  value={agent.provider_id}
                  options={(providersQ.data?.items ?? []).map((p) => ({
                    value: p.id,
                    label: `${p.name} (${p.model})`,
                  }))}
                  onChange={(provider_id) =>
                    patchMutation.mutate({
                      id: agent.id,
                      body: { provider_id },
                    })
                  }
                />

                <Typography.Text type="secondary">{t("aiAgents.skills")}</Typography.Text>
                <Select
                  mode="multiple"
                  style={{ width: "100%", marginBottom: 8 }}
                  value={agent.skill_ids}
                  options={compatibleSkills.map((s) => ({
                    value: s.id,
                    label: s.name,
                  }))}
                  onChange={(skill_ids) =>
                    patchMutation.mutate({
                      id: agent.id,
                      body: { skill_ids },
                    })
                  }
                />

                <div>
                  {agent.skill_ids.map((sid, index) => {
                    const sk = skillById.get(sid);
                    const busy = savingSkill === `${agent.id}:${index}`;
                    return (
                      <Space
                        key={sid}
                        style={{ display: "flex", marginBottom: 4 }}
                      >
                        <Typography.Text>
                          {index + 1}. {sk?.name ?? sid}
                        </Typography.Text>
                        <Button
                          size="small"
                          icon={<ArrowUpOutlined />}
                          disabled={index === 0 || busy}
                          onClick={() => void moveSkill(agent, index, -1)}
                        />
                        <Button
                          size="small"
                          icon={<ArrowDownOutlined />}
                          disabled={
                            index === agent.skill_ids.length - 1 || busy
                          }
                          onClick={() => void moveSkill(agent, index, 1)}
                        />
                        {busy && <Spin size="small" />}
                      </Space>
                    );
                  })}
                </div>
              </Card>
            </Col>
          );
        })}
      </Row>
    </div>
  );
}

function kindLabel(kind: AgentKind, t: (key: string) => string): string {
  return kind === "ops" ? t("aiAgents.kindOps") : t("aiAgents.kindSecurity");
}

function TagKind({ kind }: { kind: AgentKind }) {
  const color = kind === "ops" ? "green" : "purple";
  return (
    <Typography.Text type="secondary" style={{ color }}>
      {kind}
    </Typography.Text>
  );
}

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Checkbox, Col, Row, Space, Spin, Switch, Typography, message } from "antd";
import {
  fetchFreeAccessProfile,
  syncFreeTelegramMenu,
  updateFreeAccessProfile,
} from "../../services/access-profiles";
import type { FeatureKey } from "../../services/entitlements";

const MENU_OPTIONS = [
  ["/dashboard/overview", "运行概览"],
  ["/servers", "服务器"],
  ["/monitoring/foundation", "基础组件"],
  ["/monitoring/applications", "应用监控"],
  ["/monitoring/dependency-manifests", "依赖清单"],
  ["/monitoring/tasks", "巡检任务"],
  ["/monitoring/patrol-records", "巡检记录"],
  ["/problems", "问题中心"],
  ["/timeline", "事件时间线"],
  ["/security/credentials", "SSH 凭据"],
  ["/account", "个人账户"],
] as const;

const FEATURE_OPTIONS: Array<[FeatureKey, string]> = [
  ["monitoring_projects", "服务器与监控项目"],
  ["monitoring_center", "监控中心"],
  ["foundation", "基础组件"],
  ["applications", "应用监控"],
  ["dependency_manifests", "依赖清单"],
  ["patrol", "巡检"],
  ["basic_problem", "问题中心"],
  ["event_center", "事件中心"],
  ["basic_ai_diagnosis", "基础 AI 诊断"],
  ["telegram", "Telegram 机器人"],
  ["encrypted_credentials", "加密 SSH 凭据"],
];

export default function FreeAccessProfilePage() {
  const queryClient = useQueryClient();
  const profile = useQuery({
    queryKey: ["platform", "access-profile", "free"],
    queryFn: fetchFreeAccessProfile,
  });
  const [menuPaths, setMenuPaths] = useState<string[]>([]);
  const [features, setFeatures] = useState<Partial<Record<FeatureKey, boolean>>>({});

  useEffect(() => {
    if (!profile.data) return;
    setMenuPaths(profile.data.menu_paths);
    setFeatures(profile.data.features);
  }, [profile.data]);

  const save = useMutation({
    mutationFn: () => updateFreeAccessProfile({ menu_paths: menuPaths, features }),
    onSuccess: async (result) => {
      if (result.telegram_sync.ok) {
        message.success("Free 角色权限和 Telegram 菜单已保存");
      } else {
        message.warning("Free 权限已保存，但 Telegram 菜单同步失败，请重试");
      }
      await queryClient.invalidateQueries({ queryKey: ["platform", "access-profile", "free"] });
    },
    onError: (error: Error) => message.error(error.message || "保存失败"),
  });
  const retryTelegram = useMutation({
    mutationFn: syncFreeTelegramMenu,
    onSuccess: (result) => {
      if (result.ok) message.success("Telegram 菜单已同步");
      else message.warning(result.detail || result.message || "Telegram 菜单同步失败");
    },
    onError: (error: Error) => message.error(error.message || "Telegram 菜单同步失败"),
  });

  if (profile.isLoading) return <Spin />;
  if (profile.isError || !profile.data) {
    return <Alert type="error" showIcon message="无法读取 Free 角色权限" />;
  }

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <div>
        <Typography.Title level={2} style={{ marginBottom: 4 }}>Free 角色与菜单</Typography.Title>
        <Typography.Text type="secondary">
          外部用户首次登录后默认绑定 Free 角色。这里的配置同时约束左侧菜单和后端 API；企业版能力不会在此开放。
        </Typography.Text>
      </div>
      <Alert
        type="info"
        showIcon
        message="额度耗尽只停止 AI 调用，不影响服务器、巡检、通知或 SSH。"
      />
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <Card title="可见菜单">
            <Checkbox.Group
              value={menuPaths}
              onChange={(values) => setMenuPaths(values.map(String))}
              style={{ display: "grid", gap: 12 }}
            >
              {MENU_OPTIONS.map(([value, label]) => (
                <Checkbox key={value} value={value}>{label}</Checkbox>
              ))}
            </Checkbox.Group>
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title="成熟功能开关">
            <Space direction="vertical" size={14} style={{ width: "100%" }}>
              {FEATURE_OPTIONS.map(([key, label]) => (
                <Space key={key} style={{ justifyContent: "space-between", width: "100%" }}>
                  <Typography.Text>{label}</Typography.Text>
                  <Switch
                    checked={features[key] === true}
                    onChange={(checked) => setFeatures((current) => ({ ...current, [key]: checked }))}
                  />
                </Space>
              ))}
            </Space>
          </Card>
        </Col>
      </Row>
      <Space wrap>
        <Button type="primary" loading={save.isPending} onClick={() => save.mutate()}>
          保存 Free 权限
        </Button>
        <Button loading={retryTelegram.isPending} onClick={() => retryTelegram.mutate()}>
          重试 Telegram 菜单同步
        </Button>
      </Space>
    </Space>
  );
}

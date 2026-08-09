import { MoonOutlined, SunOutlined } from "@ant-design/icons";
import { Tooltip } from "antd";
import { useTranslation } from "react-i18next";
import { useAppSettings } from "../providers/AppProvider";

export function ThemeToggle() {
  const { t } = useTranslation();
  const { isDark, setIsDark } = useAppSettings();

  return (
    <Tooltip title={isDark ? t("theme.light") : t("theme.dark")}>
      <span
        onClick={() => setIsDark(!isDark)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          padding: "0 12px",
          cursor: "pointer",
          height: 48,
        }}
      >
        {isDark ? (
          <SunOutlined style={{ fontSize: 16 }} />
        ) : (
          <MoonOutlined style={{ fontSize: 16 }} />
        )}
      </span>
    </Tooltip>
  );
}
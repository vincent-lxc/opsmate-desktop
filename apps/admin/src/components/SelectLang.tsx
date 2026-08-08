import { GlobalOutlined } from "@ant-design/icons";
import { Dropdown } from "antd";
import type { MenuProps } from "antd";
import { useTranslation } from "react-i18next";
import { useAppSettings } from "../providers/AppProvider";
import type { AppLocale } from "../i18n";

const locales: { key: AppLocale; labelKey: string }[] = [
  { key: "zh-CN", labelKey: "lang.zh" },
  { key: "en-US", labelKey: "lang.en" },
];

export function SelectLang() {
  const { t } = useTranslation();
  const { locale, setLocale } = useAppSettings();

  const items: MenuProps["items"] = locales.map(({ key, labelKey }) => ({
    key,
    label: t(labelKey),
    onClick: () => setLocale(key),
  }));

  return (
    <Dropdown menu={{ items, selectedKeys: [locale] }} placement="bottomRight">
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          padding: "0 12px",
          cursor: "pointer",
          height: 48,
        }}
      >
        <GlobalOutlined style={{ fontSize: 16 }} />
      </span>
    </Dropdown>
  );
}
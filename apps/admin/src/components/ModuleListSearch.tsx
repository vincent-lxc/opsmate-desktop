import { Input } from "antd";
import { useTranslation } from "react-i18next";

export type ModuleListSearchProps = {
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onSearch: (value: string) => void;
};

/** Top-of-page search bar — matches ServerManagement layout. */
export function ModuleListSearch({ placeholder, value, onChange, onSearch }: ModuleListSearchProps) {
  const { t } = useTranslation();

  return (
    <Input.Search
      placeholder={placeholder}
      allowClear
      enterButton={t("common.search")}
      value={value}
      onChange={(event) => {
        const next = event.target.value;
        onChange(next);
        if (next === "") {
          onSearch("");
        }
      }}
      onSearch={(term) => {
        onChange(term);
        onSearch(term.trim());
      }}
      style={{ maxWidth: 400, marginBottom: 16 }}
    />
  );
}
import { Button, Popconfirm } from "antd";
import type { ButtonProps } from "antd";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

export type ConfirmDeleteButtonProps = {
  onConfirm: () => void;
  title?: string;
  loading?: boolean;
  children?: ReactNode;
} & Pick<ButtonProps, "type" | "size" | "icon" | "style" | "className">;

/** Delete button that always requires user confirmation before executing. */
export function ConfirmDeleteButton({
  onConfirm,
  title,
  loading,
  children,
  type = "link",
  size = "small",
  ...rest
}: ConfirmDeleteButtonProps) {
  const { t } = useTranslation();

  return (
    <Popconfirm title={title ?? t("common.deleteConfirm")} onConfirm={onConfirm}>
      <Button type={type} size={size} danger loading={loading} {...rest}>
        {children ?? t("common.delete")}
      </Button>
    </Popconfirm>
  );
}
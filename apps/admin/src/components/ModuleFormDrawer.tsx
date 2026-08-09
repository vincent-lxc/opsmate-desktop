import { Drawer } from "antd";
import type { ReactNode } from "react";

export type ModuleFormDrawerProps = {
  title: ReactNode;
  open: boolean;
  onClose: () => void;
  width?: number;
  destroyOnClose?: boolean;
  children: ReactNode;
};

export function ModuleFormDrawer({
  title,
  open,
  onClose,
  width = 560,
  destroyOnClose = true,
  children,
}: ModuleFormDrawerProps) {
  return (
    <Drawer
      title={title}
      open={open}
      onClose={onClose}
      width={width}
      destroyOnClose={destroyOnClose}
    >
      {children}
    </Drawer>
  );
}
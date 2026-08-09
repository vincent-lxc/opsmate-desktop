import {
  ProForm,
  ProFormDateTimePicker,
  ProFormText,
  ProFormTextArea,
} from "@ant-design/pro-components";
import { CalendarOutlined, PlusOutlined, UserOutlined } from "@ant-design/icons";
import { App, Button, Calendar, Popconfirm, Space, Tag, Typography } from "antd";
import type { Dayjs } from "dayjs";
import dayjs from "dayjs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import { ModuleFormDrawer } from "../../components/ModuleFormDrawer";
import { ModulePageShell } from "../../components/ModulePageShell";
import { ModuleTableCard } from "../../components/ModuleTableCard";
import { formatDateTimeRange } from "../../utils/datetime";

type DutyShift = {
  id: string;
  starts_at: string;
  ends_at: string;
  assignee: string;
  backup_assignee: string | null;
  notes: string | null;
};

function monthRange(value: Dayjs): { from: string; to: string } {
  const start = value.startOf("month");
  const end = value.endOf("month");
  return { from: start.toISOString(), to: end.toISOString() };
}

function shiftOverlapsDay(shift: DutyShift, day: Dayjs): boolean {
  const dayStart = day.startOf("day");
  const dayEnd = day.endOf("day");
  const starts = dayjs(shift.starts_at);
  const ends = dayjs(shift.ends_at);
  return starts.isBefore(dayEnd) && ends.isAfter(dayStart);
}

function formatShiftTimeRange(shift: DutyShift): string {
  return formatDateTimeRange(shift.starts_at, shift.ends_at);
}

function defaultDayShiftRange(day: Dayjs): { starts_at: string; ends_at: string } {
  return {
    starts_at: day.startOf("day").hour(9).minute(0).second(0).millisecond(0).toISOString(),
    ends_at: day.add(1, "day").startOf("day").hour(9).minute(0).second(0).millisecond(0).toISOString(),
  };
}

export function OpsDutyCalendarPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [viewMonth, setViewMonth] = useState(() => dayjs());
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<DutyShift | null>(null);
  const [selectedDay, setSelectedDay] = useState<Dayjs | null>(null);

  const range = useMemo(() => monthRange(viewMonth), [viewMonth]);

  const { data } = useQuery({
    queryKey: ["ops-duty-shifts", range.from, range.to],
    queryFn: () =>
      api<{ items: DutyShift[] }>(
        `/api/ops-duty/shifts?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      ),
  });

  const shifts = data?.items ?? [];

  const { data: currentShift } = useQuery({
    queryKey: ["ops-duty-shift-resolve", "now"],
    queryFn: () =>
      api<{ shift: DutyShift | null }>(
        `/api/ops-duty/shifts/resolve?at=${encodeURIComponent(new Date().toISOString())}`,
      ),
    refetchInterval: 60_000,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["ops-duty-shifts"] });
    void queryClient.invalidateQueries({ queryKey: ["ops-duty-shift-resolve"] });
  };

  const saveMutation = useMutation({
    mutationFn: async ({
      id,
      values,
    }: {
      id?: string;
      values: Record<string, unknown>;
    }) => {
      const payload = {
        assignee: values.assignee,
        backup_assignee: values.backup_assignee || null,
        notes: values.notes || null,
        starts_at: new Date(String(values.starts_at)).toISOString(),
        ends_at: new Date(String(values.ends_at)).toISOString(),
      };
      if (id) {
        return api(`/api/ops-duty/shifts/${id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      }
      return api("/api/ops-duty/shifts", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      message.success(t("opsDuty.calendar.saved"));
      setFormOpen(false);
      setEditing(null);
      setSelectedDay(null);
      refresh();
    },
    onError: () => message.error(t("common.error")),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/api/ops-duty/shifts/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      message.success(t("opsDuty.calendar.deleted"));
      refresh();
    },
    onError: () => message.error(t("common.error")),
  });

  const openCreate = (day?: Dayjs) => {
    setEditing(null);
    setSelectedDay(day ?? viewMonth);
    setFormOpen(true);
  };

  const openEdit = (shift: DutyShift) => {
    setEditing(shift);
    setSelectedDay(dayjs(shift.starts_at));
    setFormOpen(true);
  };

  const formInitialValues = editing
    ? {
        assignee: editing.assignee,
        backup_assignee: editing.backup_assignee ?? undefined,
        notes: editing.notes ?? undefined,
        starts_at: editing.starts_at,
        ends_at: editing.ends_at,
      }
    : selectedDay
      ? {
          ...defaultDayShiftRange(selectedDay),
          assignee: "",
          backup_assignee: undefined,
          notes: undefined,
        }
      : undefined;

  const cellRender = (current: Dayjs, info: { type: string }) => {
    if (info.type !== "date") return null;
    const dayShifts = shifts.filter((shift) => shiftOverlapsDay(shift, current));
    if (dayShifts.length === 0) return null;

    return (
      <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
        {dayShifts.map((shift) => (
          <li key={shift.id} style={{ marginBottom: 2 }}>
            <Tag
              color="blue"
              style={{ margin: 0, cursor: "pointer", maxWidth: "100%" }}
              onClick={(event) => {
                event.stopPropagation();
                openEdit(shift);
              }}
            >
              <span style={{ fontWeight: 500 }}>{shift.assignee}</span>
              <span style={{ opacity: 0.75, marginLeft: 4, fontSize: 11 }}>
                {formatShiftTimeRange(shift)}
              </span>
            </Tag>
          </li>
        ))}
      </ul>
    );
  };

  return (
    <ModulePageShell
      icon={<CalendarOutlined style={{ fontSize: 20 }} />}
      title={t("opsDuty.calendar.title")}
      subtitle={t("opsDuty.calendar.subtitle")}
      action={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate()}>
          {t("opsDuty.calendar.addShift")}
        </Button>
      }
    >
      <div style={{ marginBottom: 16 }}>
        <Link to="/ops-duty/workbench">
          <Button type="link" style={{ padding: 0 }}>
            {t("opsDuty.calendar.openWorkbench")}
          </Button>
        </Link>
      </div>

      {currentShift?.shift ? (
        <div
          style={{
            marginBottom: 16,
            padding: "12px 16px",
            border: "1px solid var(--ant-color-border)",
            borderRadius: 8,
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            alignItems: "center",
          }}
        >
          <Typography.Text strong>
            <UserOutlined style={{ marginRight: 6 }} />
            {t("opsDuty.calendar.currentOnCall")}
          </Typography.Text>
          <Tag color="green">{currentShift.shift.assignee}</Tag>
          {currentShift.shift.backup_assignee ? (
            <>
              <Typography.Text type="secondary">{t("opsDuty.calendar.backup")}</Typography.Text>
              <Tag>{currentShift.shift.backup_assignee}</Tag>
            </>
          ) : null}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {formatShiftTimeRange(currentShift.shift)}
          </Typography.Text>
        </div>
      ) : (
        <Typography.Text type="secondary" style={{ display: "block", marginBottom: 16 }}>
          {t("opsDuty.calendar.noCurrentOnCall")}
        </Typography.Text>
      )}

      <ModuleTableCard>
        <div style={{ padding: "8px 16px 16px" }}>
          <Calendar
            value={viewMonth}
            onPanelChange={(value) => setViewMonth(value)}
            onSelect={(value) => openCreate(value)}
            cellRender={cellRender}
          />
        </div>
      </ModuleTableCard>

      <ModuleFormDrawer
        title={editing ? t("opsDuty.calendar.editShift") : t("opsDuty.calendar.addShift")}
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
          setSelectedDay(null);
        }}
        width={520}
      >
        <ProForm
          key={editing?.id ?? selectedDay?.toISOString() ?? "new"}
          initialValues={formInitialValues}
          submitter={{
            render: (_, dom) => (
              <Space style={{ width: "100%", justifyContent: "flex-end" }}>
                {editing ? (
                  <Popconfirm
                    title={t("opsDuty.calendar.deleteConfirm")}
                    onConfirm={async () => {
                      await deleteMutation.mutateAsync(editing.id);
                      setFormOpen(false);
                      setEditing(null);
                    }}
                  >
                    <Button danger loading={deleteMutation.isPending}>
                      {t("common.delete")}
                    </Button>
                  </Popconfirm>
                ) : null}
                {dom}
              </Space>
            ),
            searchConfig: { submitText: t("common.save") },
          }}
          onFinish={async (values) => {
            await saveMutation.mutateAsync({ id: editing?.id, values });
            return true;
          }}
        >
          <ProFormText
            name="assignee"
            label={t("opsDuty.calendar.form.assignee")}
            rules={[{ required: true }]}
            placeholder={t("opsDuty.calendar.form.assigneePlaceholder")}
          />
          <ProFormText
            name="backup_assignee"
            label={t("opsDuty.calendar.form.backupAssignee")}
            placeholder={t("opsDuty.calendar.form.backupPlaceholder")}
          />
          <ProFormDateTimePicker
            name="starts_at"
            label={t("opsDuty.calendar.form.startsAt")}
            rules={[{ required: true }]}
            fieldProps={{ style: { width: "100%" } }}
          />
          <ProFormDateTimePicker
            name="ends_at"
            label={t("opsDuty.calendar.form.endsAt")}
            rules={[{ required: true }]}
            fieldProps={{ style: { width: "100%" } }}
          />
          <ProFormTextArea
            name="notes"
            label={t("opsDuty.calendar.form.notes")}
            fieldProps={{ rows: 2 }}
          />
        </ProForm>
      </ModuleFormDrawer>
    </ModulePageShell>
  );
}
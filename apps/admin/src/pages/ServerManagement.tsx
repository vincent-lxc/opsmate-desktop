import { api } from "../api/client";
import { getServerSaveErrorMessage } from "../utils/server-api-errors";
import { Button, Col, Collapse, Empty, Input, Pagination, Row, Spin, Typography, message } from "antd";
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudServerOutlined, PlusOutlined } from "@ant-design/icons";
import { ServerCard } from "../components/ServerCard";
// Lazy-load the terminal modal so the xterm bundle (~326 KB) is only fetched
// when the user actually opens a terminal, not on every visit to /servers.
const ServerTerminalModal = lazy(() =>
  import("../components/ServerTerminalModal").then((m) => ({ default: m.ServerTerminalModal })),
);
import {
  ServerFormDrawer,
  type ServerFormValues,
  type ServerRecord,
} from "../components/ServerFormDrawer";
import { ModulePageShell } from "../components/ModulePageShell";
import { ServerDiscoveryWizard } from "../components/ServerDiscoveryWizard";
import {
  DEFAULT_SERVER_GROUP,
  formatGroupLabel,
  sortServerGroupSummaries,
} from "../utils/server-groups";
import { buildServerPayload } from "../utils/server-form-payload";
import { canWrite } from "../services/auth/roles";

const SERVER_LIST_PAGE_SIZE = 12;
const SERVER_LIST_SORT = "-created_at";
const SEARCH_RESULTS_KEY = "__search_results__";

type ServerListHandlers = {
  groupsForCards: string[];
  canWrite: boolean;
  onEdit: (server: ServerRecord) => void;
  onDelete: (server: ServerRecord) => void;
  onOpenDetail: (server: ServerRecord) => void;
  onOpenTerminal: (server: ServerRecord) => void;
  onChangeGroup: (server: ServerRecord, groupName: string) => void;
};

function buildServersQueryParams({
  groupName,
  searchTerm,
  page,
}: {
  groupName?: string;
  searchTerm?: string;
  page: number;
}) {
  const params = new URLSearchParams({
    page: String(page),
    page_size: String(SERVER_LIST_PAGE_SIZE),
    sort: SERVER_LIST_SORT,
  });
  if (groupName) {
    params.set("group_name", groupName);
  }
  if (searchTerm) {
    params.set("q", searchTerm);
  }
  return params;
}

function ServerCardGrid({
  items,
  total,
  page,
  isLoading,
  emptyText,
  onPageChange,
  handlers,
}: {
  items: ServerRecord[];
  total: number;
  page: number;
  isLoading: boolean;
  emptyText: string;
  onPageChange: (page: number) => void;
  handlers: ServerListHandlers;
}) {
  const showPagination = total > SERVER_LIST_PAGE_SIZE;

  return (
    <Spin spinning={isLoading}>
      <Row gutter={[16, 16]}>
        {items.map((server) => (
          <Col key={server.id} xs={24} sm={12} lg={8} xl={6}>
            <ServerCard
              server={server}
              groups={handlers.groupsForCards}
              canWrite={handlers.canWrite}
              onEdit={handlers.onEdit}
              onDelete={handlers.onDelete}
              onOpenDetail={handlers.onOpenDetail}
              onOpenTerminal={handlers.onOpenTerminal}
              onChangeGroup={handlers.onChangeGroup}
            />
          </Col>
        ))}
      </Row>
      {showPagination && (
        <div
          style={{
            marginTop: 16,
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <Pagination
            size="small"
            current={page}
            pageSize={SERVER_LIST_PAGE_SIZE}
            total={total}
            onChange={onPageChange}
            showSizeChanger={false}
          />
        </div>
      )}
      {items.length === 0 && !isLoading && (
        <Typography.Text type="secondary">{emptyText}</Typography.Text>
      )}
    </Spin>
  );
}

function GroupServerList({
  groupName,
  page,
  onPageChange,
  handlers,
}: {
  groupName: string;
  page: number;
  onPageChange: (page: number) => void;
  handlers: ServerListHandlers;
}) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ["servers", "by-group", groupName, page, SERVER_LIST_SORT],
    queryFn: () =>
      api<{ items: ServerRecord[]; total: number }>(
        `/api/servers?${buildServersQueryParams({ groupName, page }).toString()}`,
      ),
  });

  return (
    <ServerCardGrid
      items={data?.items ?? []}
      total={data?.total ?? 0}
      page={page}
      isLoading={isLoading}
      emptyText={t("servers.empty")}
      onPageChange={onPageChange}
      handlers={handlers}
    />
  );
}

function SearchServerList({
  searchTerm,
  page,
  onPageChange,
  handlers,
}: {
  searchTerm: string;
  page: number;
  onPageChange: (page: number) => void;
  handlers: ServerListHandlers;
}) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ["servers", "search", searchTerm, page, SERVER_LIST_SORT],
    queryFn: () =>
      api<{ items: ServerRecord[]; total: number }>(
        `/api/servers?${buildServersQueryParams({ searchTerm, page }).toString()}`,
      ),
    enabled: searchTerm.length > 0,
  });

  return (
    <ServerCardGrid
      items={data?.items ?? []}
      total={data?.total ?? 0}
      page={page}
      isLoading={isLoading}
      emptyText={t("servers.search.noResults")}
      onPageChange={onPageChange}
      handlers={handlers}
    />
  );
}

function SearchResultsLabel({ searchTerm, page }: { searchTerm: string; page: number }) {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ["servers", "search", searchTerm, page, SERVER_LIST_SORT],
    queryFn: () =>
      api<{ items: ServerRecord[]; total: number }>(
        `/api/servers?${buildServersQueryParams({ searchTerm, page }).toString()}`,
      ),
    enabled: searchTerm.length > 0,
    select: (result) => result.total,
  });

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        paddingRight: 8,
      }}
    >
      <Typography.Title level={5} style={{ margin: 0 }}>
        {t("servers.search.resultsGroup")}
      </Typography.Title>
      <Typography.Text type="secondary">
        {t("servers.groupCount", { count: data ?? 0 })}
      </Typography.Text>
    </div>
  );
}

export function ServerManagement() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const writable = canWrite();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<ServerRecord | null>(null);
  const [terminalServer, setTerminalServer] = useState<ServerRecord | null>(null);
  const [wizardServer, setWizardServer] = useState<ServerRecord | null>(null);

  const [groupPages, setGroupPages] = useState<Record<string, number>>({});
  const [activeKeys, setActiveKeys] = useState<string[]>([]);
  const [searchInput, setSearchInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");

  const isSearching = searchTerm.length > 0;

  useEffect(() => {
    setGroupPages((prev) => {
      if (searchTerm) {
        return { ...prev, [SEARCH_RESULTS_KEY]: 1 };
      }
      const next = { ...prev };
      delete next[SEARCH_RESULTS_KEY];
      return next;
    });
  }, [searchTerm]);

  const { data: groupsData, isLoading } = useQuery({
    queryKey: ["server-groups"],
    queryFn: () => api<{ items: { name: string; count: number }[] }>("/api/servers/groups"),
  });

  const groupList = useMemo(
    () => sortServerGroupSummaries(groupsData?.items ?? []),
    [groupsData?.items],
  );

  useEffect(() => {
    if (isSearching) {
      setActiveKeys([SEARCH_RESULTS_KEY]);
      return;
    }
    if (groupList.length > 0) {
      setActiveKeys(groupList.map((group) => group.name));
    }
  }, [groupList, isSearching]);

  const groupNamesForForms = useMemo(
    () => groupList.map((group) => group.name),
    [groupList],
  );

  const refreshServers = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["server-groups"] });
    void queryClient.invalidateQueries({ queryKey: ["servers"] });
  }, [queryClient]);

  const openCreateDrawer = useCallback(() => {
    if (!writable) return;
    setEditingServer(null);
    setDrawerOpen(true);
  }, [writable]);

  const openEditDrawer = useCallback((server: ServerRecord) => {
    if (!writable) return;
    setEditingServer(server);
    setDrawerOpen(true);
  }, [writable]);

  const openTerminal = useCallback((server: ServerRecord) => {
    setTerminalServer(server);
  }, []);

  const handleChangeGroup = useCallback(
    async (server: ServerRecord, groupName: string) => {
      if (!writable) return;
      const normalized = groupName.trim() || DEFAULT_SERVER_GROUP;
      if (normalized === server.group_name) return;

      await api(`/api/servers/${server.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: server.name,
          ip: server.ip,
          group_name: normalized,
          description: server.description ?? "",
          ssh_user: server.ssh_user ?? "",
          ssh_port: server.ssh_port,
          ssh_credential_id: server.ssh_credential_id ?? null,
        }),
      });
      message.success(t("servers.groupChanged"));
      refreshServers();
    },
    [refreshServers, t, writable],
  );

  const handleDelete = useCallback(
    async (server: ServerRecord) => {
      if (!writable) return;
      await api(`/api/servers/${server.id}`, { method: "DELETE" });
      message.success(t("servers.deleted"));
      refreshServers();
    },
    [refreshServers, t, writable],
  );

  const handleSubmit = useCallback(
    async (values: ServerFormValues, { isEdit }: { isEdit: boolean }) => {
      if (!writable) return false;
      const payload = buildServerPayload(values, isEdit);

      try {
        if (editingServer) {
          await api(`/api/servers/${editingServer.id}`, {
            method: "PUT",
            body: JSON.stringify(payload),
          });
          message.success(t("servers.updated"));
        } else {
          const created = await api<ServerRecord>("/api/servers", {
            method: "POST",
            body: JSON.stringify(payload),
          });
          message.success(t("servers.added"));
          refreshServers();
          void queryClient.invalidateQueries({ queryKey: ["ssh-credentials"] });
          if (created.ssh_private_key_set) {
            setWizardServer(created);
          }
          return true;
        }
        refreshServers();
        void queryClient.invalidateQueries({ queryKey: ["ssh-credentials"] });
        return true;
      } catch (error) {
        message.error(getServerSaveErrorMessage(error, t));
        return false;
      }
    },
    [editingServer, queryClient, refreshServers, t, writable],
  );

  const getGroupPage = useCallback(
    (groupName: string) => groupPages[groupName] ?? 1,
    [groupPages],
  );

  const setGroupPage = useCallback((groupName: string, page: number) => {
    setGroupPages((prev) => ({ ...prev, [groupName]: page }));
  }, []);

  const listHandlers = useMemo<ServerListHandlers>(
    () => ({
      groupsForCards: groupNamesForForms,
      canWrite: writable,
      onEdit: openEditDrawer,
      onDelete: handleDelete,
      onOpenDetail: (server) => navigate(`/servers/${server.id}`),
      onOpenTerminal: openTerminal,
      onChangeGroup: handleChangeGroup,
    }),
    [
      groupNamesForForms,
      writable,
      openEditDrawer,
      handleDelete,
      navigate,
      openTerminal,
      handleChangeGroup,
    ],
  );

  const collapseItems = isSearching
    ? [
        {
          key: SEARCH_RESULTS_KEY,
          label: (
            <SearchResultsLabel
              searchTerm={searchTerm}
              page={getGroupPage(SEARCH_RESULTS_KEY)}
            />
          ),
          children: (
            <SearchServerList
              searchTerm={searchTerm}
              page={getGroupPage(SEARCH_RESULTS_KEY)}
              onPageChange={(page) => setGroupPage(SEARCH_RESULTS_KEY, page)}
              handlers={listHandlers}
            />
          ),
        },
      ]
    : groupList.map((group) => ({
        key: group.name,
        label: (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              paddingRight: 8,
            }}
          >
            <Typography.Title level={5} style={{ margin: 0 }}>
              {formatGroupLabel(group.name, t)}
            </Typography.Title>
            <Typography.Text type="secondary">
              {t("servers.groupCount", { count: group.count })}
            </Typography.Text>
          </div>
        ),
        children: (
          <GroupServerList
            groupName={group.name}
            page={getGroupPage(group.name)}
            onPageChange={(page) => setGroupPage(group.name, page)}
            handlers={listHandlers}
          />
        ),
      }));

  const showEmptyState = !isSearching && groupList.length === 0;

  return (
    <>
      <ModulePageShell
        icon={<CloudServerOutlined style={{ fontSize: 20 }} />}
        title={t("servers.title")}
        subtitle={t("servers.subtitle")}
        action={
          writable ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreateDrawer}>
            {t("servers.form.addServer")}
          </Button>
          ) : null
        }
      >
        <Input.Search
          placeholder={t("servers.search.placeholder")}
          allowClear
          enterButton={t("servers.search.button")}
          value={searchInput}
          onChange={(event) => {
            const value = event.target.value;
            setSearchInput(value);
            if (value === "") {
              setSearchTerm("");
            }
          }}
          onSearch={(value) => {
            const trimmed = value.trim();
            setSearchInput(value);
            setSearchTerm(trimmed);
          }}
          style={{ maxWidth: 400, marginBottom: 16 }}
        />
        <Spin spinning={isLoading && !isSearching}>
          {showEmptyState ? (
            <Empty description={t("servers.empty")}>
              {writable ? (
                <Button type="primary" onClick={openCreateDrawer}>
                  {t("servers.form.addServer")}
                </Button>
              ) : null}
            </Empty>
          ) : (
            <Collapse
              bordered
              activeKey={activeKeys}
              onChange={(keys) => {
                const next = Array.isArray(keys) ? keys : keys ? [keys] : [];
                setActiveKeys(next);
              }}
              style={{ display: "flex", flexDirection: "column", gap: 16 }}
              items={collapseItems}
            />
          )}
        </Spin>
      </ModulePageShell>
      <ServerFormDrawer
        open={drawerOpen}
        server={editingServer}
        groups={groupNamesForForms}
        onOpenChange={setDrawerOpen}
        onFinish={handleSubmit}
      />
      <Suspense
        fallback={
          <div
            style={{
              position: "fixed",
              inset: 0,
              display: "grid",
              placeItems: "center",
              background: "rgba(0, 0, 0, 0.1)",
              zIndex: 2000,
            }}
          >
            <Spin />
          </div>
        }
      >
        <ServerTerminalModal
          open={terminalServer !== null}
          server={terminalServer}
          onClose={() => setTerminalServer(null)}
        />
      </Suspense>
      <ServerDiscoveryWizard
        open={wizardServer !== null}
        server={wizardServer}
        onClose={() => {
          setWizardServer(null);
          refreshServers();
        }}
      />
    </>
  );
}
